'use strict'
// Only mocked storage requests: no network, account or publication requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Readable, Writable } = require('node:stream')
const { loadMain, tempDir } = require('./support/load-main.cjs')

const MIB = 1024 * 1024
const MAC = 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC'
const URL = 'https://storage.example/same-object?signature=never-log-this'

function uploadMock(outcomes, onDelay = () => {}) {
  const calls = []
  const delays = []
  const upload = loadMain("export { putFile } from './src/main/zernio/posts-upload'", {
    electron: {},
    os: { platform: () => 'linux' },
    'timers/promises': {
      setTimeout: async (ms, _value, { signal } = {}) => {
        delays.push(ms)
        await onDelay(ms)
        if (signal?.aborted) throw Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' })
      }
    },
    https: {
      request: (url, options, callback) => {
        const outcome = outcomes[calls.length] ?? {}
        const call = { url, options, chunks: [] }
        calls.push(call)
        const request = new Writable({
          write(chunk, _encoding, done) {
            call.chunks.push(Buffer.from(chunk))
            if (outcome.code) done(Object.assign(new Error('mock transport failure'), { code: outcome.code }))
            else done()
          }
        })
        const respond = status => {
          const response = Readable.from([])
          response.statusCode = status
          callback(response)
        }
        request.flushHeaders = () => {
          if (outcome.beforeBody) {
            queueMicrotask(() => request.destroy(Object.assign(new Error('mock TLS failure'), { code: outcome.code })))
          } else if (outcome.status) {
            queueMicrotask(() => respond(outcome.status))
          } else {
            request.emit('continue')
          }
        }
        request.on('finish', () => respond(200))
        return request
      }
    }
  })
  return { ...upload, calls, delays }
}

async function withSource(run) {
  const { dir, cleanup } = tempDir('shortigo-upload-recovery-')
  const source = path.join(dir, 'clip.mp4')
  const bytes = Buffer.alloc(192 * 1024 + 37, 'authorized original clip')
  fs.writeFileSync(source, bytes)
  const handle = await fs.promises.open(source, 'r')
  try { await run({ source, bytes, handle }) }
  finally { await handle.close(); cleanup() }
}

test('MAC and pipe failures retry the same authorized file with gentler pacing and fresh connections', async () => {
  await withSource(async ({ source, bytes, handle }) => {
    // The opened handle, not a reopened pathname, must survive all retries.
    fs.renameSync(source, `${source}.original`)
    fs.writeFileSync(source, 'replacement must never be uploaded')
    const upload = uploadMock([{ code: MAC }, { code: 'EPIPE' }, {}])
    const attempts = []
    const progress = []
    await upload.putFile(URL, handle, {
      contentType: 'video/mp4', size: bytes.length, stableUpload: true,
      onAttempt: info => attempts.push(info), onProgress: sent => progress.push(sent)
    })
    assert.deepEqual(attempts, [
      { attempt: 1, maxAttempts: 3, bytesPerSecond: 5 * MIB },
      { attempt: 2, maxAttempts: 3, bytesPerSecond: 2.5 * MIB },
      { attempt: 3, maxAttempts: 3, bytesPerSecond: MIB }
    ])
    assert.equal(upload.calls.length, 3)
    for (const call of upload.calls) {
      assert.equal(call.url, URL)
      assert.equal(call.options.agent, false)
      assert.notEqual(call.options.rejectUnauthorized, false)
      assert.equal(call.options.headers.Authorization, undefined)
      assert.ok(call.chunks.every(chunk => chunk.length <= 64 * 1024))
    }
    assert.deepEqual(Buffer.concat(upload.calls[2].chunks), bytes)
    assert.equal(progress.filter(sent => sent === 0).length, 2)
    assert.equal((await handle.stat()).size, bytes.length)
  })
})

test('temporary HTTP refusal retries without reducing the limit until a transport failure occurs', async () => {
  await withSource(async ({ bytes, handle }) => {
    const upload = uploadMock([{ status: 503 }, { code: MAC }, {}])
    const attempts = []
    await upload.putFile(URL, handle, {
      contentType: 'video/mp4', size: bytes.length, stableUpload: true,
      onAttempt: info => attempts.push(info)
    })
    assert.deepEqual(attempts.map(info => info.bytesPerSecond), [5 * MIB, 5 * MIB, 2.5 * MIB])
    assert.equal(upload.calls[0].chunks.length, 0)
    assert.deepEqual(Buffer.concat(upload.calls[2].chunks), bytes)
  })
})

test('repeated MAC errors stop after three attempts and retain the transport error', async () => {
  await withSource(async ({ bytes, handle }) => {
    const upload = uploadMock([{ code: MAC }, { code: MAC }, { code: MAC }, {}])
    await assert.rejects(upload.putFile(URL, handle, {
      contentType: 'video/mp4', size: bytes.length, stableUpload: true
    }), error => error.code === MAC && error.status === 0)
    assert.equal(upload.calls.length, 3)
  })
})

test('certificate failures remain terminal and never disable TLS validation', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    await withSource(async ({ bytes, handle }) => {
      const upload = uploadMock([{ code, beforeBody: true }, {}])
      await assert.rejects(upload.putFile(URL, handle, {
        contentType: 'video/mp4', size: bytes.length, stableUpload: true
      }), error => error.code === code)
      assert.equal(upload.calls.length, 1)
      assert.equal(upload.calls[0].chunks.length, 0)
      assert.notEqual(upload.calls[0].options.rejectUnauthorized, false)
    })
  }
})

test('cancelling after a MAC error prevents the next attempt and preserves the open handle', async () => {
  await withSource(async ({ bytes, handle }) => {
    const controller = new AbortController()
    const upload = uploadMock([{ code: MAC }, {}], ms => {
      if (ms >= 1000) controller.abort()
    })
    await assert.rejects(upload.putFile(URL, handle, {
      contentType: 'video/mp4', size: bytes.length, stableUpload: true, signal: controller.signal
    }), /Przesyłanie anulowano/)
    assert.equal(upload.calls.length, 1)
    assert.equal((await handle.stat()).size, bytes.length)
  })
})
