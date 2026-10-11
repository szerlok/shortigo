'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

test('Electron serves only library media and supports bounded byte ranges', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-media-e2e-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userDataDir = path.join(root, 'user-data')
  const library = path.join(userDataDir, 'BridgeClip')
  fs.mkdirSync(library, { recursive: true })
  const inside = path.join(library, 'clip.mp4')
  const image = path.join(library, 'frame.png')
  const outside = path.join(root, 'outside.mp4')
  fs.writeFileSync(inside, '0123456789')
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII=', 'base64'))
  fs.writeFileSync(outside, 'private')
  const appDir = buildApp(path.join(root, 'app'))
  const session = await launchApp({ appDir, userDataDir })
  t.after(() => session.close())
  const request = (file, range) => session.app.evaluate(async ({ net }, { file, range }) => {
    const headers = range ? { Range: range } : {}
    const response = await net.fetch(`local-file://media/${encodeURIComponent(file)}`, { headers })
    return { status: response.status, body: await response.text(), range: response.headers.get('content-range') }
  }, { file, range })
  assert.deepEqual(await request(inside, 'bytes=2-5'), { status: 206, body: '2345', range: 'bytes 2-5/10' })
  assert.equal((await request(inside, 'bytes=11-12')).status, 416)
  assert.equal((await request(outside)).status, 403)
  assert.equal(await session.page.evaluate((file) => new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(true)
    image.onerror = () => resolve(false)
    image.src = `local-file://media/${encodeURIComponent(file)}`
  }), image), true)

  const playable = path.join(library, 'playable.mp4')
  execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', playable])
  assert.deepEqual(await session.page.evaluate((file) => new Promise((resolve) => {
    const video = document.createElement('video')
    video.muted = true
    video.src = `local-file://media/${encodeURIComponent(file)}`
    document.body.appendChild(video)
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 10000)
    video.onerror = () => { clearTimeout(timer); resolve({ ok: false, reason: `media ${video.error?.code}` }); video.remove() }
    video.onloadedmetadata = async () => {
      try {
        await video.play()
        video.currentTime = 1
        video.onseeked = () => { clearTimeout(timer); resolve({ ok: video.videoWidth === 320 && video.currentTime >= 0.9 }); video.remove() }
      } catch (error) { clearTimeout(timer); resolve({ ok: false, reason: String(error) }); video.remove() }
    }
  }), playable), { ok: true })
})
