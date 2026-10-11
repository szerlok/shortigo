'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createMockZernio } = require('../support/mock-zernio.cjs')
const { createPostingMock } = require('../support/mock-posts.cjs')
const { buildApp, launchApp, ROOT } = require('../support/electron-app.cjs')

const KEY = 'automation-e2e-key'
const FFMPEG = fs.existsSync(path.join(ROOT, 'engine-bin', 'ffmpeg')) ? path.join(ROOT, 'engine-bin', 'ffmpeg') : 'ffmpeg'

test('add selected library clips to an automation and run the next one', { timeout: 180_000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-automation-e2e-'))
  const clip = path.join(work, 'new_clip.mp4')
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=360x640:d=4:r=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'mpeg4', '-q:v', '8',
    '-c:a', 'aac', '-movflags', '+faststart', clip])
  const run = path.join(work, 'userData', 'BridgeClip', 'automation-library-run')
  fs.mkdirSync(run, { recursive: true })
  const clips = ['first.mp4', 'second.mp4'].map((name) => {
    const target = path.join(run, name)
    fs.copyFileSync(clip, target)
    return target
  })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({
    job_id: 'automation-library-run', source_video_title: 'Automation library run',
    clips: clips.map((file, index) => ({ clip_index: index, s3_url: `file://${file}`, duration_ms: 4000,
      start_time_ms: index * 4000, end_time_ms: (index + 1) * 4000, virality_score: 0.8 - index * 0.1,
      summary: index === 0 ? 'First library clip' : 'Second library clip' }))
  }))
  const posting = createPostingMock()
  const mock = await createMockZernio({ apiKey: KEY, extraRoutes: posting.routes })
  const [profile] = mock.state.profiles
  mock.addAccount('youtube', profile._id, { username: 'channel' })
  mock.addAccount('instagram', profile._id, { username: 'creator' })
  let session = null
  t.after(async () => {
    await session?.close()
    await mock.close()
    fs.rmSync(work, { recursive: true, force: true })
  })
  const appDir = buildApp(path.join(work, 'app'))
  session = await launchApp({ appDir, userDataDir: path.join(work, 'userData'), mock })
  const { page, app } = session
  await page.evaluate((key) => window.bridgeclip.settings.replaceApiKey('zernioApiKey', key), KEY)
  await page.reload()
  await page.getByRole('navigation', { name: "Nawigacja główna" }).getByRole('button', { name: /Automatyzacje/ }).click()
  await page.getByLabel("Nazwa automatyzacji").fill('BridgeMind')
  await page.locator('form').getByRole('button', { name: "Utwórz" }).click()
  await page.getByRole('heading', { name: "Bank treści" }).waitFor()

  await page.getByRole('button', { name: "Nowy profil" }).click()
  await page.getByLabel("Nazwa nowego profilu").fill('Another profile')
  await page.locator('form').getByRole('button', { name: "Utwórz", exact: true }).click()
  await page.getByText('Profile “Another profile” created.').waitFor()
  await page.getByLabel("Profil Zernio").selectOption(profile._id)
  await page.getByRole('button', { name: "Połącz", exact: true }).click()
  await page.getByRole('heading', { name: "Konta" }).waitFor()
  await page.getByRole('navigation', { name: "Nawigacja główna" }).getByRole('button', { name: /Automatyzacje/ }).click()
  await page.getByRole('heading', { name: "Bank treści" }).waitFor()
  assert.equal(await page.getByLabel("Profil Zernio").inputValue(), profile._id)

  await page.getByRole('checkbox', { name: /@channel/ }).check()
  await page.getByRole('checkbox', { name: /@creator/ }).check()
  assert.equal(await page.getByRole('switch', { name: "Twórz opisy z AI" }).getAttribute('aria-checked'), 'false')
  await page.getByRole('radiogroup', { name: "Widoczność w YouTube" }).getByRole('radio', { name: "Niepubliczny" }).click()
  await page.locator('input[type="time"]').fill('23:59')
  await page.getByRole('button', { name: "Dodaj godzinę" }).click()
  await page.getByRole('button', { name: "Zapisz zmiany" }).click()
  await page.getByText("Zapisano zmiany.").waitFor()
  await page.getByRole('switch', { name: "Automatyzacja włączona" }).click()
  await page.getByText('BridgeMind is on.').waitFor()

  await page.getByRole('navigation', { name: "Nawigacja główna" }).getByRole('button', { name: /Biblioteka/ }).click()
  await page.getByText('Automation library run').click()
  await page.getByRole('checkbox', { name: "Zaznacz wszystkie klipy" }).click()
  await page.getByRole('button', { name: 'Add 2 to automation' }).click()
  await page.getByRole('dialog', { name: "Dodaj do banku treści" }).getByRole('button', { name: 'Add 2 clips' }).click()
  await page.getByRole('button', { name: "Pokaż bank treści" }).click()
  await page.getByRole('heading', { name: "Bank treści" }).waitFor()
  const clipTitle = page.getByText('First library clip', { exact: true })
  await clipTitle.waitFor()
  await app.evaluate(({ clipboard }) => clipboard.writeText('before-copy'))
  const titleBounds = await clipTitle.boundingBox()
  assert.ok(titleBounds)
  await page.mouse.move(titleBounds.x + 2, titleBounds.y + titleBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(titleBounds.x + 85, titleBounds.y + titleBounds.height / 2, { steps: 10 })
  await page.mouse.up()
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  const selectionStyles = await clipTitle.evaluate((element) => ({
    text: getComputedStyle(element).userSelect,
    parent: getComputedStyle(element.parentElement).userSelect,
    scroll: getComputedStyle(document.getElementById('page-scroll')).userSelect
  }))
  assert.ok(selection.trim(), `content text can be selected (${JSON.stringify(selectionStyles)})`)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), selection, 'the selected content copies to the clipboard')
  await page.getByRole('button', { name: "Uruchom teraz" }).click()
  await page.getByText("Zadanie zakończone. Sprawdź wynik w banku treści.").waitFor()

  assert.equal(posting.state.uploads.length, 1)
  assert.equal(posting.state.creates.length, 1)
  assert.deepEqual(posting.state.creates[0].body.platforms.map((target) => target.platform), ['youtube', 'instagram'])
  assert.equal(posting.state.creates[0].body.platforms[0].platformSpecificData.visibility, 'unlisted')
  assert.equal(await page.getByRole('button', { name: "Uruchom teraz" }).isDisabled(), false, 'the remaining clip can be run next')
})
