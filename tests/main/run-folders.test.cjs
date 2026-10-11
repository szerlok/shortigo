const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { buildSync } = require('esbuild')
const compiled = buildSync({ stdin: {
  contents: `export * from './src/main/run-folders'; export * from './src/main/run-history'; export * from './src/main/clip-library';`,
  resolveDir: path.resolve(__dirname, '../..'), loader: 'ts'
}, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require, Buffer, URL })
const api = mod.exports
function fixture(root, title = 'Czy działa? / Film: test*') {
  const id = randomUUID(), dir = path.join(root, id)
  api.createRunRecord(root, id, '/original.mp4')
  api.finishRunRecord(root, id, 'completed')
  for (const name of ['clip.mp4', 'clip.base.mp4', 'source.mp4', 'transcript.json', 'plan.json', 'clip.srt']) fs.writeFileSync(path.join(dir, name), 'data')
  const uri = name => pathToFileURL(path.join(dir, name)).href
  const raw = { job_id: id, source_video_url: '/original.mp4', source_video_title: title,
    source_video_duration_seconds: 10, clips: [{ clip_index: 0, s3_url: uri('clip.mp4'), title_base_url: uri('clip.base.mp4'),
    subtitle_url: uri('clip.srt'), duration_ms: 2000, start_time_ms: 0, end_time_ms: 2000, virality_score: .5, layout_type: 'fit' }],
    transcript_url: uri('transcript.json'), plan_url: uri('plan.json'), edit_source_url: uri('source.mp4') }
  fs.writeFileSync(path.join(dir, 'job_output.json'), JSON.stringify(raw))
  return { id, dir }
}
function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-folders-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('folder titles are safe, Unicode-friendly and byte bounded', () => {
  assert.equal(api.safeRunName('  Czy działa? / Film: test*  '), 'Czy działa Film test')
  assert.equal(api.safeRunName('../CON?...'), 'Film CON')
  assert.equal(api.safeRunName('???'), 'Film')
  assert.ok(Buffer.byteLength(api.safeRunName('ą'.repeat(300))) <= 160)
})
test('rename preserves clips, stable job id, history and all artifact references', t => {
  const root = library(t), first = fixture(root)
  const result = api.renameRunFolder(root, first.dir)
  assert.equal(path.basename(result.directory), 'Czy działa Film test')
  assert.equal(result.jobId, first.id)
  assert.equal(fs.existsSync(first.dir), false)
  assert.equal(api.readRunRecord(root, path.basename(result.directory)).jobId, first.id)
  const raw = JSON.parse(fs.readFileSync(path.join(result.directory, 'job_output.json'), 'utf8'))
  for (const url of [raw.transcript_url, raw.plan_url, raw.edit_source_url, raw.clips[0].s3_url, raw.clips[0].title_base_url, raw.clips[0].subtitle_url]) {
    assert.equal(path.dirname(fileURLToPath(url)), result.directory)
    assert.equal(fs.existsSync(fileURLToPath(url)), true)
  }
  assert.equal(raw.source_video_url, '/original.mp4')
  const second = fixture(root)
  const duplicate = api.renameRunFolder(root, second.dir)
  assert.equal(path.basename(duplicate.directory), 'Czy działa Film test (2)')
  assert.equal(api.renameRunFolder(root, duplicate.directory).directory, duplicate.directory)
})
test('delete removes only the selected run including versions; symlink targets survive', async t => {
  const root = library(t), first = fixture(root), second = fixture(root)
  const selected = api.renameRunFolder(root, first.dir)
  fs.symlinkSync(second.dir, path.join(selected.directory, 'external-link'), 'dir')
  fs.writeFileSync(path.join(selected.directory, 'old-version.mp4'), 'data')
  assert.equal(await api.deleteRunFolder(root, selected.directory), first.id)
  assert.equal(fs.existsSync(selected.directory), false)
  assert.equal(fs.existsSync(second.dir), true)
})
test('root, unrelated directories and symlink run folders cannot be deleted', async t => {
  const root = library(t), first = fixture(root)
  const unrelated = path.join(root, 'personal'); fs.mkdirSync(unrelated)
  const link = path.join(root, 'link'); fs.symlinkSync(first.dir, link, 'dir')
  for (const dir of [root, unrelated, link, path.dirname(root)]) await assert.rejects(api.deleteRunFolder(root, dir))
  assert.equal(fs.existsSync(first.dir), true)
})

