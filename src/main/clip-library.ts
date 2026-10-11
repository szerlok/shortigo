import { randomUUID } from 'crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { checkedRunFolder } from './run-folders'
import { parseJobOutput, type JobOutput } from '../shared/job-output'

export function readLibraryClip(library: string, directory: string, index: unknown): ReturnType<typeof checkedRunFolder> & { metadata: string; raw: ReturnType<typeof JSON.parse>; output: JobOutput; clip: JobOutput['clips'][number] } {
  const ctx = checkedRunFolder(library, directory)
  if (!Number.isSafeInteger(index) || (index as number) < 0) throw new Error('Nieprawidłowy klip')
  const metadata = join(ctx.directory, 'job_output.json')
  const stat = lstatSync(metadata)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) throw new Error('Nieprawidłowe dane zadania')
  const raw = JSON.parse(readFileSync(metadata, 'utf8'))
  const output = parseJobOutput(raw)
  const clip = output?.clips.find(c => c.clip_index === index)
  if (!output || !clip) throw new Error('Tego klipu nie ma już w bibliotece')
  return { ...ctx, metadata, raw, output, clip }
}

function saveMetadata(path: string, raw: unknown): JobOutput {
  const output = parseJobOutput(raw)
  if (!output) throw new Error('Nieprawidłowe dane klipów')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
  return output
}

export function setClipFavorite(library: string, directory: string, index: unknown, favorite: unknown): JobOutput {
  if (typeof favorite !== 'boolean') throw new Error('Nieprawidłowa opcja ulubionych')
  const ctx = readLibraryClip(library, directory, index)
  ctx.raw.clips.find((c: { clip_index: number }) => c.clip_index === index).is_favorite = favorite
  return saveMetadata(ctx.metadata, ctx.raw)
}

/** Remove only engine-created files belonging to this clip; retain the shared source. */
export function deleteLibraryClip(library: string, directory: string, index: unknown): JobOutput {
  const ctx = readLibraryClip(library, directory, index)
  const prefix = `clip_${String(index).padStart(2, '0')}`
  const versions = new RegExp(`^${prefix}(?:\\.(?:base\\.mp4|dry\\.mp4|mp4|srt|title\\.json|youtube\\.txt|editor\\.json)|\\.(?:title|range|music|edit)-[0-9a-f-]{36}(?:\\.(?:base|dry))?\\.(?:mp4|srt)|\\.edit-preview-[0-9a-f-]{36}(?:\\.dry)?\\.mp4|\\.asset-[0-9a-f-]{36}\\.(?:mp4|m4v|mov|mkv|webm|avi|png|jpg|jpeg|webp)|\\.music-preview-[0-9a-f-]{36}\\.m4a)$`, 'i')
  const covers = new RegExp(`^${prefix}\\.cover-[0-9a-f-]{36}\\.(?:png|jpg|jpeg|webp)$`, 'i')
  for (const url of [ctx.clip.s3_url, ctx.clip.title_base_url, ctx.clip.music_base_url, ctx.clip.thumbnail_url]) {
    if (!url) continue
    const path = fileURLToPath(url)
    if (realpathSync(dirname(path)) !== ctx.directory || !(versions.test(basename(path)) || covers.test(basename(path)))) {
      throw new Error('Pliki tego klipu mają nietypową lokalizację. Nie usunięto żadnych plików.')
    }
  }
  const files = readdirSync(ctx.directory).filter(name => versions.test(name) || covers.test(name))
  const staging = join(ctx.directory, `.delete-clip-${randomUUID()}`)
  mkdirSync(staging, { mode: 0o700 })
  const moved: string[] = []
  let committed = false
  try {
    for (const name of files) {
      const path = join(ctx.directory, name)
      if (lstatSync(path).isDirectory()) throw new Error('Nieprawidłowy plik klipu')
      renameSync(path, join(staging, name))
      moved.push(name)
    }
    ctx.raw.clips = ctx.raw.clips.filter((c: { clip_index: number }) => c.clip_index !== index)
    ctx.raw.total_clips = ctx.raw.clips.length
    if (Array.isArray(ctx.raw.metrics?.clip_layouts)) {
      ctx.raw.metrics.clip_layouts = ctx.raw.metrics.clip_layouts.filter((c: { clip_index: number }) => c.clip_index !== index)
    }
    const output = saveMetadata(ctx.metadata, ctx.raw)
    committed = true
    rmSync(staging, { recursive: true })
    return output
  } finally {
    if (!committed) {
      for (const name of moved.reverse()) renameSync(join(staging, name), join(ctx.directory, name))
      rmSync(staging, { recursive: true })
    }
  }
}
