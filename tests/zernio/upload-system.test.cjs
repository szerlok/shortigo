'use strict'
// Exercise macOS's actual curl/TLS upload against a local HTTPS test server.
// The spawn wrapper only routes the test hostname to loopback and trusts the
// test certificate. Production still pins public DNS and checks certificates.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http2 = require('node:http2')
const { spawn, execFileSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { loadMain, tempDir } = require('./support/load-main.cjs')

test('system upload streams exact bytes through TLS, handles refusal and cancels without publishing',
  { skip: process.platform !== 'darwin' }, async () => {
    const { dir, cleanup } = tempDir('shortigo-system-upload-')
    const key = path.join(dir, 'key.pem')
    const cert = path.join(dir, 'cert.pem')
    const config = path.join(dir, 'openssl.cnf')
    fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=storage.example\n[ext]\nsubjectAltName=DNS:storage.example\n')
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-config', config], { stdio: 'ignore' })
    let mode = 'ok'
    const opensslCurl = process.arch === 'arm64' && fs.existsSync('/opt/homebrew/opt/curl/bin/curl')
    const expectedCurl = opensslCurl ? '/opt/homebrew/opt/curl/bin/curl' : '/usr/bin/curl'
    let requests = 0
    const received = []
    const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: true })
    server.on('request', (req, res) => {
      requests++
      if (mode === 'refuse') { res.writeHead(403); res.end(); return }
      if (mode === 'redirect') { res.writeHead(307, { Location: 'https://storage.example/other' }); res.end(); return }
      assert.equal(req.method, 'PUT')
      assert.equal(req.url, '/clip?signature=test-secret')
      assert.equal(req.httpVersion, opensslCurl ? '1.1' : '2.0')
      assert.equal(req.headers['transfer-encoding'], undefined)
      assert.equal(req.headers.expect, undefined)
      assert.equal(req.headers.authorization, undefined)
      req.on('error', () => {})
      req.on('data', chunk => received.push(chunk))
      req.on('end', () => { res.writeHead(200); res.end() })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const children = []
    let trustCertificate = true
    const mocks = {
      electron: {},
      dns: { lookup: (_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]) },
      child_process: { spawn: (executable, args, options) => {
        assert.equal(executable, expectedCurl)
        assert.equal(args[0], '-q')
        assert.ok(!args.some(arg => arg.includes('test-secret')))
        assert.ok(!args.includes('--insecure'))
        assert.ok(!args.includes('--location'))
        assert.ok(args.includes(opensslCurl ? '--http1.1' : '--http2'))
        if (opensslCurl) assert.ok(!args.includes('--tls-max'))
        else { assert.ok(args.includes('--tls-max')); assert.ok(args.includes('1.2')) }
        assert.ok(args.includes('--ipv4'))
        assert.ok(args.includes('Expect:'))
        assert.ok(!args.includes('Expect: 100-continue'))
        assert.ok(args.includes('storage.example:443:8.8.8.8'))
        assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LANG: 'C' })
        const child = spawn(executable, [...args,
          '--connect-to', `storage.example:443:127.0.0.1:${server.address().port}`,
          ...(trustCertificate ? ['--cacert', cert] : [])], options)
        children.push(child)
        return child
      } }
    }
    // Keep exercising the legacy curl transport even though macOS now prefers
    // the Python worker. Source ownership/retry behavior still comes from putFile.
    const system = loadMain("export { sendSystemUpload, systemUploadTransport } from './src/main/zernio/posts-upload-system'", mocks)
    const upload = loadMain("export { putFile } from './src/main/zernio/posts-upload'; export { ZernioApiError } from './src/main/zernio/client'", {
      ...mocks,
      './posts-upload-python': { sendPythonUpload: async (...args) => {
        try { await system.sendSystemUpload(...args, system.systemUploadTransport(0)) }
        catch (error) {
          // The separately bundled test modules have distinct class identities.
          if (typeof error.status === 'number') throw new upload.ZernioApiError(error.message, error.status, error.code)
          throw error
        }
      } }
    })
    const file = path.join(dir, 'clip.mp4')
    const bytes = Buffer.alloc(1024 * 1024 + 33, 'original clip')
    fs.writeFileSync(file, bytes)
    const handle = await fs.promises.open(file, 'r')
    fs.renameSync(file, `${file}.original`)
    fs.writeFileSync(file, 'wrong replacement')
    const url = 'https://storage.example/clip?signature=test-secret'
    const options = { contentType: 'video/mp4', size: bytes.length, stableUpload: true }
    try {
      await upload.putFile(url, handle, options)
      assert.deepEqual(Buffer.concat(received), bytes)
      assert.equal(requests, 1)
      mode = 'refuse'
      await assert.rejects(upload.putFile(url, handle, options), error => error.status === 403)
      assert.equal(requests, 2)
      mode = 'redirect'
      await assert.rejects(upload.putFile(url, handle, options), error => error.status === 307)
      assert.equal(requests, 3, 'must not follow redirect')
      trustCertificate = false
      await assert.rejects(upload.putFile(url, handle, options), error => error.code === 'CURL_CERTIFICATE_ERROR')
      assert.equal(children.length, 4, 'certificate failure must not retry')
      trustCertificate = true
      mode = 'ok'
      const controller = new AbortController()
      const pending = upload.putFile(url, handle, { ...options, signal: controller.signal,
        onProgress: sent => { if (sent > 0) controller.abort() } })
      await assert.rejects(pending, /anulowano/)
      assert.equal(children.length, 5)
      assert.ok(children[4].exitCode !== null || children[4].signalCode !== null)
      assert.equal((await handle.stat()).size, bytes.length)
    } finally {
      children.forEach(child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
      await handle.close()
      await new Promise(resolve => server.close(resolve))
      cleanup()
    }
  })

test('system upload rejects private DNS destinations before starting curl', async () => {
  let spawns = 0
  const { sendSystemUpload } = loadMain("export { sendSystemUpload } from './src/main/zernio/posts-upload-system'", {
    electron: {},
    dns: { lookup: (_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) },
    child_process: { spawn: () => { spawns++; throw new Error('Must not spawn') } }
  })
  await assert.rejects(sendSystemUpload('https://storage.example/clip', Readable.from(['clip']),
    { contentType: 'video/mp4', size: 4 }, new AbortController().signal, 1000), /nie jest publiczny/)
  assert.equal(spawns, 0)
})

test('macOS upload retries alternate between available curl TLS implementations', () => {
  const { systemUploadTransport } = loadMain("export { systemUploadTransport } from './src/main/zernio/posts-upload-system'", { electron: {} })
  const opensslCurl = process.arch === 'arm64' && fs.existsSync('/opt/homebrew/opt/curl/bin/curl')
  assert.equal(systemUploadTransport(0), opensslCurl ? 'macos-openssl' : 'macos-system')
  assert.equal(systemUploadTransport(1), 'macos-system')
  assert.equal(systemUploadTransport(2), opensslCurl ? 'macos-openssl' : 'macos-system')
})
