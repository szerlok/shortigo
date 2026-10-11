import type { PostRecord, PostRecordTarget } from './zernio-posts'
import { clipFilePath } from './media-path'

export interface ClipPublication {
  platform: string
  accountId: string
  sentAt: string
  inbox: boolean
}

export function parseClipPublications(value: unknown): ClipPublication[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).flatMap(v => {
    if (!v || typeof v !== 'object' || typeof v.platform !== 'string' || v.platform.length > 40 ||
        typeof v.accountId !== 'string' || v.accountId.length > 200 || typeof v.sentAt !== 'string' ||
        !Number.isFinite(Date.parse(v.sentAt))) return []
    return [{ platform: v.platform, accountId: v.accountId, sentAt: v.sentAt, inbox: v.inbox === true }]
  })
}

export function successfulPostTargets(post: PostRecord): PostRecordTarget[] {
  return post.targets.filter(t => t.status === 'published' ||
    post.status === 'published' && t.status !== 'failed' && t.status !== 'cancelled')
}

// Versions exported by the title, range and music editors belong to one clip.
function clipFamily(value: string): string {
  return clipFilePath(value).replace(/\\/g, '/').replace(/(\/clip_\d+)(?:\.(?:title|range|music)-[0-9a-f-]{36})?\.mp4$/i, '$1')
}

export function matchingClipPosts(posts: PostRecord[], path: string, key?: string): PostRecord[] {
  return posts.filter(p => key && p.clipKey ? p.clipKey === key : clipFamily(p.clipPath) === clipFamily(path))
}

export function clipPublications(saved: ClipPublication[], posts: PostRecord[]): ClipPublication[] {
  const result = new Map(saved.map(p => [`${p.platform}:${p.accountId}`, p]))
  for (const post of posts) for (const target of successfulPostTargets(post)) {
    const key = `${target.platform}:${target.accountId}`
    if (!result.has(key)) result.set(key, { platform: target.platform, accountId: target.accountId,
      sentAt: post.refreshedAt ?? post.createdAt, inbox: target.inbox })
  }
  return [...result.values()]
}
