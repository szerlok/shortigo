import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { isZernioId } from '../../shared/zernio'
import type { PostRecord, PostRecordTarget, PostStatus, PostTargetStatus } from '../../shared/zernio-posts'
import { quarantineUnbound, readableCache } from './workspace-cache'

// Local history of posts made from BridgeClip, so the Accounts page can show
// scheduled and recent posts without listing the whole Zernio workspace.
// Holds ids, paths, titles and statuses: nothing secret.

const VERSION = 1
/** Oldest finished posts are dropped past this. */
const MAX_RECORDS = 300
const MAX_CACHE_BYTES = 2 * 1024 * 1024

const STATUSES: PostStatus[] = ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled', 'missing']
const TARGET_STATUSES: PostTargetStatus[] = ['pending', 'processing', 'uploading', 'published', 'failed', 'cancelled']

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function parseTarget(value: unknown): PostRecordTarget | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  if (typeof t.platform !== 'string' || !isZernioId(t.accountId) || !TARGET_STATUSES.includes(t.status as PostTargetStatus)) return null
  return {
    platform: t.platform.slice(0, 40),
    accountId: t.accountId,
    handle: text(t.handle, 200),
    status: t.status as PostTargetStatus,
    error: text(t.error, 1000),
    url: text(t.url, 2048),
    inbox: t.inbox === true
  }
}

export function parsePostRecord(value: unknown): PostRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const createdAt = iso(r.createdAt)
  const uploadedAt = iso(r.uploadedAt)
  if (!isZernioId(r.id) || typeof r.clipPath !== 'string' || !STATUSES.includes(r.status as PostStatus) || !createdAt || !uploadedAt) return null
  const targets = Array.isArray(r.targets) ? r.targets.map(parseTarget) : []
  if (targets.length === 0 || targets.some((t) => !t)) return null
  return {
    id: r.id,
    ...(typeof r.clipKey === 'string' && r.clipKey.length <= 300 ? { clipKey: r.clipKey } : {}),
    clipPath: r.clipPath.slice(0, 4096),
    clipTitle: text(r.clipTitle, 500) ?? '',
    targets: targets as PostRecordTarget[],
    scheduledFor: iso(r.scheduledFor),
    timezone: text(r.timezone, 64),
    status: r.status as PostStatus,
    error: text(r.error, 1000),
    createdAt,
    uploadedAt,
    refreshedAt: iso(r.refreshedAt)
  }
}

function prune(records: PostRecord[]): PostRecord[] {
  if (records.length <= MAX_RECORDS) return records
  const keep = new Set(
    [...records]
      .sort((a, b) => Number(b.status === 'scheduled' || b.status === 'publishing') - Number(a.status === 'scheduled' || a.status === 'publishing') || b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_RECORDS)
      .map((r) => r.id)
  )
  return records.filter((r) => keep.has(r.id))
}

export class PostsStore {
  constructor(private readonly filePath: string, private readonly workspace: string | null = null,
    private readonly onRecord?: (record: PostRecord) => PostRecord) {}

  /** Newest first. A damaged file is set aside so the next write can't erase it. */
  list(): PostRecord[] {
    if (!existsSync(this.filePath)) return []
    try {
      if (!readableCache(this.filePath, MAX_CACHE_BYTES)) { quarantineUnbound(this.filePath); return [] }
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { version?: unknown; workspace?: unknown; posts?: unknown }
      if (this.workspace && (raw.version !== 2 || raw.workspace !== this.workspace)) {
        quarantineUnbound(this.filePath)
        return []
      }
      const posts = Array.isArray(raw.posts) ? raw.posts.map(parsePostRecord).filter((p): p is PostRecord => p !== null) : []
      return posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch {
      try { renameSync(this.filePath, `${this.filePath}.damaged-${Date.now()}`) } catch { /* Keep going with an empty history. */ }
      return []
    }
  }

  get(id: string): PostRecord | null {
    return this.list().find((post) => post.id === id) ?? null
  }

  private write(posts: PostRecord[]): void {
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`
    writeFileSync(tempPath, JSON.stringify({ version: this.workspace ? 2 : VERSION, ...(this.workspace ? { workspace: this.workspace } : {}), posts: prune(posts) }, null, 2), { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    renameSync(tempPath, this.filePath)
  }

  /** Insert or replace records by id. */
  save(...records: PostRecord[]): PostRecord[] {
    const byId = new Map(this.list().map((post) => [post.id, post]))
    for (const record of records) byId.set(record.id, this.onRecord ? this.onRecord(record) : record)
    this.write([...byId.values()])
    return this.list()
  }

  remove(id: string): PostRecord[] {
    this.write(this.list().filter((post) => post.id !== id))
    return this.list()
  }

  clear(): void {
    this.write([])
  }
}