test('favorites persist through reload and folder rename; deleting one clip preserves its neighbors and source', t => {
  const root = library(t), run = fixture(root)
  const metadata = path.join(run.dir, 'job_output.json')
  const raw = JSON.parse(fs.readFileSync(metadata, 'utf8'))
  const uri = name => pathToFileURL(path.join(run.dir, name)).href
  for (const name of ['clip_00.mp4', 'clip_00.base.mp4', 'clip_01.mp4', 'clip_00.range-12345678-1234-1234-1234-123456789abc.mp4', 'clip_00.range-12345678-1234-1234-1234-123456789abc.base.srt']) fs.writeFileSync(path.join(run.dir, name), 'data')
  raw.clips[0].s3_url = uri('clip_00.mp4')
  raw.clips[0].title_base_url = uri('clip_00.base.mp4')
  raw.clips[0].subtitle_url = null
  raw.clips.push({ ...raw.clips[0], clip_index: 1, s3_url: uri('clip_01.mp4'), title_base_url: null })
  const musicFiles = ['clip_00.dry.mp4', `clip_00.music-${randomUUID()}.mp4`, `clip_00.title-${randomUUID()}.dry.mp4`, `clip_00.range-${randomUUID()}.dry.mp4`, `clip_00.music-preview-${randomUUID()}.m4a`]
  for (const name of musicFiles) fs.writeFileSync(path.join(run.dir, name), 'music data')
  raw.clips[0].s3_url = uri(musicFiles[1])
  raw.clips[0].music_base_url = uri(musicFiles[0])
  raw.clips[0].music_edit = { enabled: true, trackId: '1234567890abcdef', level: 'subtle' }
  const coverName = `clip_00.cover-${randomUUID()}.png`
  fs.writeFileSync(path.join(run.dir, coverName), 'cover data')
  raw.clips[0].thumbnail_url = uri(coverName)
  fs.writeFileSync(metadata, JSON.stringify(raw))
  assert.equal(api.setClipFavorite(root, run.dir, 0, true).clips[0].is_favorite, true)
  assert.equal(api.readLibraryClip(root, run.dir, 0).clip.is_favorite, true)
  assert.equal(api.setClipFavorite(root, run.dir, 0, false).clips[0].is_favorite, false)
  api.setClipFavorite(root, run.dir, 0, true)
  const renamed = api.renameRunFolder(root, run.dir)
  assert.equal(fileURLToPath(api.readLibraryClip(root, renamed.directory, 0).clip.music_base_url), path.join(renamed.directory, musicFiles[0]))
  assert.equal(fileURLToPath(api.readLibraryClip(root, renamed.directory, 0).clip.thumbnail_url), path.join(renamed.directory, coverName))
  assert.equal(api.readLibraryClip(root, renamed.directory, 0).clip.is_favorite, true)
  const output = api.deleteLibraryClip(root, renamed.directory, 0)
  assert.equal(output.clips.length, 1)
  assert.equal(output.total_clips, 1)
  assert.equal(output.clips[0].clip_index, 1)
  assert.equal(fs.readdirSync(renamed.directory).some(name => name.startsWith('clip_00.')), false)
  assert.equal(fs.existsSync(path.join(renamed.directory, 'clip_01.mp4')), true)
  assert.equal(fs.existsSync(path.join(renamed.directory, 'source.mp4')), true)
  assert.equal(api.deleteLibraryClip(root, renamed.directory, 1).total_clips, 0)
  assert.equal(fs.existsSync(path.join(renamed.directory, 'source.mp4')), true)
})
