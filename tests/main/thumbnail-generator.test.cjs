const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
function compile(file, load, extras = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const mod = { exports: {} }
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: load, Buffer, URL, Date, setTimeout, clearTimeout, AbortSignal, Response, ...extras })
  return mod.exports
}
const shared = compile('src/shared/thumbnail.ts', require)
function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shortigo-thumbnail-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'clip_00.mp4')
  fs.writeFileSync(source, 'video fixture')
  const metadata = path.join(directory, 'job_output.json')
  const clip = { clip_index: 0, duration_ms: 5000, summary: 'Jak dbać o gołębie?', s3_url: pathToFileURL(source).href }
  fs.writeFileSync(metadata, JSON.stringify({ clips: [clip] }))
  const png = Buffer.alloc(40)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.write('IHDR', 12); png.writeUInt32BE(512, 16); png.writeUInt32BE(512, 20)
  const calls = [], exportingClips = new Set()
  const read = () => { const raw = JSON.parse(fs.readFileSync(metadata)); return { directory, metadata, raw, output: raw, clip: raw.clips[0] } }
  const api = compile('src/main/thumbnail-generator.ts', name => {
    if (name === '../shared/thumbnail') return shared
    if (name === './clip-library') return { readLibraryClip: read }
    if (name === './settings-store') return { loadSettings: () => ({ outputDirectory: directory, openrouterApiKey: 'test-secret' }) }
    if (name === './security') return { assertAbsolutePath() {}, assertMediaPath() {}, authorizeMedia() {} }
    if (name === './title-editor') return { exportingClips }
    if (name === './tools') return { resolveBinary: () => 'ffmpeg' }
    if (name === 'electron') return { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 512, height: 512 }) }) } }
    if (name === 'child_process') return { spawn() {
      const child = new EventEmitter()
      child.stdout = new PassThrough(); child.kill = () => {}
      queueMicrotask(() => { child.stdout.write(Buffer.alloc(100, 1)); child.emit('close', 0) })
      return child
    } }
    return require(name)
  }, { fetch: async (url, init) => {
    calls.push({ url, init })
    if (options.offline) throw new TypeError('offline')
    if (url.endsWith('/models')) return Response.json({ data: shared.THUMBNAIL_MODEL_CHOICES.map(m => ({ id: m.id, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image'] } })) })
    if (url.endsWith('/endpoints')) {
      const model = shared.THUMBNAIL_MODEL_CHOICES.find(m => url.includes(m.id))
      const pricing = model.id.startsWith('qwen/') ? [
        { billable: 'input_image', unit: 'image', cost_usd: .003 },
        { billable: 'output_image', unit: 'image', cost_usd: .03, variant: '1k' },
        { billable: 'output_image', unit: 'image', cost_usd: .06, variant: '2k' }
      ] : model.id.startsWith('google/') ? [{ billable: 'output_image', unit: 'token', cost_usd: .00003 }]
        : [{ billable: 'output_image', unit: 'image', cost_usd: .035 }, { billable: 'input_image', unit: 'image', cost_usd: 0 }]
      return Response.json({ endpoints: [{ provider_tag: 'test-provider', supported_parameters: {
        resolution: { values: [model.resolution] }, aspect_ratio: { values: ['9:16', '16:9', '1:1'] }, input_references: { min: 0, max: 4 }
      }, pricing }] })
    }
    assert.equal(exportingClips.has(directory), true, 'generation must protect run against deletion')
    if (options.status) return new Response('Sensitive upstream error that must not leak', { status: options.status })
    const current = read().raw
    current.clips[0].is_favorite = true
    fs.writeFileSync(metadata, JSON.stringify(current))
    if (options.removeMetadata) fs.rmSync(metadata)
    return Response.json({ data: [{ b64_json: options.invalidImage ? Buffer.from('<svg>invalid</svg>').toString('base64') : png.toString('base64') }], usage: { cost: .035 } })
  } })
  const request = { modelId: shared.DEFAULT_THUMBNAIL_MODEL, title: clip.summary, prompt: shared.DEFAULT_THUMBNAIL_PROMPT, frameMs: 500, aspectRatio: '9:16' }
  return { directory, metadata, request, api, calls, exportingClips, read }
}

test('live catalogue includes one reference, correct resolution tier, and truthful token estimates', async t => {
  const f = fixture(t)
  const models = await f.api.listThumbnailModels()
  assert.equal(models.length, 4)
  assert.equal(models[0].priceUsd, .035)
  assert.equal(models[1].priceUsd, .033)
  assert.equal(models[1].priceKind, 'fixed')
  assert.equal(models[2].priceKind, 'estimate')
  assert.ok(Math.abs(models[2].priceUsd - .0336) < .000001)
  assert.match(models[2].priceLabel, /danych wejściowych/)
  await f.api.listThumbnailModels()
  assert.equal(f.calls.length, 5, 'reopening dialog does not refetch unchanged catalogue')
  assert.ok(f.calls.every(c => !c.init.headers), 'public discovery never transmits API key')
})

test('one explicit generation sends chosen frame and title, preserves metadata edits and unlocks run', async t => {
  const f = fixture(t)
  const result = await f.api.generateClipThumbnail(f.directory, 0, f.request)
  const post = f.calls.filter(c => c.init?.method === 'POST')
  assert.equal(post.length, 1)
  const body = JSON.parse(post[0].init.body)
  assert.equal(body.n, 1)
  assert.equal(body.provider.allow_fallbacks, false)
  assert.equal(body.provider.only[0], 'test-provider')
  assert.match(body.prompt, /^Tytuł klipu: Jak dbać o gołębie\?/)
  assert.equal(body.input_references.length, 1)
  assert.match(body.input_references[0].image_url.url, /^data:image\/jpeg;base64,/)
  assert.equal(result.output.clips[0].is_favorite, true)
  assert.equal(result.output.clips[0].summary, f.request.title)
  assert.equal(result.output.clips[0].thumbnail_edit.title, f.request.title)
  assert.equal(result.costUsd, .035)
  assert.equal(fs.existsSync(result.path), true)
  assert.equal(f.exportingClips.size, 0)
})

test('stale title is rejected before any request and paid generation is never retried', async t => {
  const f = fixture(t, { status: 502 })
  await assert.rejects(f.api.generateClipThumbnail(f.directory, 0, { ...f.request, title: 'Inny tytuł' }), /Tytuł klipu zmienił/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.api.generateClipThumbnail(f.directory, 0, f.request), /OpenRouter 502/)
  assert.equal(f.calls.filter(c => c.init?.method === 'POST').length, 1)
  assert.equal(f.exportingClips.size, 0)
  assert.equal(fs.readdirSync(f.directory).filter(name => name.includes('.cover-')).length, 0)
})

test('failed discovery never advertises a stale price or permits paid generation', async t => {
  const f = fixture(t, { offline: true })
  const models = await f.api.listThumbnailModels()
  assert.ok(models.every(m => !m.available && m.priceUsd === null && m.priceKind === 'unknown'))
  await assert.rejects(f.api.generateClipThumbnail(f.directory, 0, f.request), /potwierdzić ceny/)
  assert.equal(f.calls.filter(c => c.init?.method === 'POST').length, 0)
})

test('paid image is retained if library metadata disappears, unsupported images are rejected', async t => {
  const missing = fixture(t, { removeMetadata: true })
  await assert.rejects(missing.api.generateClipThumbnail(missing.directory, 0, missing.request), /Plik został zachowany/)
  assert.equal(fs.readdirSync(missing.directory).filter(name => name.includes('.cover-')).length, 1)
  assert.equal(missing.exportingClips.size, 0)
  const invalid = fixture(t, { invalidImage: true })
  await assert.rejects(invalid.api.generateClipThumbnail(invalid.directory, 0, invalid.request), /nieobsługiwany format/)
  assert.equal(fs.readdirSync(invalid.directory).filter(name => name.includes('.cover-')).length, 0)
})
