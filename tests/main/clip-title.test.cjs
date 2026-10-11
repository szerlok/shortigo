const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { loadMain, tempDir } = require('../zernio/support/load-main.cjs')

function fixture(t, editable = false) {
  const temp = tempDir('shortigo-title-')
  t.after(temp.cleanup)
  const directory = path.join(temp.dir, 'Film')
  fs.mkdirSync(directory)
  const metadata = path.join(directory, 'job_output.json')
  const projectPath = path.join(directory, 'clip_00.editor.json')
  const options = { enabled: true, font: 'poppins', uppercase: false, radius: 16, mode: 'intro', start: 0, end: 3,
    size: 44, color: '#ffffff', background: '#000000', opacity: 1, position: 'auto', y: 6, fade: true, style: 'card' }
  const clip = { clip_index: 0, summary: 'Stary tytuł', s3_url: pathToFileURL(path.join(directory, 'clip_00.mp4')).href,
    duration_ms: 3000, start_time_ms: 0, end_time_ms: 3000, virality_score: .5, tags: ['gołębie'],
    is_favorite: true, thumbnail_url: 'file:///thumbnail.png', sent_to: [{ id: 'keep-publication' }],
    music_edit: { enabled: false, trackId: null, level: 'standard' },
    ...(editable ? { title_base_url: pathToFileURL(path.join(directory, 'clip_00.base.mp4')).href,
      title_edit: { text: 'Stary tytuł', options } } : {}) }
  fs.writeFileSync(path.join(directory, 'clip_00.mp4'), 'original media')
  fs.writeFileSync(metadata, JSON.stringify({ job_id: randomUUID(), source_video_title: 'Film', clips: [clip] }))
  const project = { version: 1, name: editable ? 'Stary tytuł (montaż)' : 'Własna nazwa montażu',
    segments: [{ id: randomUUID(), file: 'clip_00.mp4', startMs: 250, endMs: 2500 }], overlays: [], music: clip.music_edit,
    draftExtra: { untouched: true }, ...(editable ? { title: clip.title_edit } : {}) }
  fs.writeFileSync(projectPath, JSON.stringify(project))
  const exportingClips = new Set(), calls = []
  const read = () => JSON.parse(fs.readFileSync(metadata, 'utf8'))
  const api = loadMain("export * from './src/main/clip-title'", {
    './settings-store': { loadSettings: () => ({ outputDirectory: temp.dir }) },
    './file-manager': { getJobOutput: async () => read() },
    './title-editor': { exportingClips, exportTitle: async (dir, index, edit, afterCommit) => {
      calls.push({ dir, index, edit })
      assert.equal(exportingClips.has(dir), false, 'the renderer must acquire its own lock')
      exportingClips.add(dir)
      try {
        const raw = read()
        raw.clips[0].summary = edit.name
        raw.clips[0].title_edit = { text: edit.text, options: edit.options }
        // Simulate an independent edit while the rendering worker was busy.
        raw.clips[0].thumbnail_url = 'file:///new-thumbnail.png'
        fs.writeFileSync(metadata, JSON.stringify(raw))
        afterCommit(dir)
        assert.equal(exportingClips.has(dir), true)
        return read()
      } finally { exportingClips.delete(dir) }
    } }
  })
  return { ...api, directory, metadata, projectPath, clip, project, options, exportingClips, calls, read }
}

test('legacy title rename preserves media, independent metadata and a custom montage draft', async t => {
  const f = fixture(t)
  const result = await f.renameClipTitle(f.directory, 0, '  Nowy tytuł  ')
  assert.equal(result.clips[0].summary, 'Nowy tytuł')
  assert.deepEqual({ ...f.read().clips[0], summary: f.clip.summary }, f.clip)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.projectPath, 'utf8')), f.project)
  assert.equal(fs.readFileSync(path.join(f.directory, 'clip_00.mp4'), 'utf8'), 'original media')
  assert.equal(f.calls.length, 0)
  assert.equal(f.exportingClips.size, 0)
})

test('editable rename rerenders through the title editor and syncs only the title and automatic draft name', async t => {
  const f = fixture(t, true)
  const result = await f.renameClipTitle(f.directory, 0, 'Nowy tytuł')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].edit, { name: 'Nowy tytuł', text: 'Nowy tytuł', options: f.options })
  const saved = JSON.parse(fs.readFileSync(f.projectPath, 'utf8'))
  assert.deepEqual(saved, { ...f.project, name: 'Nowy tytuł', title: { ...f.project.title, text: 'Nowy tytuł' } })
  assert.equal(result.clips[0].thumbnail_url, 'file:///new-thumbnail.png')
  assert.equal(f.exportingClips.size, 0)
  saved.name = 'Własny montaż'
  fs.writeFileSync(f.projectPath, JSON.stringify(saved))
  await f.renameClipTitle(f.directory, 0, 'Jeszcze inny tytuł')
  assert.equal(JSON.parse(fs.readFileSync(f.projectPath, 'utf8')).name, 'Własny montaż')
})

test('busy operations, invalid title and unsafe sidecar fail before changing title or media', async t => {
  const f = fixture(t, true)
  const original = fs.readFileSync(f.metadata, 'utf8')
  f.exportingClips.add(fs.realpathSync(f.directory))
  await assert.rejects(f.renameClipTitle(f.directory, 0, 'Nowy tytuł'), /Poczekaj/)
  f.exportingClips.clear()
  await assert.rejects(f.renameClipTitle(f.directory, 0, ' '), /Podaj tytuł/)
  const savedProject = `${f.projectPath}.saved`
  fs.renameSync(f.projectPath, savedProject)
  fs.symlinkSync(savedProject, f.projectPath)
  await assert.rejects(f.renameClipTitle(f.directory, 0, 'Nowy tytuł'))
  assert.equal(fs.readFileSync(f.metadata, 'utf8'), original)
  assert.equal(f.calls.length, 0)
})
