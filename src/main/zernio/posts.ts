import { app, shell } from 'electron'
import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { loadSettings } from '../settings-store'
import { assertMediaPath, openAuthorizedMedia } from '../security'
import { resolveBinary } from '../tools'
import { logger } from '../logger'
import { getClient, onZernioReset, readCachedOverview } from './service'
import { ZernioApiError, ZernioDuplicatePostError, type CreatedPost, type ZernioClient } from './client'
import { putFile, videoContentType, type UploadAttempt } from './posts-upload'
import { uploadFilename } from './upload-filename'
import {
  applyZernioPost,
  buildCreatePostBody,
  isPostUrl,
  parsePostClipRequest,
  parseTikTokCreatorInfo,
  tiktokOptionsError
} from './posts-payload'
import { PostsStore } from './posts-store'
import { rememberClipPublication } from '../clip-publications'
import { quarantineUnbound, readableCache, workspaceId } from './workspace-cache'
import { isPostableAccount, isZernioId, type ZernioAccount } from '../../shared/zernio'
import {
  SCHEDULE_SAFETY_MARGIN_MS,
  TIKTOK_LEGAL_LINKS,
  UPLOAD_RETENTION_MS,
  checkCaption,
  checkClip,
  isValidTimeZone,
  scheduleError,
  type ClipMediaInfo,
  type PostClipRequest,
  type PostClipResult,
  type PostOutcome,
  type PostProgress,
  type PostRecord,
  type PostsRefreshResult,
  type TikTokCreatorInfo
} from '../../shared/zernio-posts'

const execFileAsync = promisify(execFile)

/** publishNow publishes to every platform inside the request, video uploads included. */
const PUBLISH_TIMEOUT_MS = 5 * 60_000
const SCHEDULE_TIMEOUT_MS = 60_000
/** Retries of POST /v1/posts reuse the x-request-id, which Zernio honours for ~5 minutes. */
const CREATE_RETRY_DELAYS_MS = [2_000, 5_000]
/** Leave room for clock skew and network travel before Zernio's ~5-minute replay window closes. */
const REQUEST_REPLAY_SAFE_MS = 4 * 60_000
/** The user picked the time when the dialog was open; allow for the time spent since. */
const SUBMIT_GRACE_MS = 3 * 60_000
/** The dialog fetches creator info fresh; publishing re-checks against it without another request per account. */
const CREATOR_INFO_TTL_MS = 10 * 60_000
const PROGRESS_INTERVAL_MS = 150

// Status refresh budget: Zernio's free tier allows 60 requests a minute.
const REFRESH_BATCH = 5
const REFRESH_MIN_GAP_MS = 20_000
const REFRESH_FUTURE_EVERY_MS = 10 * 60_000
const REFRESH_LINK_EVERY_MS = 2 * 60_000

let store: PostsStore | null = null
let storeWorkspace: string | null = null
function postHistoryPath(): string { return join(app.getPath('userData'), 'zernio-posts.json') }
function posts(): PostsStore {
  const workspace = workspaceId(loadSettings().zernioApiKey)
  if (!store || storeWorkspace !== workspace) {
    store = new PostsStore(postHistoryPath(), workspace, rememberPublication)
    storeWorkspace = workspace
  }
  return store
}

function rememberPublication(record: PostRecord): PostRecord {
  try { return rememberClipPublication(loadSettings().outputDirectory, record) }
  catch { return record } // Missing/moved files must never turn a successful send into a retry.
}

// ---- Clip inspection --------------------------------------------------------

async function probe(filePath: string, fallbackDurationMs: number | null): Promise<ClipMediaInfo> {
  const { size } = await stat(filePath)
  try {
    const { stdout } = await execFileAsync(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json', filePath],
      { timeout: 15_000, maxBuffer: 1024 * 1024 }
    )
    const parsed = JSON.parse(stdout) as { streams?: Record<string, unknown>[]; format?: { duration?: string } }
    const stream = parsed.streams?.[0] ?? {}
    let width = Number(stream.width) || null
    let height = Number(stream.height) || null
    const sideData = Array.isArray(stream.side_data_list) ? (stream.side_data_list as Record<string, unknown>[]) : []
    const rotation = Number(sideData.find((d) => d.rotation !== undefined)?.rotation ?? (stream.tags as Record<string, unknown> | undefined)?.rotate ?? 0)
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width]
    const seconds = Number(parsed.format?.duration)
    return { durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallbackDurationMs, width, height, sizeBytes: size }
  } catch {
    // Without ffprobe the checks fall back to the length the clipping engine recorded.
    return { durationMs: fallbackDurationMs, width: null, height: null, sizeBytes: size }
  }
}

