'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough, Readable, Writable } = require('node:stream')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron, ROOT } = require('./support/load-main.cjs')

test('Python upload keeps signed URLs in a private pipe and validates worker completion', async () => {
  const { dir, cleanup } = tempDir('shortigo-upload-python-')
  const { electron } = fakeElectron(dir)
  const configuredPython = path.join(dir, 'configured-python')
  fs.writeFileSync(configuredPython, '# test interpreter')
  fs.writeFileSync(path.join(electron.app.getPath('userData'), 'settings.json'), JSON.stringify({ pythonPath: configuredPython }))
  const payload = Buffer.from('the authorized video')
  const url = 'https://storage.example/clip?signature=private-test-token'
  let mode = 'success'
  let spawns = 0
  let kills = 0
  const upload = loadMain("export { sendPythonUpload } from './src/main/zernio/posts-upload-python'", {
    electron,
    dns: { lookup: (_host, _options, callback) => callback(null, [
      { address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }
    ]) },
    child_process: { ...require('node:child_process'), spawn: (executable, args, options) => {
      spawns++
      assert.equal(executable, configuredPython)
      assert.deepEqual(args, ['-I', '-u', path.join(ROOT, 'bridge/zernio_upload.py')])
      assert.ok(!JSON.stringify(args).includes('private-test-token'))
      assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'PATH'])
      const child = new EventEmitter()
      const received = []
      child.stdin = new Writable({ write(chunk, _encoding, callback) { received.push(chunk); callback() } })
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      const configChunks = []
      const config = new Writable({ write(chunk, _encoding, callback) { configChunks.push(chunk); callback() } })
      child.stdio = [child.stdin, child.stdout, child.stderr, config]
      let closed = false
      const finish = (result, exitCode = 0) => {
        if (closed) return
        closed = true
        child.stdout.end(JSON.stringify(result))
        child.emit('close', exitCode)
      }
      child.kill = () => { kills++; queueMicrotask(() => finish({}, null)); return true }
      config.on('finish', () => {
        const value = JSON.parse(Buffer.concat(configChunks).toString())
        assert.equal(value.url, url)
        assert.equal(value.contentType, 'video/mp4')
        assert.equal(value.size, payload.length)
        assert.deepEqual(value.addresses, ['8.8.8.8'])
        assert.equal(value.timeoutSeconds, 5)
        if (mode === 'refuse' || mode === 'tls' || mode === 'missing') {
          child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
          setImmediate(() => finish(mode === 'refuse' ? { status: 403, bytes: 0 } :
            { status: 0, bytes: 0, code: mode === 'tls' ? 'CERTIFICATE_VERIFY_FAILED' : 'python_upload_unavailable' }, 1))
        }
      })
      child.stdin.on('finish', () => {
        assert.deepEqual(Buffer.concat(received), payload)
        if (mode === 'success') finish({ status: 200, bytes: payload.length, mssBefore: 1388, mssAfter: 1024 })
        else if (mode === 'short') finish({ status: 200, bytes: payload.length - 1 })
      })
      return child
    } }
  })
  const run = (signal = new AbortController().signal) => upload.sendPythonUpload(url, Readable.from([payload]),
    { contentType: 'video/mp4', size: payload.length }, signal, 5000)
  try {
    await run()
    mode = 'short'
    await assert.rejects(run(), error => error.code === 'upload_incomplete')
    mode = 'refuse'
    await assert.rejects(run(), error => error.status === 403)
    mode = 'tls'
    await assert.rejects(run(), error => error.code === 'CERTIFICATE_VERIFY_FAILED')
    mode = 'missing'
    await assert.rejects(run(), error => error.code === 'python_upload_unavailable')
    mode = 'wait'
    const controller = new AbortController()
    const pending = run(controller.signal)
    setImmediate(() => controller.abort())
    await assert.rejects(pending, error => error.code === 'ABORT_ERR')
    assert.equal(spawns, 6)
    assert.equal(kills, 1)
  } finally { cleanup() }
})
