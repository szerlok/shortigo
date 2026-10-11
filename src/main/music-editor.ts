import { randomUUID } from 'crypto'
import { realpathSync } from 'fs'
import { rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { validateMusic, type MusicTrack } from '../shared/music'
import { readLibraryClip } from './clip-library'
import { getJobOutput } from './file-manager'
import { loadSettings } from './settings-store'
import { assertAbsolutePath, assertMediaPath, authorizeMedia } from './security'
import { exportingClips, runClipWorker } from './title-editor'

const previews = new Set<string>()
export async function musicTracks(): Promise<MusicTrack[]> {
  return await runClipWorker({ action: 'tracks' }, false, 'music') as MusicTrack[]
}
export async function clearMusicPreview(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !previews.delete(path)) return
  await rm(path, { force: true })
}

export async function editMusic(directory: unknown, index: unknown, value: unknown, preview: boolean): Promise<string | Awaited<ReturnType<typeof getJobOutput>>> {
  assertAbsolutePath(directory)
  const settings = validateMusic(value)
  const library = loadSettings().outputDirectory
  const ctx = readLibraryClip(library, directory, index)
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie operacji na tej serii')
  if (ctx.clip.music_edit?.enabled && !ctx.clip.music_base_url) throw new Error('Brakuje wersji klipu bez muzyki')
  const sourceUrl = ctx.clip.music_base_url || ctx.clip.s3_url
  const source = fileURLToPath(sourceUrl)
  assertMediaPath(source, library)
  if (realpathSync(source) !== source || dirname(source) !== ctx.directory) throw new Error('Nieprawidłowe źródło klipu')
  const id = randomUUID()
  const destination = join(ctx.directory, `clip_${String(index).padStart(2, '0')}.music-${preview ? 'preview-' : ''}${id}.${preview ? 'm4a' : 'mp4'}`)
  const temporary = join(ctx.directory, `.music-${id}.json`)
  exportingClips.add(ctx.directory)
  let committed = false
  try {
    await runClipWorker({ action: preview ? 'preview' : 'export', source, destination, settings }, true, 'music')
    if (preview) {
      previews.add(destination)
      authorizeMedia(destination)
      committed = true
      return destination
    }
    const current = readLibraryClip(library, ctx.directory, index)
    if (current.clip.s3_url !== ctx.clip.s3_url) throw new Error('Klip zmienił się podczas zapisywania')
    const clip = current.raw.clips.find((c: { clip_index: number }) => c.clip_index === index)
    Object.assign(clip, { s3_url: pathToFileURL(destination).href, music_base_url: sourceUrl, music_edit: settings })
    await writeFile(temporary, JSON.stringify(current.raw, null, 2), { flag: 'wx', mode: 0o600 })
    await rename(temporary, current.metadata)
    committed = true
    authorizeMedia(destination)
    return await getJobOutput(ctx.directory, library)
  } finally {
    exportingClips.delete(ctx.directory)
    await rm(temporary, { force: true })
    if (!committed) await rm(destination, { force: true })
  }
}
