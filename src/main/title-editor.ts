import type { ClipArtifact, JobOutput } from '../shared/job-output'
import { spawn } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { readFile, writeFile, rename, rm } from 'fs/promises'
import { delimiter, dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import { getJobOutput } from './file-manager'
import { loadSettings } from './settings-store'
import { assertAbsolutePath, assertMediaPath, authorizeMedia, isWithinDirectory } from './security'
import { getEnginePath, resolvePythonPath } from './pipeline-runner'
import { resolveBinary } from './tools'
import { validateTitleOptions, type TitleEdit, type TitlePreview } from '../shared/title'

const processes = new Set<() => void>()
export function stopTitleExports(): void { for (const stop of processes) stop() }
export const exportingClips = new Set<string>()
function validateEdit(value: unknown): TitleEdit {
  if (!value || typeof value !== 'object') throw new Error('Nieprawidłowy tytuł')
  const edit = value as TitleEdit
  if (typeof edit.text !== 'string' || edit.text.length > 240 || edit.text.includes('\0') ||
      typeof edit.name !== 'string' || !edit.name.trim() || edit.name.length > 240 || edit.name.includes('\0')) throw new Error('Podaj nazwę i tytuł do 240 znaków')
  if (edit.options?.enabled && !edit.text.trim()) throw new Error('Wpisz tytuł lub wyłącz jego wyświetlanie')
  return { text: edit.text.trim(), name: edit.name.trim(), options: validateTitleOptions(edit.options) }
}
async function context(outputDir: unknown, index: unknown): Promise<{ directory: string; base: string; clip: ClipArtifact }> {
  assertAbsolutePath(outputDir)
  const library = loadSettings().outputDirectory
  if (!isWithinDirectory(outputDir, library) || !Number.isSafeInteger(index)) throw new Error('Klip poza biblioteką')
  const directory = realpathSync(outputDir)
  const output = await getJobOutput(directory, library)
  const clip = output?.clips.find(c => c.clip_index === index)
  if (!clip?.title_base_url || !clip.title_edit) throw new Error('Ten klip nie ma wersji bez tytułu. Wygeneruj go ponownie, aby korzystać z edytora.')
  const base = fileURLToPath(clip.title_base_url)
  assertMediaPath(base, library)
  if (dirname(realpathSync(base)) !== directory) throw new Error('Nieprawidłowa wersja bazowa')
  authorizeMedia(base)
  return { directory, base, clip }
}
export function runClipWorker(request: object, long = false, module: 'title_overlay' | 'range_editor' | 'range_preview' | 'music' | 'clip_timeline' = 'title_overlay'): Promise<unknown> {
  const engine = getEnginePath()
  const python = resolvePythonPath(engine, loadSettings().pythonPath)
  const ffmpeg = resolveBinary('ffmpeg')
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', `clip_engine.services.${module}`], {
      cwd: engine,
      env: { ...process.env, PYTHONPATH: engine, PATH: `${dirname(ffmpeg)}${delimiter}${process.env.PATH || ''}` },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    })
    let stdout = '', stderr = '', failed = false
    const stop = (): void => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* Already exited. */ }
    }
    processes.add(stop)
    const timer = setTimeout(() => { failed = true; stop(); reject(new Error('Przekroczono czas eksportu klipu')) }, long ? 60 * 60 * 1000 : 20000)
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { failed = true; stop(); reject(new Error('Podgląd jest zbyt duży')) } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', error => { processes.delete(stop); clearTimeout(timer); reject(error) })
    child.on('close', code => {
      processes.delete(stop)
      clearTimeout(timer)
      if (failed) return
      if (code !== 0) { reject(new Error(stderr.includes('Title starts after') ? 'Tytuł zaczyna się po końcu klipu' : 'Nie udało się przygotować klipu. Sprawdź pliki źródłowe i narzędzia w ustawieniach.')); return }
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('Nieprawidłowa odpowiedź edytora')) }
    })
    child.stdin.on('error', () => { /* Child exit is handled above. */ })
    child.stdin.end(JSON.stringify(request))
  })
}
export async function previewTitle(outputDir: unknown, index: unknown, value: unknown): Promise<TitlePreview & { base: string }> {
  const edit = validateEdit(value)
  const ctx = await context(outputDir, index)
  const preview = await runClipWorker({ action: 'preview', source: ctx.base, ...edit }) as TitlePreview
  return { ...preview, base: ctx.base }
}
export async function exportTitle(outputDir: unknown, index: unknown, value: unknown, afterCommit?: (directory: string) => void): Promise<JobOutput | null> {
  const edit = validateEdit(value)
  const ctx = await context(outputDir, index)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie poprzedniego eksportu z tej serii')
  exportingClips.add(ctx.directory)
  const id = randomUUID()
  const destination = join(ctx.directory, `clip_${String(index).padStart(2, '0')}.title-${id}.mp4`)
  const dry = destination.replace(/\.mp4$/, '.dry.mp4')
  const hasMusic = ctx.clip.music_edit?.enabled === true
  const metadata = join(ctx.directory, 'job_output.json')
  const temporary = join(ctx.directory, `.title-${id}.json`)
  let committed = false
  try {
    await runClipWorker({ action: 'export', source: ctx.base, destination: hasMusic ? dry : destination, ...edit }, true)
    if (hasMusic) await runClipWorker({ action: 'export', source: dry, destination, settings: ctx.clip.music_edit }, true, 'music')
    // Reload after rendering to preserve independent metadata changes.
    if (!isWithinDirectory(metadata, ctx.directory) || realpathSync(metadata) !== metadata) throw new Error('Nieprawidłowy plik biblioteki')
    const raw = JSON.parse(await readFile(metadata, 'utf8'))
    const clip = raw.clips.find((c: { clip_index: number }) => c.clip_index === index)
    if (!clip || clip.title_base_url !== ctx.clip.title_base_url) throw new Error('Klip zmienił się podczas eksportu')
    clip.summary = edit.name
    clip.title_edit = { text: edit.text, options: edit.options }
    clip.s3_url = pathToFileURL(destination).href
    clip.music_base_url = pathToFileURL(hasMusic ? dry : destination).href
    await writeFile(temporary, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o600 })
    await rename(temporary, metadata)
    committed = true
    afterCommit?.(ctx.directory)
    authorizeMedia(destination)
    return await getJobOutput(ctx.directory, loadSettings().outputDirectory)
  } finally {
    exportingClips.delete(ctx.directory)
    if (existsSync(temporary)) await rm(temporary, { force: true })
    if (!committed) await Promise.all([destination, dry].map(path => rm(path, { force: true })))
  }
}
