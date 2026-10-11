import { createHash, randomUUID } from 'crypto'
import { realpathSync, statSync } from 'fs'
import { readFile, writeFile, rename, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { JobOutput } from '../shared/job-output'
import { validateClipRange, type RangeContext } from '../shared/clip-range'
import { getJobOutput } from './file-manager'
import { loadSettings } from './settings-store'
import { assertAbsolutePath, assertMediaPath, authorizeMedia, isWithinDirectory } from './security'
import { exportingClips, runClipWorker } from './title-editor'

async function context(outputDir: unknown, index: unknown): Promise<{ directory: string; source: string; clip: JobOutput['clips'][number]; output: JobOutput }> {
  assertAbsolutePath(outputDir)
  const library = loadSettings().outputDirectory
  if (!isWithinDirectory(outputDir, library) || !Number.isSafeInteger(index)) throw new Error('Klip poza biblioteką')
  const directory = realpathSync(outputDir)
  const output = await getJobOutput(directory, library)
  const clip = output?.clips.find(c => c.clip_index === index)
  if (!output?.edit_source_url || !clip?.title_edit) throw new Error('Brak źródła do poprawek. Przy tworzeniu nowej serii włącz „Zachowaj źródło do poprawek”.')
  const source = fileURLToPath(output.edit_source_url)
  assertMediaPath(source, library)
  if (dirname(realpathSync(source)) !== directory || realpathSync(source) !== source) throw new Error('Nieprawidłowe źródło')
  for (const name of ['editing.json', 'transcript.json', 'job_output.json']) {
    const path = join(directory, name)
    if (realpathSync(path) !== path || !statSync(path).isFile() || statSync(path).size > 64 * 1024 * 1024) throw new Error('Nieprawidłowe dane do poprawek')
  }
  authorizeMedia(source)
  return { directory, source, clip, output }
}

export async function rangeContext(outputDir: unknown, index: unknown): Promise<RangeContext> {
  const ctx = await context(outputDir, index)
  const result = await runClipWorker({ action: 'context', directory: ctx.directory, source: ctx.source }, false, 'range_editor') as Omit<RangeContext, 'range'>
  return { ...result, range: { startMs: ctx.clip.start_time_ms, endMs: ctx.clip.end_time_ms } }
}

// One conversion per source, shared across all clip editors in the run.
const previews = new Map<string, Promise<string>>()
export function isPreparingRangePreview(directory: string): boolean {
  return [...previews.keys()].some(path => dirname(path) === directory)
}
export async function rangePreview(outputDir: unknown, index: unknown, rebuild: unknown = false): Promise<string> {
  if (typeof rebuild !== 'boolean') throw new Error('Nieprawidłowa opcja podglądu')
  const ctx = await context(outputDir, index)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie operacji na tym zadaniu')
  const file = statSync(ctx.source)
  const key = createHash('sha256').update(JSON.stringify([ctx.source, file.dev, file.ino, file.size, file.mtimeMs, 'preview-v1'])).digest('hex').slice(0, 24)
  const destination = join(ctx.directory, `source.preview-${key}.mp4`)
  const pending = previews.get(destination)
  if (pending) return pending
  if (!rebuild) {
    try {
      if (realpathSync(destination) === destination && statSync(destination).size > 0) return authorizeMedia(destination)
    } catch { /* Preview has not been generated yet. */ }
  }
  const task = (async () => {
    try {
      await runClipWorker({ source: ctx.source, destination }, true, 'range_preview')
      return authorizeMedia(destination)
    } catch {
      throw new Error('Nie udało się przygotować podglądu. Sprawdź wolne miejsce na dysku i spróbuj ponownie.')
    } finally { previews.delete(destination) }
  })()
  previews.set(destination, task)
  return task
}

type RenderedRange = {
  duration_ms: number; layout_type: string; render_fallback: string | null
  removed_ms: number; shots: unknown[]; chapters: unknown; has_subtitles: boolean
}

export async function exportRange(outputDir: unknown, index: unknown, value: unknown): Promise<JobOutput | null> {
  const ctx = await context(outputDir, index)
  // Exact source bounds are also verified by ffprobe in the worker.
  const range = validateClipRange(value, Number.MAX_SAFE_INTEGER)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie poprzedniego eksportu z tej serii')
  exportingClips.add(ctx.directory)
  const stem = `clip_${String(index).padStart(2, '0')}.range-${randomUUID()}`
  const base = join(ctx.directory, stem + '.base.mp4')
  const destination = join(ctx.directory, stem + '.mp4')
  const dry = join(ctx.directory, stem + '.dry.mp4')
  const hasMusic = ctx.clip.music_edit?.enabled === true
  const subtitle = join(ctx.directory, stem + '.base.srt')
  const metadata = join(ctx.directory, 'job_output.json')
  const temporary = join(ctx.directory, `.${stem}.json`)
  let committed = false
  try {
    const rendered = await runClipWorker({ action: 'export', directory: ctx.directory, source: ctx.source,
      index, ...range, base, destination: hasMusic ? dry : destination, title: ctx.clip.title_edit }, true, 'range_editor') as RenderedRange
    if (hasMusic) await runClipWorker({ action: 'export', source: dry, destination, settings: ctx.clip.music_edit }, true, 'music')
    if (!Number.isFinite(rendered.duration_ms) || rendered.duration_ms <= 0) throw new Error('Nieprawidłowa długość zapisanego klipu')
    if (realpathSync(metadata) !== metadata) throw new Error('Nieprawidłowy plik biblioteki')
    const raw = JSON.parse(await readFile(metadata, 'utf8'))
    const clip = raw.clips.find((c: { clip_index: number }) => c.clip_index === index)
    if (!clip || clip.s3_url !== ctx.clip.s3_url || raw.edit_source_url !== ctx.output.edit_source_url) throw new Error('Klip zmienił się podczas eksportu')
    Object.assign(clip, {
      music_base_url: pathToFileURL(hasMusic ? dry : destination).href,
      s3_url: pathToFileURL(destination).href, title_base_url: pathToFileURL(base).href,
      start_time_ms: range.startMs, end_time_ms: range.endMs, duration_ms: rendered.duration_ms,
      layout_type: rendered.layout_type, render_fallback: rendered.render_fallback,
      chapters: rendered.chapters, subtitle_url: rendered.has_subtitles ? pathToFileURL(subtitle).href : null
    })
    // Do not keep obsolete framing information after a local re-render.
    if (Array.isArray(raw.metrics?.clip_layouts)) {
      raw.metrics.clip_layouts = raw.metrics.clip_layouts.filter((entry: { clip_index: number }) => entry.clip_index !== index)
      raw.metrics.clip_layouts.push({ clip_index: index, layout_type: rendered.layout_type,
        render_fallback: rendered.render_fallback, shots: rendered.shots, pacing_removed_ms: rendered.removed_ms,
        framing_status: rendered.render_fallback ? 'fallback' : rendered.layout_type === 'fit' ? 'whole_frame_auto' : 'smart' })
    }
    await writeFile(temporary, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o600 })
    await rename(temporary, metadata)
    committed = true
    authorizeMedia(base)
    authorizeMedia(destination)
    return await getJobOutput(ctx.directory, loadSettings().outputDirectory)
  } finally {
    exportingClips.delete(ctx.directory)
    await rm(temporary, { force: true })
    if (!committed) await Promise.all([base, destination, dry, subtitle].map(path => rm(path, { force: true })))
  }
}
