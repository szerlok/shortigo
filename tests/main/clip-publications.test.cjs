const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { buildSync } = require('esbuild')
const code = buildSync({ stdin: { contents: `
  export * from './src/main/clip-publications';
  export * from './src/shared/clip-publications';
  export * from './src/main/clip-library';
  export * from './src/main/run-folders';
  export { PostsStore } from './src/main/zernio/posts-store';
`, resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
const mod = { exports: {} }
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, Buffer, URL })
const api = mod.exports
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shortigo-sent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = randomUUID(), directory = path.join(root, id)
  fs.mkdirSync(directory)
  const clipPath = path.join(directory, 'clip_00.mp4')
  fs.writeFileSync(clipPath, 'clip')
  fs.writeFileSync(path.join(directory, 'job_output.json'), JSON.stringify({ job_id: id, source_video_title: 'Film po polsku', clips: [{
    clip_index: 0, s3_url: pathToFileURL(clipPath).href, duration_ms: 3000, start_time_ms: 0, end_time_ms: 3000, virality_score: .5
  }] }))
  const post = { id: 'post-1', clipPath, clipTitle: 'Klip', status: 'partial', scheduledFor: null, timezone: null,
    createdAt: '2026-09-25T10:00:00Z', uploadedAt: '2026-09-25T10:00:00Z', refreshedAt: null, error: null,
    targets: [{ platform: 'youtube', accountId: 'yt1', status: 'published', inbox: false, handle: null, url: null, error: null },
      { platform: 'tiktok', accountId: 'tt1', status: 'failed', inbox: false, handle: null, url: null, error: 'failed' }] }
  return { root, directory, post, id }
}
test('partial publication marks only successful platforms and survives history dismissal', t => {
  const { root, directory, post, id } = fixture(t)
  const store = new api.PostsStore(path.join(root, 'posts.json'), null, p => api.rememberClipPublication(root, p))
  store.save(post)
  assert.equal(store.get(post.id).clipKey, `${id}:0`)
  store.remove(post.id)
  const clip = api.readLibraryClip(root, directory, 0).clip
  assert.equal(clip.sent_to.length, 1)
  assert.equal(clip.sent_to[0].platform, 'youtube')
  const edited = path.join(directory, `clip_00.music-${randomUUID()}.mp4`)
  assert.equal(api.matchingClipPosts([post], edited).length, 1)
  assert.equal(api.matchingClipPosts([post], path.join(directory, 'clip_01.mp4')).length, 0)
})
test('failed uploads and queued posts never get a successful-send marker', t => {
  const { root, directory, post } = fixture(t)
  for (const status of ['failed', 'publishing', 'scheduled', 'cancelled']) {
    api.rememberClipPublication(root, { ...post, status, targets: post.targets.map(p => ({ ...p, status: 'pending' })) })
    assert.equal(api.readLibraryClip(root, directory, 0).clip.sent_to.length, 0)
  }
})
test('pending publication can finish after folder rename; inbox sends remain marked', t => {
  const { root, directory, post } = fixture(t)
  const pending = api.rememberClipPublication(root, { ...post, status: 'publishing', targets: [
    { ...post.targets[1], status: 'pending', inbox: true, error: null }
  ] })
  const renamed = api.renameRunFolder(root, directory)
  const published = { ...pending, status: 'published', targets: pending.targets.map(p => ({ ...p, status: 'published' })) }
  api.rememberClipPublication(root, published)
  const clip = api.readLibraryClip(root, renamed.directory, 0).clip
  assert.equal(clip.sent_to.length, 1)
  assert.equal(clip.sent_to[0].inbox, true)
  assert.equal(api.matchingClipPosts([published], clip.s3_url, clip.library_key).length, 1)
})
