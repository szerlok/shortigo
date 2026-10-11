import { rm } from 'fs/promises'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import { parseJobOutput, type JobOutput } from '../shared/job-output'

export function safeRunName(title: string): string {
  // eslint-disable-next-line no-control-regex -- Explicitly reject control characters in paths and request headers.
  let name = title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '')
  // Keep enough room for version suffixes even with multi-byte characters.
  while (Buffer.byteLength(name, 'utf8') > 160) name = Array.from(name).slice(0, -1).join('')
  name = name.replace(/[. ]+$/g, '') || 'Film'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `Film ${name}`
  return name
}

/** Only an actual, direct child of the library with job metadata is mutable. */
export function checkedRunFolder(library: string, directory: string): { directory: string; jobId: string; title: string } {
  if (!isAbsolute(directory)) throw new Error('Nieprawidłowy folder zadania')
  const root = realpathSync(library)
  const stat = lstatSync(directory)
  const canonical = realpathSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(canonical) !== root) throw new Error('Folder zadania musi znajdować się bezpośrednio w bibliotece')
  const read = (name: string): Record<string, unknown> | null => {
    try {
      const path = join(canonical, name), st = lstatSync(path)
      if (st.isSymbolicLink() || !st.isFile() || st.size > 20 * 1024 * 1024) return null
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch { return null }
  }
  const output = read('job_output.json'), record = read('run-history.json')
  const jobId = output?.job_id ?? record?.jobId
  if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new Error('Nie rozpoznano folderu zadania. Nie usunięto żadnych plików.')
  return { directory: canonical, jobId, title: String(output?.source_video_title ?? record?.sourceLabel ?? basename(canonical)) }
}

/** Move only local artifact references, leaving source URLs and user text alone. */
function relocateUrl(value: unknown, from: string, to: string): unknown {
  if (typeof value !== 'string' || !value.startsWith('file:')) return value
  try {
    const path = fileURLToPath(value)
    let canonical = path
    try { canonical = join(realpathSync(dirname(path)), basename(path)) } catch { /* Missing sidecars keep their lexical path. */ }
    const rel = relative(from, canonical)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return value
    return pathToFileURL(join(to, rel)).href
  } catch { return value }
}

export function renameRunFolder(library: string, directory: string): { directory: string; output: JobOutput; jobId: string } {
  const ctx = checkedRunFolder(library, directory)
  const metadata = join(ctx.directory, 'job_output.json')
  if (lstatSync(metadata).isSymbolicLink() || lstatSync(metadata).size > 20 * 1024 * 1024) throw new Error('Nieprawidłowy plik zadania')
  const original = readFileSync(metadata, 'utf8')
  const raw = JSON.parse(original)
  const current = parseJobOutput(raw)
  if (!current) throw new Error('Nie można odczytać klipów tego zadania')
  const name = safeRunName(current.source_video_title)
  const currentName = basename(ctx.directory)
  if (currentName === name || (currentName.startsWith(name + ' (') && /^\(\d+\)$/.test(currentName.slice(name.length + 1)))) {
    return { directory: ctx.directory, output: current, jobId: ctx.jobId }
  }
  let destination = join(dirname(ctx.directory), name)
  for (let n = 2; ; n++) {
    try { mkdirSync(destination, { mode: 0o700 }); break }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; destination = join(dirname(ctx.directory), `${name} (${n})`) }
  }
  const temporary = join(ctx.directory, `.rename-${randomUUID()}.json`)
  let moved = false
  try {
    for (const key of ['transcript_url', 'plan_url', 'edit_source_url']) raw[key] = relocateUrl(raw[key], ctx.directory, destination)
    for (const clip of raw.clips) for (const key of ['s3_url', 'title_base_url', 'music_base_url', 'subtitle_url', 'thumbnail_url']) clip[key] = relocateUrl(clip[key], ctx.directory, destination)
    const output = parseJobOutput(raw)
    if (!output) throw new Error('Nieprawidłowe dane po zmianie nazwy')
    writeFileSync(temporary, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, metadata)
    try { renameSync(ctx.directory, destination); moved = true }
    catch (e) { writeFileSync(metadata, original, 'utf8'); throw e }
    return { directory: destination, output, jobId: ctx.jobId }
  } finally {
    if (!moved) { try { rmdirSync(destination) } catch { /* Never remove someone else's nonempty directory. */ } }
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export async function deleteRunFolder(library: string, directory: string): Promise<string> {
  const ctx = checkedRunFolder(library, directory)
  await rm(ctx.directory, { recursive: true, force: false })
  return ctx.jobId
}