export async function probeClipForPosting(clipPath: unknown, fallbackDurationMs: unknown): Promise<ClipMediaInfo> {
  assertMediaPath(clipPath, loadSettings().outputDirectory)
  const fallback = typeof fallbackDurationMs === 'number' && Number.isFinite(fallbackDurationMs) && fallbackDurationMs >= 0 ? fallbackDurationMs : null
  return probe(clipPath, fallback)
}

// ---- TikTok creator info ----------------------------------------------------

const creatorInfoCache = new Map<string, { info: TikTokCreatorInfo; at: number }>()

async function creatorInfo(client: ZernioClient, accountId: string, fresh = false): Promise<TikTokCreatorInfo> {
  const cached = creatorInfoCache.get(accountId)
  if (!fresh && cached && Date.now() - cached.at < CREATOR_INFO_TTL_MS) return cached.info
  const generation = workspaceGeneration
  const info = parseTikTokCreatorInfo(accountId, await client.getTikTokCreatorInfo(accountId))
  assertWorkspace(generation)
  creatorInfoCache.set(accountId, { info, at: Date.now() })
  return info
}

/** Always fresh: the dialog shows it right before the user picks TikTok options. */
export async function getTikTokCreatorInfo(accountId: unknown): Promise<TikTokCreatorInfo> {
  if (!isZernioId(accountId)) throw new Error("Nieprawidłowe konto TikTok")
  return creatorInfo(getClient(), accountId, true)
}

// ---- Publishing -------------------------------------------------------------

interface Attempt {
  filePath: string
  size: number
  mtimeMs: number
  publicUrl: string
  uploadedAt: number
  requestId: string | null
  payloadKey: string | null
  requestStartedAt: number | null
  retryAfterAt: number | null
}

/**
 * Uploads by dialog attempt. Trying again after an error reuses the upload,
 * and the same x-request-id when nothing changed, so a response lost in
 * transit can't turn into a second post.
 */
const attempts = new Map<string, Attempt>()
const MAX_ATTEMPT_BYTES = 1024 * 1024
let attemptsWorkspace: string | null = null
function attemptPath(): string { return join(app.getPath('userData'), 'zernio-post-attempts.json') }
function currentWorkspace(): string { return workspaceId(loadSettings().zernioApiKey) }
function loadAttempts(): void {
  const workspace = currentWorkspace()
  if (attemptsWorkspace === workspace) return
  attempts.clear()
  attemptsWorkspace = workspace
  const path = attemptPath()
  if (!existsSync(path)) return
  if (!readableCache(path, MAX_ATTEMPT_BYTES)) { quarantineUnbound(path); return }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; workspace?: unknown; attempts?: unknown }
    if (raw.version !== 1 || raw.workspace !== workspace) { quarantineUnbound(path); return }
    if (!Array.isArray(raw.attempts)) return
    for (const row of raw.attempts.slice(0, 300)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue
      const value = row[1] as Attempt
      if (typeof value.filePath !== 'string' || typeof value.publicUrl !== 'string' ||
          !Number.isFinite(value.size) || !Number.isFinite(value.mtimeMs) || !Number.isFinite(value.uploadedAt) ||
          (value.requestId !== null && typeof value.requestId !== 'string') ||
          (value.payloadKey !== null && typeof value.payloadKey !== 'string') ||
          (value.requestStartedAt !== null && !Number.isFinite(value.requestStartedAt))) continue
      attempts.set(row[0].slice(0, 128), { ...value, retryAfterAt: Number.isFinite(value.retryAfterAt) ? value.retryAfterAt : null })
    }
  } catch { quarantineUnbound(path) }
}
function saveAttempts(): void {
  const path = attemptPath()
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify({ version: 1, workspace: currentWorkspace(), attempts: [...attempts].slice(-300) }), { mode: 0o600 })
  renameSync(temp, path)
}
const running = new Map<string, AbortController>()
let workspaceGeneration = 0

