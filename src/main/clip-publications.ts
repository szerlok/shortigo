import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { PostRecord } from '../shared/zernio-posts'
import { clipPublications } from '../shared/clip-publications'
import { readLibraryClip } from './clip-library'

/** Preserve successful sends in the clip manifest, independently of the posts list. */
export function rememberClipPublication(library: string, post: PostRecord): PostRecord {
  const match = /^clip_(\d+)(?:\.(?:title|range|music)-[0-9a-f-]{36})?\.mp4$/i.exec(basename(post.clipPath))
  if (!match) return post // Files outside the library remain in the normal post history.
  const index = Number(match[1])
  const read = (directory: string): ReturnType<typeof readLibraryClip> | null => {
    try {
      const candidate = readLibraryClip(library, directory, index)
      return !post.clipKey || post.clipKey === `${candidate.output.job_id}:${index}` ? candidate : null
    } catch { return null }
  }
  let ctx = read(dirname(post.clipPath))
  // A queued post may finish after its run folder has been renamed.
  if (!ctx && post.clipKey) for (const entry of readdirSync(library, { withFileTypes: true })) {
    if (entry.isDirectory() && (ctx = read(join(library, entry.name)))) break
  }
  if (!ctx) return post
  const key = `${ctx.output.job_id}:${ctx.clip.clip_index}`
  if (post.clipKey && post.clipKey !== key) return post
  const sent = clipPublications(ctx.clip.sent_to ?? [], [post])
  if (JSON.stringify(sent) !== JSON.stringify(ctx.clip.sent_to ?? [])) {
    // Work is synchronous so other metadata writers cannot interleave here.
    const raw = JSON.parse(readFileSync(ctx.metadata, 'utf8'))
    raw.clips.find((c: { clip_index: number }) => c.clip_index === ctx.clip.clip_index).sent_to = sent
    const temporary = join(ctx.directory, `.publication-${randomUUID()}.json`)
    try {
      writeFileSync(temporary, JSON.stringify(raw, null, 2), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, ctx.metadata)
    } finally { rmSync(temporary, { force: true }) }
  }
  return post.clipKey === key ? post : { ...post, clipKey: key }
}
