const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const bundled = buildSync({
  stdin: {
    contents: `export { FormatStep, JobForm, parseTrimRange } from './src/renderer/components/JobForm';
      export { SetupCard } from './src/renderer/components/SetupCard';
      export { useSettingsStore } from './src/renderer/store/use-settings-store';
      export { isValidSourceLink } from './src/renderer/components/SourcePicker';
      export { framingProblem, sourceAnalysisNotice } from './src/renderer/components/ClipList';
      export { TitlePresetPicker } from './src/renderer/components/TitlePresetPicker';
      export { TITLE_PRESETS, applyTitlePreset, selectedTitlePreset } from './src/shared/title-presets';
      export { DEFAULT_TITLE, validateTitleOptions } from './src/shared/title';
      export { parseJobOutput } from './src/shared/job-output';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  define: { __APP_VERSION__: JSON.stringify(require('../package.json').version) },
  jsx: 'automatic',
  write: false
}).outputFiles[0].text

const form = { exports: {} }
new Function('module', 'exports', 'require', bundled)(form, form.exports, require)
const { FormatStep, JobForm, isValidSourceLink, parseTrimRange, framingProblem, sourceAnalysisNotice, parseJobOutput } = form.exports

test('setup needs only OpenRouter for clipping', () => {
  const { SetupCard, useSettingsStore } = form.exports
  useSettingsStore.setState({ openrouterConfigured: false })
  const setup = renderToStaticMarkup(React.createElement(SetupCard, { onOpenSettings() {} }))
  assert.match(setup, /OpenRouter/)
  assert.doesNotMatch(setup, /ElevenLabs/)
  useSettingsStore.setState({ openrouterConfigured: false, toolStatus: null })
})

test('source picker accepts full HTTP(S) links and rejects malformed or credentialed links', () => {
  assert.equal(isValidSourceLink(' https://www.youtube.com/watch?v=abc '), true)
  assert.equal(isValidSourceLink('http://example.com/video.mp4'), true)
  assert.equal(isValidSourceLink('https://'), false)
  assert.equal(isValidSourceLink('https://user:pass@example.com/video'), false)
  assert.equal(isValidSourceLink('file:///tmp/video.mp4'), false)
})

test('trim validation matches main process bounds, including an end at zero', () => {
  assert.equal(parseTrimRange(true, '', '0').error, "Koniec musi być później niż początek.")
  assert.equal(parseTrimRange(true, '1:30', '90').error, "Koniec musi być później niż początek.")
  assert.deepEqual(parseTrimRange(true, '', '1:30'), { start: null, end: 90, error: null })
  assert.deepEqual(parseTrimRange(false, 'oops', '0'), { start: null, end: null, error: null })
})

test('the wizard opens on the video step with the steps listed in order', () => {
  const html = renderToStaticMarkup(React.createElement(JobForm, { onSubmit() {} }))
  const labels = [...html.matchAll(/aria-label="Kroki tworzenia klipów">(.*?)<\/nav>/gs)][0]?.[1] ?? ''
  const order = ["Film", 'Format', "Klipy", "Napisy", "Podsumowanie"].map((label) => labels.indexOf(label))
  assert.ok(order.every((index, i) => index > -1 && (i === 0 || index > order[i - 1])))
  assert.match(html, /aria-current="step"[^>]*>.*?Film/s)
  assert.match(html, /Wybierz film/)
})

test('format and framing radio groups each expose one keyboard tab stop', () => {
  const draft = { aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight' }
  const html = renderToStaticMarkup(React.createElement(FormatStep, { draft, update() {} }))
  for (const label of ['Format', "Kadrowanie"]) {
    const group = html.match(new RegExp(`role="radiogroup" aria-label="${label}">(.*?)<\\/div>`, 's'))?.[1]
    assert.ok(group)
    assert.equal((group.match(/tabindex="0"/g) ?? []).length, 1)
  }
})

test('clip list explains when smart framing intentionally keeps the whole frame', () => {
  const clip = (index) => ({
    clip_index: index, s3_url: `/tmp/clip-${index}.mp4`, duration_ms: 5000,
    start_time_ms: index * 5000, end_time_ms: (index + 1) * 5000, virality_score: 0.5
  })
  const output = parseJobOutput({
    clips: [clip(0), clip(1)],
    metrics: { clip_layouts: [
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 9, framing_status: 'whole_frame_auto' }
    ] }
  })
  assert.ok(output)
  assert.match(framingProblem(output, true), /cały kadr w klipach: 1/)
  assert.equal(framingProblem(output, false), null)
  const classic = parseJobOutput({ clips: [clip(0)], metrics: {
    smart_framing_available: false, requested_settings: { aspect_ratio: '9:16', layout_style: 'fit' }
  } })
  assert.ok(classic)
  assert.equal(framingProblem(classic, true), null)
})

test('visual-only runs disclose unavailable captions and preserve analysis status', () => {
  const output = parseJobOutput({ clips: [], metrics: {
    transcription_status: 'no_speech', planning_source: 'visual', visual_frame_count: 12,
    captions_status: 'unavailable_without_transcript'
  } })
  assert.ok(output)
  assert.equal(output.metrics.visual_frame_count, 12)
  assert.equal(output.metrics.captions_status, 'unavailable_without_transcript')
  assert.match(sourceAnalysisNotice(output), /Nie wykryto mowy/)
})


test('ten title presets are selectable, validate and retain timing and position', () => {
  const { TitlePresetPicker, TITLE_PRESETS, applyTitlePreset, selectedTitlePreset, DEFAULT_TITLE, validateTitleOptions } = form.exports
  assert.equal(TITLE_PRESETS.length, 10)
  assert.equal(new Set(TITLE_PRESETS.map(p => p.id)).size, 10)
  assert.equal(new Set(TITLE_PRESETS.map(p => JSON.stringify(p.visual))).size, 10)
  const current = { ...DEFAULT_TITLE, mode: 'range', start: 2, end: 5, position: 'manual', y: 22 }
  for (const preset of TITLE_PRESETS) {
    const value = applyTitlePreset(preset.id, current)
    assert.deepEqual(validateTitleOptions(value), value)
    assert.equal(selectedTitlePreset(value), preset.id)
    assert.equal(value.start, 2)
    assert.equal(value.end, 5)
    assert.equal(value.y, 22)
    const html = renderToStaticMarkup(React.createElement(TitlePresetPicker, { value, onChange() {} }))
    assert.equal((html.match(/role="radio"/g) ?? []).length, 10)
    assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 2) // selected preset + enabled switch
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1)
    assert.match(html, /font-family:Title/)
    assert.doesNotMatch(html, /<select|type="color"/)
  }
  const legacy = { ...DEFAULT_TITLE }; delete legacy.font; delete legacy.radius; delete legacy.uppercase
  assert.equal(validateTitleOptions(legacy).font, 'montserrat')
})