onZernioReset(() => {
  workspaceGeneration += 1
  for (const controller of running.values()) controller.abort()
  attempts.clear()
  attemptsWorkspace = null
  quarantineUnbound(attemptPath())
  creatorInfoCache.clear()
  store = null
  storeWorkspace = null
  quarantineUnbound(postHistoryPath())
})

function assertWorkspace(generation: number): void {
  if (generation !== workspaceGeneration) throw new Error("Klucz API Zernio zmienił się. Sprawdź konta i opublikuj ponownie.")
}

function platformLabel(platform: string): string {
  return ({ tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', twitter: 'X', linkedin: 'LinkedIn', threads: 'Threads' } as Record<string, string>)[platform] ?? platform
}

function isRetryable(error: unknown): boolean {
  return error instanceof ZernioApiError && !(error instanceof ZernioDuplicatePostError) && (error.status === 0 || error.status >= 500)
}

async function createWithRetry(client: ZernioClient, body: Record<string, unknown>, requestId: string, requestStartedAt: number, timeoutMs: number, generation: number, attemptState: Attempt): Promise<CreatedPost> {
  // A previous invocation may have stopped before Retry-After elapsed. A
  // repeat click with the same attempt must respect the same provider clock.
  const previousWait = Math.max(0, (attemptState.retryAfterAt ?? 0) - Date.now())
  if (previousWait > 0) {
    if (Date.now() + previousWait - requestStartedAt >= REQUEST_REPLAY_SAFE_MS) {
      throw new Error("Czas bezpiecznego ponowienia upłynie przed kolejną dozwoloną próbą. Sprawdź panel Zernio przed ponowną publikacją.")
    }
    await new Promise((resolve) => setTimeout(resolve, previousWait))
  }
  for (let attempt = 0; ; attempt++) {
    assertWorkspace(generation)
    if (Date.now() - requestStartedAt >= REQUEST_REPLAY_SAFE_MS) {
      throw new Error("Upłynął czas bezpiecznego ponowienia. Sprawdź panel Zernio przed nową publikacją.")
    }
    try {
      return await client.createPost(body, requestId, timeoutMs)
    } catch (error) {
      const retryAfterMs = error instanceof ZernioApiError && error.status === 503
        ? (error.retryAfterSeconds ?? 0) * 1000
        : 0
      if (retryAfterMs > 0) attemptState.retryAfterAt = Date.now() + retryAfterMs
      if (retryAfterMs > 0) saveAttempts()
      const baseDelay = CREATE_RETRY_DELAYS_MS[attempt]
      if (!isRetryable(error) || baseDelay === undefined) {
        if (isRetryable(error)) {
          throw new Error("Zernio nie potwierdziło publikacji. Ponów próbę wkrótce; po kilku minutach sprawdź panel Zernio przed kolejną publikacją.")
        }
        throw error
      }
      // A 503's Retry-After is a minimum. Never wait so long that the next
      // attempt could reuse the key after Zernio's ~5-minute replay window.
      const delay = Math.max(baseDelay, retryAfterMs)
      if (Date.now() + delay - requestStartedAt >= REQUEST_REPLAY_SAFE_MS) {
        throw new Error("Czas bezpiecznego ponowienia upłynie przed kolejną dozwoloną próbą. Sprawdź panel Zernio przed ponowną publikacją.")
      }
      logger.warn('zernio.post.create.retry', { attempt: attempt + 1, status: (error as ZernioApiError).status })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function outcomeOf(record: PostRecord, created: CreatedPost, request: PostClipRequest): { outcome: PostOutcome; message: string } {
  const inboxOnly = record.targets.every((t) => t.inbox)
  switch (record.status) {
    case 'published':
      return inboxOnly
        ? { outcome: 'published', message: "Otwórz TikTok, aby dokończyć publikację ze skrzynki odbiorczej." }
        : { outcome: 'published', message: "Publikacja może pojawić się na platformach po kilku minutach." }
    case 'partial':
      return { outcome: 'partial', message: "Opublikowano na części kont." }
    case 'failed':
      return { outcome: 'failed', message: created.error ?? "Zernio nie mogło opublikować wpisu." }
    case 'scheduled':
      if (created.httpStatus === 207) return { outcome: 'retrying', message: "W Zernio wystąpił chwilowy problem. Próba zostanie ponowiona automatycznie." }
      if (request.timing.mode === 'now') return { outcome: 'publishing', message: "Zernio dodało wpis do kolejki i wkrótce go opublikuje." }
      return { outcome: 'scheduled', message: "Zernio opublikuje wpis także wtedy, gdy Shortigo będzie zamknięty." }
    default:
      return { outcome: 'publishing', message: "Zernio nadal publikuje. Sprawdź wynik w sekcji Publikacje na stronie Konta." }
  }
}

/** A 409 means Zernio already has this content for an account: show that post instead of an error. */
async function recordDuplicate(client: ZernioClient, error: ZernioDuplicatePostError, base: PostRecord, generation: number): Promise<PostClipResult> {
  const known = error.existingPostId ? posts().get(error.existingPostId) : null
  let record: PostRecord | null = known
  if (error.existingPostId) {
    try {
      const remote = await client.getPost(error.existingPostId)
      assertWorkspace(generation)
      record = applyZernioPost(known ?? { ...base, id: error.existingPostId }, remote, { now: new Date().toISOString() })
      posts().save(record)
    } catch { /* The message alone still explains what happened. */ }
  }
  assertWorkspace(generation)
  const where = error.platform ? ` na ${platformLabel(error.platform)}` : ''
  return {
    post: record,
    outcome: 'duplicate',
    message: `${error.message} Zernio blokuje identyczne publikacje na tym samym koncie${where} przez 24 godziny. Zmień opis, aby opublikować ponownie.`,
    warnings: []
  }
}

/**
 * Each target's account, checked against the accounts the Accounts page last
 * synced (no request), or against Zernio when one isn't there. Handles are
 * kept for the history.
 */
async function resolveTargets(client: ZernioClient, requested: PostClipRequest['targets']): Promise<(PostClipRequest['targets'][number] & { handle: string | null })[]> {
  const match = (accounts: ZernioAccount[]): (ZernioAccount | undefined)[] =>
    requested.map((target) => accounts.find((a) => a.id === target.accountId && a.platform === target.platform))
  let found = match(readCachedOverview()?.accounts ?? [])
  if (found.some((account) => !account)) found = match(await client.listAccounts())
  return requested.map((target, i) => {
    const account = found[i]
    if (!account) throw new Error(`Konto ${platformLabel(target.platform)} nie jest już połączone. Odśwież konta i spróbuj ponownie.`)
    if (!isPostableAccount(account)) {
      const who = account.username ? `${platformLabel(target.platform)} @${account.username}` : platformLabel(target.platform)
      throw new Error(`Połącz ponownie lub sprawdź ${who} na stronie Konta przed publikacją.`)
    }
    return { ...target, handle: account.username ? `@${account.username}` : account.displayName }
  })
}

export async function publishClip(raw: unknown, notify: (progress: PostProgress) => void): Promise<PostClipResult> {
  const request = parsePostClipRequest(raw)
  const generation = workspaceGeneration
  if (running.has(request.attemptId)) throw new Error("Ten klip jest już publikowany.")
  const controller = new AbortController()
  running.set(request.attemptId, controller)
  try {
    return await publish(request, controller.signal, notify, generation)
  } finally {
    running.delete(request.attemptId)
  }
}

async function publish(request: PostClipRequest, signal: AbortSignal, notify: (progress: PostProgress) => void, generation: number): Promise<PostClipResult> {
  assertWorkspace(generation)
  assertMediaPath(request.clipPath, loadSettings().outputDirectory)
  const contentType = videoContentType(request.clipPath)
  if (!contentType) throw new Error("Publikować można klipy MP4, MOV, M4V i WebM.")

  const started = Date.now()
  loadAttempts()
  for (const [id, old] of attempts) if (started - old.uploadedAt > UPLOAD_RETENTION_MS && !old.requestId) attempts.delete(id)
  const file = await stat(request.clipPath)
  const earlier = attempts.get(request.attemptId)
  const reusable = earlier && earlier.filePath === request.clipPath && earlier.size === file.size && earlier.mtimeMs === file.mtimeMs &&
    started - earlier.uploadedAt < UPLOAD_RETENTION_MS - SCHEDULE_SAFETY_MARGIN_MS ? earlier : undefined
  if (earlier?.requestId && !reusable) throw new Error("Poprzednia publikacja mogła dotrzeć do Zernio. Sprawdź panel Zernio przed ponownym opublikowaniem klipu.")
  const uploadedAt = reusable?.uploadedAt ?? started
  if (request.timing.mode === 'schedule') {
    const error = scheduleError(Date.parse(request.timing.scheduledFor), started, uploadedAt, SUBMIT_GRACE_MS)
    if (error) throw new Error(error)
  }

  const client = getClient()
  const [media, targets] = await Promise.all([probe(request.clipPath, request.durationMs), resolveTargets(client, request.targets)])
  assertWorkspace(generation)
  const label = (accountId: string): string => {
    const target = targets.find((t) => t.accountId === accountId)
    return target?.handle ? `${platformLabel(target.platform)} ${target.handle}` : platformLabel(target?.platform ?? '')
  }

  // Each TikTok account has its own creator info (privacy options, disabled toggles, length cap).
  const tiktokTargets = targets.filter((t) => t.platform === 'tiktok')
  const [tiktokInfos, tiktokLanes] = await Promise.all([
    Promise.all(tiktokTargets.map((t) => creatorInfo(client, t.accountId))),
    Promise.all(tiktokTargets.map((t) => client.getTikTokIntegrationLane(t.accountId)))
  ])
  assertWorkspace(generation)
  if (tiktokInfos.length > 0) {
    const error = request.options.tiktok ? tiktokOptionsError(request.options.tiktok, tiktokInfos, label) : "Wybierz opcje TikToka."
    if (error) throw new Error(error)
    if (!request.options.tiktok?.draft) {
      for (const [index, target] of tiktokTargets.entries()) {
        if (tiktokLanes[index] === 'business' && request.options.tiktok?.accounts[target.accountId]?.privacyLevel !== 'PUBLIC_TO_EVERYONE') {
          throw new Error(`${label(target.accountId)}: konto firmowe TikToka może publikować bezpośrednio tylko dla wszystkich. Wybierz tę widoczność lub wyślij film do skrzynki TikToka.`)
        }
      }
    }
  }

  const problems: string[] = []
  for (const target of request.targets) {
    const platform = target.platform
    const caption = checkCaption(platform, target.customContent ?? request.caption)
    const clips = platform === 'tiktok'
      ? tiktokInfos.map((info) => {
        const blocking = checkClip('tiktok', media, { tiktokMaxSec: info.maxVideoDurationSec }).blocking
        return blocking && tiktokInfos.length > 1 ? `${label(info.accountId)}: ${blocking}` : blocking
      })
      : [checkClip(platform, media, { facebookFormat: request.options.facebook?.format }).blocking]
    for (const problem of [...clips, caption.error]) if (problem && !problems.includes(problem)) problems.push(problem)
  }
  if (problems.length > 0) throw new Error(problems.join(' '))

  // Upload, or reuse this attempt's earlier upload.
  let attempt = reusable
  if (!attempt) {
    const authorized = await openAuthorizedMedia(request.clipPath, loadSettings().outputDirectory)
    try {
      const opened = await authorized.handle.stat()
      if (opened.size !== file.size || opened.mtimeMs !== file.mtimeMs) throw new Error("Klip zmienił się podczas przygotowania przesyłania. Spróbuj ponownie.")
      const { uploadUrl, publicUrl } = await client.presignMedia(
        uploadFilename(request.clipTitle, request.clipPath, request.attemptId), contentType, authorized.size)
      assertWorkspace(generation)
      let lastAt = 0
      let uploadInfo: UploadAttempt | undefined
      const uploadProgress = (sent: number, total: number): void => {
        const now = Date.now()
        if (sent > 0 && sent < total && now - lastAt < PROGRESS_INTERVAL_MS) return
        lastAt = now
        notify({ attemptId: request.attemptId, phase: 'uploading', transferred: sent, total,
          uploadAttempt: uploadInfo?.attempt, uploadMaxAttempts: uploadInfo?.maxAttempts,
          uploadBytesPerSecond: uploadInfo?.bytesPerSecond })
      }
      notify({ attemptId: request.attemptId, phase: 'uploading', transferred: 0, total: authorized.size })
      await putFile(uploadUrl, authorized.handle, {
        contentType,
        stableUpload: request.stableUpload,
        size: authorized.size,
        signal,
        onAttempt: info => { uploadInfo = info; uploadProgress(0, authorized.size) },
        onProgress: uploadProgress
      })
      assertWorkspace(generation)
      attempt = { filePath: request.clipPath, size: authorized.size, mtimeMs: opened.mtimeMs, publicUrl, uploadedAt: Date.now(), requestId: null, payloadKey: null, requestStartedAt: null, retryAfterAt: null }
      attempts.set(request.attemptId, attempt)
      saveAttempts()
      logger.info('zernio.post.uploaded', { bytes: authorized.size, seconds: Math.round((Date.now() - started) / 1000) })
    } finally { await authorized.handle.close() }
  }

  if (request.timing.mode === 'schedule' && Date.parse(request.timing.scheduledFor) < Date.now() + 60_000) {
    throw new Error("Zaplanowany termin minął podczas przesyłania klipu. Wybierz późniejszy termin; przesłany plik zostaje zachowany.")
  }

  const body = buildCreatePostBody(request, {
    publicUrl: attempt.publicUrl,
    tiktokInteractions: Object.fromEntries(tiktokInfos.map((info) => [info.accountId, info.interactions])),
    facebookFormat: request.options.facebook?.format
  })
  const payloadKey = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  if (attempt.requestId && attempt.payloadKey !== payloadKey) {
    throw new Error("Poprzednia publikacja mogła dotrzeć do Zernio. Sprawdź panel Zernio przed zmianą i ponowieniem publikacji.")
  }
  if (attempt.requestId && attempt.requestStartedAt && Date.now() - attempt.requestStartedAt >= REQUEST_REPLAY_SAFE_MS) {
    throw new Error("Upłynął czas bezpiecznego ponowienia. Sprawdź panel Zernio przed nową publikacją.")
  }
  if (attempt.payloadKey !== payloadKey || !attempt.requestId) {
    attempt.requestId = randomUUID()
    attempt.payloadKey = payloadKey
    attempt.requestStartedAt = Date.now()
    attempt.retryAfterAt = null
  }
  // Persist the id before the network call, including across app restarts.
  saveAttempts()

  notify({ attemptId: request.attemptId, phase: 'publishing', transferred: file.size, total: file.size })
  const nowIso = new Date().toISOString()
  const base: PostRecord = {
    id: '',
    clipPath: request.clipPath,
    clipTitle: request.clipTitle,
    targets: targets.map((t) => ({
      platform: t.platform,
      accountId: t.accountId,
      handle: t.handle,
      status: 'pending',
      error: null,
      url: null,
      inbox: t.platform === 'tiktok' && request.options.tiktok?.draft === true
    })),
    scheduledFor: request.timing.mode === 'schedule' ? request.timing.scheduledFor : null,
    timezone: request.timing.mode === 'schedule' ? request.timing.timezone : null,
    status: request.timing.mode === 'schedule' ? 'scheduled' : 'publishing',
    error: null,
    createdAt: nowIso,
    uploadedAt: new Date(attempt.uploadedAt).toISOString(),
    refreshedAt: nowIso
  }

  let created: CreatedPost
  try {
    created = await createWithRetry(client, body, attempt.requestId, attempt.requestStartedAt ?? Date.now(), request.timing.mode === 'now' ? PUBLISH_TIMEOUT_MS : SCHEDULE_TIMEOUT_MS, generation, attempt)
  } catch (error) {
    // Zernio answered, so nothing is in doubt: the next try is a new request.
    // After a timeout or 5xx the id is kept, so a retry replays instead of posting twice.
    if (error instanceof ZernioApiError && error.status >= 400 && error.status < 500) {
      attempt.requestId = null
      attempt.requestStartedAt = null
      saveAttempts()
    }
    if (error instanceof ZernioDuplicatePostError) return recordDuplicate(client, error, base, generation)
    throw error
  }

  assertWorkspace(generation)

  const record = applyZernioPost(base, created.post, { platformResults: created.platformResults, error: created.error, now: nowIso })
  if (!isZernioId(record.id)) throw new Error("Zernio przyjęło publikację bez zwrócenia identyfikatora. Sprawdź panel Zernio.")
  posts().save(record)
  // The post exists now. Editing and posting again (after a failure) keeps the
  // upload but is a new request.
  attempt.requestId = null
  attempt.payloadKey = null
  attempt.requestStartedAt = null
  saveAttempts()
  const { outcome, message } = outcomeOf(record, created, request)
  logger.info('zernio.post.created', { targets: record.targets.length, mode: request.timing.mode, status: record.status, replayed: created.replayed })
  return { post: posts().get(record.id) ?? record, outcome, message, warnings: created.warnings }
}

export function cancelUpload(attemptId: unknown): void {
  if (typeof attemptId === 'string') running.get(attemptId)?.abort()
}

// ---- History ----------------------------------------------------------------

export function listPosts(): PostRecord[] {
  const existing = posts().list()
  const records = existing.map(rememberPublication)
  const changed = records.filter((record, index) => record !== existing[index])
  if (changed.length) posts().save(...changed)
  return records
}

function requirePost(id: unknown): PostRecord {
  const post = isZernioId(id) ? posts().get(id) : null
  if (!post) throw new Error("Tej publikacji nie ma już w historii.")
  return post
}

function refreshDue(post: PostRecord, now: number, force: boolean): boolean {
  const last = post.refreshedAt ? Date.parse(post.refreshedAt) : 0
  if (now - last < REFRESH_MIN_GAP_MS) return false
  if (post.status === 'publishing') return true
  if (post.status === 'scheduled') {
    const due = post.scheduledFor ? Date.parse(post.scheduledFor) : 0
    return force || due <= now + 60_000 || now - last > REFRESH_FUTURE_EVERY_MS
  }
  if (post.status === 'published' || post.status === 'partial') {
    const recent = now - Date.parse(post.createdAt) < 86_400_000
    const waiting = post.targets.some((t) => ['pending', 'processing', 'uploading'].includes(t.status) || (t.status === 'published' && !t.url && !t.inbox))
    return recent && waiting && (force || now - last > REFRESH_LINK_EVERY_MS)
  }
  return false
}

const PRIORITY: Partial<Record<PostRecord['status'], number>> = { publishing: 0, scheduled: 1 }

/**
 * Re-read the posts whose status can still change, a few at a time. The
 * renderer calls this while the Posts panel is on screen.
 */
export async function refreshPosts(force: unknown): Promise<PostsRefreshResult> {
  const generation = workspaceGeneration
  const now = Date.now()
  const due = posts().list()
    .filter((post) => refreshDue(post, now, force === true))
    .sort((a, b) => (PRIORITY[a.status] ?? 2) - (PRIORITY[b.status] ?? 2) || (a.scheduledFor ?? a.createdAt).localeCompare(b.scheduledFor ?? b.createdAt))
    .slice(0, REFRESH_BATCH)
  if (due.length === 0) return { posts: posts().list(), error: null }

  let client: ZernioClient
  try {
    client = getClient()
  } catch (error) {
    return { posts: posts().list(), error: error instanceof Error ? error.message : "Dodaj klucz API Zernio, aby zobaczyć stan publikacji." }
  }

  let failure: string | null = null
  for (const post of due) {
    const stamp = new Date().toISOString()
    try {
      const remote = await client.getPost(post.id)
      if (generation !== workspaceGeneration) return { posts: posts().list(), error: null }
      posts().save(applyZernioPost(posts().get(post.id) ?? post, remote, { now: stamp }))
    } catch (error) {
      if (generation !== workspaceGeneration) return { posts: posts().list(), error: null }
      const status = error instanceof ZernioApiError ? error.status : -1
      if (status === 404) {
        const current = posts().get(post.id) ?? post
        posts().save({ ...current, status: 'missing', error: "Tej publikacji nie ma już w Twoim Zernio.", refreshedAt: stamp })
        continue
      }
      failure = error instanceof Error ? error.message : "Nie udało się odświeżyć publikacji."
      // Rate limits, a bad key or no connection affect every request: stop here.
      if (status === 429 || status === 401 || status === 0) break
    }
  }
  return { posts: posts().list(), error: failure }
}

export async function cancelPost(id: unknown): Promise<PostRecord[]> {
  const generation = workspaceGeneration
  const post = requirePost(id)
  if (post.status !== 'scheduled') throw new Error("Anulować można tylko zaplanowane publikacje.")
  const client = getClient()
  try {
    await client.deletePost(post.id)
    assertWorkspace(generation)
  } catch (error) {
    if (!(error instanceof ZernioApiError) || (error.status !== 404 && error.status !== 400)) throw error
    if (error.status === 400) {
      const remote = await client.getPost(post.id).catch(() => null)
      assertWorkspace(generation)
      if (remote) posts().save(applyZernioPost(post, remote, { now: new Date().toISOString() }))
      throw new Error("Publikacja już się rozpoczęła i nie można jej anulować.")
    }
  }
  logger.info('zernio.post.cancelled')
  return posts().save({
    ...post,
    status: 'cancelled',
    targets: post.targets.map((t) => ({ ...t, status: 'cancelled' })),
    refreshedAt: new Date().toISOString()
  })
}

export async function reschedulePost(id: unknown, scheduledFor: unknown, timezone: unknown): Promise<PostRecord[]> {
  const generation = workspaceGeneration
  const post = requirePost(id)
  if (post.status !== 'scheduled') throw new Error("Termin można zmienić tylko dla zaplanowanych publikacji.")
  if (typeof scheduledFor !== 'string' || scheduledFor.length > 40 || !isValidTimeZone(timezone)) throw new Error("Wybierz prawidłową datę i godzinę.")
  const at = Date.parse(scheduledFor)
  const error = scheduleError(at, Date.now(), Date.parse(post.uploadedAt))
  if (error) throw new Error(error)
  const iso = new Date(at).toISOString()
  const remote = await getClient().updatePost(post.id, { scheduledFor: iso, timezone })
  assertWorkspace(generation)
  return posts().save(applyZernioPost({ ...post, scheduledFor: iso, timezone }, remote, { now: new Date().toISOString() }))
}

export async function retryPost(id: unknown): Promise<PostRecord[]> {
  const generation = workspaceGeneration
  const post = requirePost(id)
  if (post.status !== 'failed' && post.status !== 'partial') throw new Error("Ponowić można tylko nieudane publikacje.")
  if (Date.now() > Date.parse(post.uploadedAt) + UPLOAD_RETENTION_MS) {
    throw new Error("Zernio przechowuje pliki przez 7 dni. Ten plik wygasł. Opublikuj klip ponownie z biblioteki.")
  }
  const { post: remote, error } = await getClient().retryPost(post.id, PUBLISH_TIMEOUT_MS)
  assertWorkspace(generation)
  return posts().save(applyZernioPost(post, remote, { error, now: new Date().toISOString() }))
}

/** Removes a finished post from the local list; Zernio keeps its own record. */
export function dismissPost(id: unknown): PostRecord[] {
  const post = requirePost(id)
  if (post.status === 'scheduled' || post.status === 'publishing') throw new Error("Anuluj publikację przed jej usunięciem.")
  return posts().remove(post.id)
}

/** Opens a published post. The link comes from local history and must be https on that platform's site. */
export async function openPostLink(id: unknown, targetIndex: unknown): Promise<void> {
  const post = requirePost(id)
  const target = Number.isInteger(targetIndex) ? post.targets[targetIndex as number] : undefined
  if (!target || !isPostUrl(target.url, target.platform)) throw new Error("Ta publikacja nie ma jeszcze linku.")
  await shell.openExternal(target.url)
}

export async function openTikTokLegal(key: unknown): Promise<void> {
  if (key !== 'musicUsage' && key !== 'brandedContent') throw new Error("Nieznany link")
  await shell.openExternal(TIKTOK_LEGAL_LINKS[key])
}
