'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp, ROOT } = require('../zernio/support/electron-app.cjs')

test('clip editor previews, cuts and exports while keeping the original and saved project', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shortigo-editor-e2e-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userDataDir = path.join(root, 'user-data')
  const run = path.join(userDataDir, 'BridgeClip', 'Montaz testowy')
  fs.mkdirSync(run, { recursive: true })
  const original = path.join(run, 'clip_00.mp4')
  const extra = path.join(root, 'extra.mp4')
  const graphic = path.join(root, 'graphic.png')
  execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', original])
  execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:size=320x568:rate=30',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', extra])
  execFileSync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1', graphic])
  const clip = { clip_index: 0, s3_url: pathToFileURL(original).href, duration_ms: 3000, start_time_ms: 0,
    end_time_ms: 3000, virality_score: .8, layout_type: 'fit', summary: 'Test montażu', tags: [], render_fallback: null,
    title_base_url: pathToFileURL(original).href, title_edit: { text: 'Tytuł próby', options: {
      font: 'poppins', uppercase: false, radius: 16, enabled: false, mode: 'intro', start: 0, end: 3,
      size: 44, color: '#151515', background: '#ffffff', opacity: 0.96,
      position: 'auto', y: 6, fade: true, style: 'card'
    } } }
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: '11111111-1111-4111-8111-111111111111',
    source_video_url: '', source_video_title: 'Montaz testowy', source_video_duration_seconds: 3, total_clips: 1,
    clips: [clip], transcript_url: null, plan_url: null, processing_time_seconds: 1, metrics: null }))
  const appDir = buildApp(path.join(root, 'app'))
  fs.symlinkSync(path.join(ROOT, 'engine'), path.join(appDir, 'engine'), 'dir')
  fs.symlinkSync(path.join(ROOT, 'bridge'), path.join(appDir, 'bridge'), 'dir')
  const session = await launchApp({ appDir, userDataDir, env: { PATH: process.env.PATH } })
  t.after(() => session.close())
  const page = session.page
  await page.getByRole('button', { name: 'Biblioteka', exact: true }).click()
  await page.getByText('Montaz testowy', { exact: true }).click()
  await page.getByRole('button', { name: 'Edytuj klip', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Edytuj klip' })
  await modal.getByText('Oś filmu').waitFor()
  await modal.getByLabel('Nazwa nowego klipu').fill('Montaż próbny')
  await modal.getByRole('button', { name: 'Przygotuj podgląd' }).click()
  await modal.getByText('Podgląd gotowego montażu').waitFor({ timeout: 30000 })
  await page.screenshot({ path: '/tmp/shortigo-editor-current.png' })
  assert.equal(await modal.locator('video').evaluate(video => video.videoWidth > 0 && video.duration > 2), true)
  await modal.getByLabel('Pozycja na osi czasu').fill('1200')
  await modal.getByRole('button', { name: 'Podziel tutaj' }).click()
  assert.equal(await modal.locator('button[title^="clip_00.mp4"]').count(), 2)
  await page.waitForFunction(() => {
    const video = document.querySelector('[role="dialog"] video')
    return video && video.readyState >= 1 && Math.abs(video.currentTime - 1.2) < 0.25
  }, null, { timeout: 10000 })
  await modal.getByLabel('Pozycja na osi czasu').fill('1700')
  await page.waitForFunction(() => {
    const video = document.querySelector('[role="dialog"] video')
    return video && video.readyState >= 1 && Math.abs(video.currentTime - 1.7) < 0.25
  }, null, { timeout: 10000 })
  await modal.getByLabel('Pozycja na osi czasu').fill('500')
  await modal.locator('video').evaluate(video => video.play())
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const video = dialog?.querySelector('video')
    const position = dialog?.querySelector('input[aria-label="Pozycja na osi czasu"]')
    return video && position && Number(position.value) > 1300 && !video.paused
  }, null, { timeout: 10000 })
  await modal.getByRole('button', { name: 'Usuń fragment' }).click()
  await session.app.evaluate(({ dialog }, { extra, graphic }) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false,
      filePaths: [options.filters[0].name === 'Grafiki' ? graphic : extra] })
  }, { extra, graphic })
  await modal.getByRole('button', { name: 'Dodaj fragment innego filmu' }).click()
  await modal.getByText('Dodany film').waitFor()
  await modal.getByRole('button', { name: 'Dodaj grafikę w tym miejscu' }).click()
  await modal.getByText('Przeciągnij grafikę na obrazie').waitFor()
  await modal.getByRole('button', { name: 'Przygotuj podgląd' }).click()
  await modal.getByText('Podgląd gotowego montażu').waitFor({ timeout: 30000 })
  await modal.getByRole('button', { name: 'Eksportuj klip' }).click()
  await modal.waitFor({ state: 'hidden', timeout: 30000 })
  const saved = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8'))
  assert.equal(saved.clips.length, 2)
  assert.equal(saved.total_clips, 2)
  assert.equal(saved.clips[0].s3_url, clip.s3_url)
  assert.equal(saved.clips[1].summary, 'Montaż próbny')
  const result = fileURLToPath(saved.clips[1].s3_url)
  assert.notEqual(result, original)
  assert.ok(fs.statSync(result).size > 0)
  assert.ok(fs.statSync(fileURLToPath(saved.clips[1].title_base_url)).size > 0)
  assert.ok(fs.statSync(fileURLToPath(saved.clips[1].music_base_url)).size > 0)
  assert.equal(saved.clips[1].title_edit.options.enabled, false)
  assert.ok(fs.statSync(original).size > 0)
  assert.ok(saved.clips[1].duration_ms < 3000)
  const project = JSON.parse(fs.readFileSync(path.join(run, 'clip_01.editor.json'), 'utf8'))
  assert.equal(project.segments.length, 2)
  assert.equal(project.overlays.length, 1)
  assert.ok(project.segments.every(segment => segment.file.startsWith('clip_01.asset-') && fs.existsSync(path.join(run, segment.file))))
  assert.equal(await page.getByRole('button', { name: 'Edytuj tytuł' }).count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Miniaturka' }).count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Muzyka', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Popraw fragment' }).count(), 0)
  await page.getByRole('button', { name: 'Edytuj klip', exact: true }).last().click()
  await page.getByRole('dialog', { name: 'Edytuj klip' }).getByText('Oś filmu').waitFor()
  await page.getByRole('dialog', { name: 'Edytuj klip' }).getByRole('button', { name: 'Zamknij' }).click()
  // Exercise the UI without spending the user's OpenRouter credits.
  await session.app.evaluate(({ ipcMain }, { run, graphic }) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const { pathToFileURL } = process.getBuiltinModule('url')
    globalThis.thumbnailCalls = []
    const models = [
      { id: 'bytedance-seed/seedream-5-0-lite', name: 'Seedream 5.0 Lite', priceUsd: 0.035 },
      { id: 'qwen/qwen-image-3', name: 'Qwen Image 3', priceUsd: 0.033 }
    ].map(model => ({ ...model, description: 'Model testowy', available: true, priceLabel: `$${model.priceUsd}`,
      priceKind: 'fixed', resolution: '1K', aspectRatios: ['9:16', '16:9', '1:1'], pricingUpdatedAt: new Date().toISOString() }))
    ipcMain.removeHandler('clips:thumbnailModels')
    ipcMain.handle('clips:thumbnailModels', () => models)
    ipcMain.removeHandler('clips:generateThumbnail')
    ipcMain.handle('clips:generateThumbnail', (_event, directory, index, request) => {
      globalThis.thumbnailCalls.push(request)
      const metadata = path.join(run, 'job_output.json')
      const output = JSON.parse(fs.readFileSync(metadata, 'utf8'))
      const clip = output.clips.find(c => c.clip_index === index)
      const destination = path.join(directory, `clip_${String(index).padStart(2, '0')}.cover-11111111-1111-4111-8111-111111111111.png`)
      fs.copyFileSync(graphic, destination)
      clip.thumbnail_url = pathToFileURL(destination).href
      clip.thumbnail_edit = { ...request, createdAt: new Date().toISOString(), costUsd: .033 }
      fs.writeFileSync(metadata, JSON.stringify(output))
      return { output, path: destination, costUsd: .033 }
    })
  }, { run, graphic })
  await page.getByRole('button', { name: 'Miniaturka', exact: true }).last().click()
  const thumbnail = page.getByRole('dialog', { name: 'Miniaturka' })
  await thumbnail.getByRole('radio', { name: /Seedream/ }).waitFor()
  assert.equal(await session.app.evaluate(() => globalThis.thumbnailCalls.length), 0)
  await thumbnail.getByLabel('2. Tytuł klipu').fill('Nowy tytuł miniaturki')
  await thumbnail.getByRole('button', { name: 'Ustaw Qwen Image 3 jako domyślny' }).click()
  await thumbnail.getByLabel('Kadr do miniaturki').fill('495')
  await page.screenshot({ path: '/tmp/shortigo-thumbnail-current.png' })
  await thumbnail.getByRole('button', { name: /Wygeneruj miniaturkę/ }).click()
  await thumbnail.getByRole('img', { name: 'Wygenerowana miniaturka klipu' }).waitFor({ timeout: 30000 })
  const renamed = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8')).clips[1]
  assert.equal(renamed.summary, 'Nowy tytuł miniaturki')
  assert.equal(renamed.title_edit.text, 'Nowy tytuł miniaturki')
  assert.equal(renamed.thumbnail_edit.modelId, 'qwen/qwen-image-3')
  assert.ok(Math.abs(renamed.thumbnail_edit.frameMs - 495) < 100)
  assert.equal(await session.app.evaluate(() => globalThis.thumbnailCalls.length), 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'clip_01.editor.json'), 'utf8')).title.text, renamed.summary)
  await thumbnail.getByRole('button', { name: 'Zamknij' }).click()
  await page.getByRole('button', { name: 'Miniaturka · gotowa', exact: true }).click()
  await thumbnail.getByRole('radio', { name: /Qwen Image 3/ }).waitFor()
  assert.equal(await thumbnail.getByRole('radio', { name: /Qwen Image 3/ }).getAttribute('aria-checked'), 'true')
  assert.equal(await session.app.evaluate(() => globalThis.thumbnailCalls.length), 1)
})
