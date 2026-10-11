import { randomUUID } from 'crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { validateEditorProject } from '../shared/clip-editor'
import type { JobOutput } from '../shared/job-output'
import { readLibraryClip } from './clip-library'
import { getJobOutput } from './file-manager'
import { loadSettings } from './settings-store'
import { exportTitle, exportingClips } from './title-editor'

const MAX_PROJECT_BYTES = 64 * 1024

function readProject(path: string): Record<string, unknown> | null {
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const stat = fstatSync(descriptor), current = lstatSync(path)
    if (!stat.isFile() || current.isSymbolicLink() || stat.size > MAX_PROJECT_BYTES ||
        current.dev !== stat.dev || current.ino !== stat.ino || realpathSync(path) !== path) {
      throw new Error('Nieprawidłowy zapis projektu montażu')
    }
    // Bound the actual read as well, even if an external process grows the file.
    const data = Buffer.alloc(MAX_PROJECT_BYTES + 1)
    let length = 0
    while (length < data.length) {
      const read = readSync(descriptor, data, length, data.length - length, null)
      if (!read) break
      length += read
    }
    if (length > MAX_PROJECT_BYTES) throw new Error('Projekt montażu jest zbyt duży')
    const raw = JSON.parse(data.subarray(0, length).toString('utf8'))
    validateEditorProject(raw)
    return raw as Record<string, unknown>
  } finally { closeSync(descriptor) }
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

function syncProjectTitle(path: string, oldTitle: string, title: string): void {
  const project = readProject(path)
  if (!project) return
  let changed = false
  if (project.name === oldTitle || project.name === `${oldTitle} (montaż)`) {
    if (project.name !== title) { project.name = title; changed = true }
  }
  const layer = project.title as Record<string, unknown> | undefined
  if (layer && layer.text !== title) { layer.text = title; changed = true }
  if (changed) atomicWrite(path, project)
}

/** Rename a finished clip and its editable title while retaining any montage draft. */
export async function renameClipTitle(directory: unknown, index: unknown, value: unknown): Promise<JobOutput | null> {
  if (typeof directory !== 'string') throw new Error('Nieprawidłowy folder klipu')
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || value.includes('\0')) {
    throw new Error('Podaj tytuł od 1 do 240 znaków')
  }
  const title = value.trim()
  const library = loadSettings().outputDirectory
  const ctx = readLibraryClip(library, directory, index)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie operacji na tej serii')
  const path = join(ctx.directory, `clip_${String(ctx.clip.clip_index).padStart(2, '0')}.editor.json`)
  const oldTitle = ctx.clip.summary || `Klip ${ctx.clip.clip_index + 1}`
  // Detect malformed or unsafe sidecars before rendering or changing the library.
  readProject(path)
  const sync = (): void => {
    try { syncProjectTitle(path, oldTitle, title) }
    catch {
      throw new Error('Tytuł klipu został zapisany, ale nie udało się zaktualizować zapisanego montażu. Otwórz montaż, sprawdź jego nazwę i tytuł, a następnie zapisz projekt ponownie.')
    }
  }
  if (ctx.clip.title_base_url && ctx.clip.title_edit && ctx.clip.title_edit.text !== title) {
    // exportTitle owns the lock and invokes this callback before releasing it.
    return exportTitle(ctx.directory, ctx.clip.clip_index,
      { name: title, text: title, options: ctx.clip.title_edit.options }, sync)
  }
  exportingClips.add(ctx.directory)
  try {
    // Metadata-only rename supports older clips without a clean title layer.
    const current = readLibraryClip(library, ctx.directory, ctx.clip.clip_index)
    if (current.clip.summary !== title) {
      current.raw.clips.find((clip: { clip_index: number }) => clip.clip_index === ctx.clip.clip_index).summary = title
      atomicWrite(current.metadata, current.raw)
    }
    sync()
    return await getJobOutput(ctx.directory, library)
  } finally { exportingClips.delete(ctx.directory) }
}
