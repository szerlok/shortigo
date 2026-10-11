import { randomUUID, createHash } from 'crypto'
import { copyFile, readFile, rename, rm, writeFile } from 'fs/promises'
import { constants, lstatSync, realpathSync, statSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { dialog, type BrowserWindow } from 'electron'
import { editorRenderKey, validateEditorProject, type EditorProject } from '../shared/clip-editor'
import { DEFAULT_MUSIC } from '../shared/music'
import { DEFAULT_TITLE } from '../shared/title'
import { readLibraryClip } from './clip-library'
import { getJobOutput } from './file-manager'
import { loadSettings } from './settings-store'
import { authorizeMedia } from './security'
import { exportingClips, runClipWorker } from './title-editor'

const videos = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi'])
const images = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const pendingPreviews = new Map<string, Promise<string>>()
const prefix = (index: number): string => `clip_${String(index).padStart(2, '0')}`
const projectPath = (directory: string, index: number): string => join(directory, `${prefix(index)}.editor.json`)

function context(directory: unknown, index: unknown): ReturnType<typeof readLibraryClip> {
  if (typeof directory !== 'string') throw new Error('Nieprawidłowy folder klipu')
  return readLibraryClip(loadSettings().outputDirectory, directory, index)
}

function checkedProject(ctx: ReturnType<typeof context>, value: unknown): EditorProject {
  const project = validateEditorProject(value)
  for (const file of [...project.segments.map(s => s.file), ...project.overlays.map(o => o.file)]) {
    if (!file.startsWith(`${prefix(ctx.clip.clip_index)}.`)) throw new Error('Plik nie należy do tego klipu')
    const path = join(ctx.directory, file)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Nieprawidłowy plik projektu')
  }
  return project
}

export async function loadClipProject(directory: unknown, index: unknown): Promise<EditorProject> {
  const ctx = context(directory, index)
  const path = projectPath(ctx.directory, ctx.clip.clip_index)
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Nieprawidłowy projekt edytora')
    const saved = checkedProject(ctx, JSON.parse(await readFile(path, 'utf8')))
    return { ...saved,
      ...(ctx.clip.title_base_url ? { title: ctx.clip.title_edit ?? saved.title } : { title: undefined }) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Start from the version without the old title or background music, so both remain editable after export.
  const sourceUrl = ctx.clip.title_base_url || (ctx.clip.music_edit?.enabled && ctx.clip.music_base_url ? ctx.clip.music_base_url : ctx.clip.s3_url)
  const source = fileURLToPath(sourceUrl)
  if (dirname(realpathSync(source)) !== ctx.directory) throw new Error('Plik klipu jest poza zadaniem')
  return checkedProject(ctx, { version: 1,
    segments: [{ id: randomUUID(), file: basename(source), startMs: 0, endMs: ctx.clip.duration_ms }],
    overlays: [], music: ctx.clip.music_edit ?? DEFAULT_MUSIC,
    ...(ctx.clip.title_base_url && ctx.clip.title_edit ? { title: ctx.clip.title_edit } : {}) })
}

export async function saveClipProject(directory: unknown, index: unknown, value: unknown): Promise<EditorProject> {
  const ctx = context(directory, index)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie eksportu')
  const project = checkedProject(ctx, value)
  const path = projectPath(ctx.directory, ctx.clip.clip_index)
  const temporary = join(ctx.directory, `.${prefix(ctx.clip.clip_index)}.editor-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(project, null, 2), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
  return project
}

export async function importClipAsset(window: BrowserWindow | null, directory: unknown, index: unknown, kind: unknown): Promise<{ file: string; durationMs: number } | null> {
  const ctx = context(directory, index)
  if (kind !== 'video' && kind !== 'image') throw new Error('Nieprawidłowy rodzaj pliku')
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie eksportu')
  const filters = kind === 'image' ? [{ name: 'Grafiki', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    : [{ name: 'Filmy', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'] }]
  const selection = window ? await dialog.showOpenDialog(window, { properties: ['openFile'], filters })
    : await dialog.showOpenDialog({ properties: ['openFile'], filters })
  if (selection.canceled || !selection.filePaths[0]) return null
  const original = selection.filePaths[0]
  const stat = lstatSync(original)
  const extension = extname(original).toLowerCase()
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 ** 3 ||
      !(kind === 'image' ? images : videos).has(extension)) throw new Error('Wybierz poprawny plik do 4 GB')
  const file = `${prefix(ctx.clip.clip_index)}.asset-${randomUUID()}${extension}`
  const destination = join(ctx.directory, file)
  try {
    await copyFile(original, destination)
    const copied = statSync(destination)
    if (copied.size !== stat.size) throw new Error('Nie udało się skopiować całego pliku')
    let durationMs = 0
    if (kind === 'video') {
      const probe = await runClipWorker({ action: 'probe', source: destination }, false, 'clip_timeline') as { duration_ms: number }
      durationMs = Math.round(probe.duration_ms)
      if (!Number.isFinite(durationMs) || durationMs < 100 || durationMs > 12 * 60 * 60 * 1000) throw new Error('Film ma nieprawidłową długość')
    }
    authorizeMedia(destination)
    return { file, durationMs }
  } catch (error) { await rm(destination, { force: true }); throw error }
}

async function render(ctx: ReturnType<typeof context>, project: EditorProject, destination: string, preview: boolean): Promise<{ base: string; dry: string; durationMs: number }> {
  const base = destination.replace(/\.mp4$/, '.base.mp4')
  const dry = project.music.enabled ? destination.replace(/\.mp4$/, '.dry.mp4') : destination
  const result = await runClipWorker({ action: 'render', directory: ctx.directory, destination: base, project, preview }, true, 'clip_timeline') as { duration_ms: number }
  const title = project.title ?? { text: '', options: { ...DEFAULT_TITLE, enabled: false } }
  await runClipWorker({ action: 'export', source: base, destination: dry, text: title.text, options: title.options }, true)
  if (project.music.enabled) await runClipWorker({ action: 'export', source: dry, destination, settings: project.music }, true, 'music')
  authorizeMedia(destination)
  return { base, dry, durationMs: result.duration_ms }
}

export async function previewClipProject(directory: unknown, index: unknown, value: unknown): Promise<string> {
  const ctx = context(directory, index)
  const project = checkedProject(ctx, value)
  const hash = createHash('sha256').update(editorRenderKey(project)).digest('hex').slice(0, 36)
  const destination = join(ctx.directory, `${prefix(ctx.clip.clip_index)}.edit-preview-${hash}.mp4`)
  const pending = pendingPreviews.get(destination)
  if (pending) return pending
  try { if (statSync(destination).size > 0) return authorizeMedia(destination) } catch { /* Cache miss. */ }
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie eksportu lub podglądu')
  exportingClips.add(ctx.directory)
  const task = (async () => {
    const temporary = join(ctx.directory, `${prefix(ctx.clip.clip_index)}.edit-preview-${randomUUID()}.mp4`)
    try {
      const { base, dry } = await render(ctx, project, temporary, true)
      await rename(temporary, destination)
      await rm(base, { force: true })
      if (dry !== temporary) await rm(dry, { force: true })
      return authorizeMedia(destination)
    } finally {
      await rm(temporary, { force: true })
      await rm(temporary.replace(/\.mp4$/, '.base.mp4'), { force: true })
      await rm(temporary.replace(/\.mp4$/, '.dry.mp4'), { force: true })
      pendingPreviews.delete(destination)
      exportingClips.delete(ctx.directory)
    }
  })()
  pendingPreviews.set(destination, task)
  return task
}

async function copyProjectAssets(directory: string, newIndex: number, project: EditorProject): Promise<{ project: EditorProject; files: string[] }> {
  const copied: string[] = []
  const names = new Map<string, string>()
  try {
    for (const file of new Set([...project.segments.map(s => s.file), ...project.overlays.map(o => o.file)])) {
      const name = `${prefix(newIndex)}.asset-${randomUUID()}${extname(file).toLowerCase()}`
      const target = join(directory, name)
      await copyFile(join(directory, file), target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
      copied.push(target)
      names.set(file, name)
    }
    return { project: { ...project,
      segments: project.segments.map(s => ({ ...s, file: names.get(s.file)! })),
      overlays: project.overlays.map(o => ({ ...o, file: names.get(o.file)! })) }, files: copied }
  } catch (error) {
    await Promise.all(copied.map(path => rm(path, { force: true })))
    throw error
  }
}

export async function exportClipProject(directory: unknown, index: unknown, value: unknown): ReturnType<typeof getJobOutput> {
  const ctx = context(directory, index)
  const project = checkedProject(ctx, value)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie poprzedniego eksportu')
  if (ctx.output.clips.length >= 1000) throw new Error('To zadanie ma już maksymalną liczbę klipów')
  exportingClips.add(ctx.directory)
  const id = randomUUID()
  const newIndex = Math.max(...ctx.output.clips.map(c => c.clip_index)) + 1
  const destination = join(ctx.directory, `${prefix(newIndex)}.edit-${id}.mp4`)
  const temporary = join(ctx.directory, `.${prefix(newIndex)}.edit-${id}.json`)
  const projectTemporary = join(ctx.directory, `.${prefix(newIndex)}.editor-${id}.tmp`)
  const newProjectPath = projectPath(ctx.directory, newIndex)
  let committed = false
  let projectCreated = false
  let assets: string[] = []
  const base = destination.replace(/\.mp4$/, '.base.mp4')
  let dry = project.music.enabled ? destination.replace(/\.mp4$/, '.dry.mp4') : destination
  try {
    const result = await render(ctx, project, destination, false)
    dry = result.dry
    const current = context(ctx.directory, index)
    if (current.clip.s3_url !== ctx.clip.s3_url) throw new Error('Klip zmienił się podczas eksportu')
    if (current.raw.clips.some((c: { clip_index: number }) => c.clip_index === newIndex)) throw new Error('Biblioteka zmieniła się podczas eksportu')
    const cloned = await copyProjectAssets(ctx.directory, newIndex, project)
    assets = cloned.files
    const original = current.raw.clips.find((c: { clip_index: number }) => c.clip_index === index)
    const rawClip = { ...original, clip_index: newIndex, summary: project.name?.trim() || `${ctx.clip.summary || `Klip ${index}`} (montaż)`,
      is_favorite: ctx.clip.is_favorite === true, sent_to: [], start_time_ms: 0, end_time_ms: result.durationMs,
      s3_url: pathToFileURL(destination).href,
      music_base_url: pathToFileURL(dry).href, music_edit: project.music,
      duration_ms: result.durationMs, subtitle_url: null, thumbnail_url: null, thumbnail_edit: null,
      title_base_url: project.title ? pathToFileURL(base).href : null,
      title_edit: project.title ?? null }
    delete rawClip.library_key
    current.raw.clips.push(rawClip)
    current.raw.total_clips = current.raw.clips.length
    await writeFile(projectTemporary, JSON.stringify(cloned.project, null, 2), { flag: 'wx', mode: 0o600 })
    await writeFile(temporary, JSON.stringify(current.raw, null, 2), { flag: 'wx', mode: 0o600 })
    await rename(projectTemporary, newProjectPath)
    projectCreated = true
    await rename(temporary, current.metadata)
    committed = true
    return await getJobOutput(ctx.directory, loadSettings().outputDirectory)
  } finally {
    exportingClips.delete(ctx.directory)
    await rm(temporary, { force: true })
    await rm(projectTemporary, { force: true })
    if (!committed) await Promise.all([destination, base, dry, ...assets, ...(projectCreated ? [newProjectPath] : [])].map(path => rm(path, { force: true })))
  }
}
