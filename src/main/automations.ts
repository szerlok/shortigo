import { app } from 'electron'
import { clipFilePath } from '../shared/media-path'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { open, unlink } from 'fs/promises'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { AUTOMATION_PLATFORMS, dueSlots, type Automation, type AutomationAccount, type AutomationContent, type AutomationUpdate, type GeneratedPlatformMetadata } from '../shared/automations'
import { isPostableAccount, isZernioId, type ZernioOverview } from '../shared/zernio'
import { defaultFacebookFormat, isValidTimeZone, youtubeTitleFor, type PostClipRequest } from '../shared/zernio-posts'
import { loadSettings } from './settings-store'
import { assertMediaPath, authorizeMedia, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getZernioOverview, readCachedOverview } from './zernio/service'
import { probeClipForPosting, publishClip } from './zernio/posts'
import { parsePostClipRequest } from './zernio/posts-payload'
import { workspaceId } from './zernio/workspace-cache'
import { logger } from './logger'
import { generateAutomationMetadata, transcribeAutomationClip } from './automation-metadata'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const MAX_FILE_BYTES = 5 * 1024 ** 3
const MAX_STORE_BYTES = 32 * 1024 * 1024
const MAX_AUTOMATIONS = 100
const MAX_CONTENT = 500

let cachedWorkspace: string | null = null
let cached: Automation[] = []
const busy = new Set<string>()

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80 || Array.from(name).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw new Error("Podaj nazwę o długości do 80 znaków.")
  }
  return name
}

function currentWorkspace(): string {
  const key = loadSettings().zernioApiKey
  if (!key) throw new Error("Połącz konto Zernio przed utworzeniem automatyzacji.")
  return workspaceId(key)
}

function dataPath(workspace: string): string { return join(app.getPath('userData'), `automations-${workspace}.json`) }
function bankPath(workspace: string, automationId: string): string { return join(app.getPath('userData'), 'automation-bank', workspace, automationId) }

function validContent(value: unknown): value is AutomationContent {
  if (!value || typeof value !== 'object') return false
  const item = value as AutomationContent
  return UUID.test(item.id) && typeof item.fileName === 'string' &&
    item.fileName === `${item.id}${extname(item.fileName)}` && VIDEO_EXTENSIONS.has(extname(item.fileName)) &&
    typeof item.title === 'string' && item.title.length <= 500 &&
    typeof item.caption === 'string' && item.caption.length <= 63_206 &&
    (item.transcript === null || (typeof item.transcript === 'string' && item.transcript.length <= 20_000)) &&
    (item.generatedMetadata === null || (Array.isArray(item.generatedMetadata) && item.generatedMetadata.length <= AUTOMATION_PLATFORMS.length &&
      item.generatedMetadata.every((post: GeneratedPlatformMetadata) => post && AUTOMATION_PLATFORMS.includes(post.platform) &&
        typeof post.caption === 'string' && post.caption.length <= 63_206 && (post.title === null || typeof post.title === 'string') &&
        (post.categoryId === null || typeof post.categoryId === 'string') && (post.topicTag === undefined || post.topicTag === null || typeof post.topicTag === 'string') &&
        Array.isArray(post.tags) && post.tags.length <= 8 && post.tags.every((tag) => typeof tag === 'string' && tag.length <= 100)))) &&
    ['queued', 'posting', 'posted', 'needs_review'].includes(item.status) &&
    typeof item.addedAt === 'string' && Number.isFinite(Date.parse(item.addedAt)) &&
    (item.postedAt === null || typeof item.postedAt === 'string') &&
    (item.postId === null || isZernioId(item.postId)) &&
    (item.error === null || typeof item.error === 'string')
}

function validAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== 'object') return false
  const item = value as Automation
  return UUID.test(item.id) && typeof item.name === 'string' && item.name.length <= 80 &&
    typeof item.enabled === 'boolean' && (item.profileId === null || isZernioId(item.profileId)) &&
    (item.metadataMode === 'ai' || item.metadataMode === 'manual') &&
    Array.isArray(item.accounts) && item.accounts.length <= 20 &&
    item.accounts.every((account) => account && isZernioId(account.accountId) && AUTOMATION_PLATFORMS.includes(account.platform)) &&
    Array.isArray(item.times) && item.times.length <= 24 && item.times.every((time) => typeof time === 'string' && TIME.test(time)) &&
    isValidTimeZone(item.timezone) && ['public', 'unlisted', 'private'].includes(item.youtubeVisibility) && typeof item.youtubeMadeForKids === 'boolean' &&
    item.lastSlots && typeof item.lastSlots === 'object' && !Array.isArray(item.lastSlots) &&
    Array.isArray(item.content) && item.content.length <= MAX_CONTENT && item.content.every(validContent) &&
    typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) &&
    (item.lastRunAt === null || typeof item.lastRunAt === 'string') &&
    (item.lastError === null || typeof item.lastError === 'string')
}

function data(): { workspace: string; automations: Automation[] } {
  const workspace = currentWorkspace()
  if (cachedWorkspace !== workspace) {
    const path = dataPath(workspace)
    let migrated = false
    if (!existsSync(path)) cached = []
    else {
      const file = statSync(path)
      if (!file.isFile() || file.size > MAX_STORE_BYTES) throw new Error("Nie udało się odczytać danych automatyzacji. Plik zachowano do odzyskania.")
      try {
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
        const record = value as { version?: unknown; workspace?: unknown; automations?: unknown }
        if (![1, 2, 3].includes(Number(record.version)) || record.workspace !== workspace || !Array.isArray(record.automations) ||
            record.automations.length > MAX_AUTOMATIONS) throw new Error("Nieprawidłowe dane automatyzacji")
        if (record.version === 1 || record.version === 2) {
          const known = readCachedOverview()?.accounts ?? []
          cached = record.automations.map((value: unknown) => {
            const old = value as Automation
            const profileIds = record.version === 1 ? old.accounts?.map((account) => known.find((item) => item.id === account.accountId && item.platform === account.platform)?.profileId) : []
            const profileId = record.version === 1 ? (profileIds?.length && profileIds.every((id) => id && id === profileIds[0]) ? profileIds[0] ?? null : null) : old.profileId
            return { ...old, profileId, metadataMode: 'manual' as const,
              content: old.content.map((item) => ({ ...item, transcript: null, generatedMetadata: null })),
              accounts: profileId ? old.accounts : [], enabled: profileId ? old.enabled : false,
              lastError: !profileId && old.accounts?.length ? "Wybierz jeden profil Zernio i ponownie wybierz jego konta." : old.lastError }
          })
          migrated = true
        } else cached = record.automations
        if (!cached.every(validAutomation)) throw new Error("Nieprawidłowe dane automatyzacji")
      } catch {
        throw new Error("Nie udało się odczytać danych automatyzacji. Plik zachowano do odzyskania.")
      }
    }
    // A publishing reservation left by a crash needs a person to verify its result.
    let recovered = false
    for (const automation of cached) for (const item of automation.content) {
      if (item.status === 'posting') {
        item.status = 'needs_review'
        item.error = "BridgeClip zamknięto podczas publikowania. Sprawdź Zernio, zanim przywrócisz klip do kolejki."
        recovered = true
      } else if (item.status === 'needs_review' && !item.postId &&
          (item.error === "Przesyłanie przerwano. Sprawdź połączenie i spróbuj ponownie." ||
            item.error === "Przesyłanie zatrzymało się. Sprawdź połączenie i spróbuj ponownie.")) {
        // These errors happen before Zernio receives a post request. Older
        // versions kept the clip in review even though it is safe to retry.
        item.status = 'queued'
        recovered = true
      }
    }
    cachedWorkspace = workspace
    if (recovered || migrated) save(workspace)
  }
  return { workspace, automations: cached }
}

function save(workspace: string): void {
  const path = dataPath(workspace)
  mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 })
  const payload = JSON.stringify({ version: 3, workspace, automations: cached })
  if (Buffer.byteLength(payload) > MAX_STORE_BYTES) throw new Error("Osiągnięto limit danych automatyzacji.")
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, payload, { flag: 'wx', mode: 0o600 })
    renameSync(temp, path)
  } finally { rmSync(temp, { force: true }) }
}

function find(id: unknown): { workspace: string; automation: Automation } {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error("Nieprawidłowa automatyzacja")
  const { workspace, automations } = data()
  const automation = automations.find((item) => item.id === id)
  if (!automation) throw new Error("Nie znaleziono automatyzacji")
  return { workspace, automation }
}

function validatedUpdate(raw: unknown): AutomationUpdate {
  if (!raw || typeof raw !== 'object') throw new Error("Nieprawidłowe ustawienia automatyzacji")
  const value = raw as AutomationUpdate
  const name = cleanName(value.name)
  if (typeof value.enabled !== 'boolean' || !isValidTimeZone(value.timezone)) throw new Error("Nieprawidłowe ustawienia automatyzacji")
  if (value.metadataMode !== 'ai' && value.metadataMode !== 'manual') throw new Error("Wybierz sposób przygotowania opisów w automatyzacji.")
  if (value.profileId !== null && !isZernioId(value.profileId)) throw new Error("Wybierz jeden profil Zernio.")
  if (!['public', 'unlisted', 'private'].includes(value.youtubeVisibility) || typeof value.youtubeMadeForKids !== 'boolean') throw new Error("Wybierz widoczność i odbiorców w YouTube.")
  if (!Array.isArray(value.accounts) || value.accounts.length > 20 || !value.accounts.every((account: AutomationAccount) =>
    account && isZernioId(account.accountId) && AUTOMATION_PLATFORMS.includes(account.platform))) throw new Error("Wybierz prawidłowe konta.")
  const accounts = [...new Map(value.accounts.map((account) => [account.accountId, account])).values()]
  if (!value.profileId && accounts.length > 0) throw new Error("Wybierz profil Zernio przed wybraniem kont.")
  if (!Array.isArray(value.times) || value.times.length > 24 || !value.times.every((time: string) => TIME.test(time))) throw new Error("Podaj prawidłowe godziny publikacji.")
  const times = [...new Set(value.times)].sort()
  if (value.enabled && (!value.profileId || accounts.length === 0 || times.length === 0)) throw new Error("Przed włączeniem wybierz profil, jego konto i przynajmniej jedną godzinę publikacji.")
  if (value.enabled && value.metadataMode === 'ai') {
    const settings = loadSettings()
    if (!settings.openrouterApiKey) throw new Error("Dodaj klucz API OpenRouter w ustawieniach przed włączeniem automatycznych opisów.")
  }
  return { name, enabled: value.enabled, profileId: value.profileId, metadataMode: value.metadataMode, accounts, times, timezone: value.timezone, youtubeVisibility: value.youtubeVisibility, youtubeMadeForKids: value.youtubeMadeForKids }
}

function checkProfileAccounts(overview: ZernioOverview, profileId: string, accounts: AutomationAccount[]): void {
  const profile = overview.profiles.find((item) => item.id === profileId)
  if (!profile) throw new Error("Wybrany profil Zernio nie jest już dostępny. Wybierz inny.")
  if (profile.isOverLimit) throw new Error("Wybrany profil Zernio przekroczył limit kont.")
  for (const selected of accounts) {
    const account = overview.accounts.find((item) => item.id === selected.accountId && item.platform === selected.platform)
    if (!account || account.profileId !== profileId) throw new Error("Wybrane konto nie należy już do tego profilu Zernio. Sprawdź listę kont.")
    if (!isPostableAccount(account)) throw new Error("Wybrane konto wymaga ponownego połączenia. Sprawdź Konta przed następnym uruchomieniem.")
  }
}

export function listAutomations(): Automation[] { return structuredClone(data().automations) }

/** Recognize only a recorded bank file in the current workspace. */
export function isAutomationMedia(path: unknown): path is string {
  if (typeof path !== 'string') return false
  try {
    const { workspace, automations } = data()
    const automation = automations.find((entry) => entry.content.some((item) =>
      path === join(bankPath(workspace, entry.id), item.fileName)
    ))
    if (!automation || lstatSync(path).isSymbolicLink()) return false
    const directory = bankPath(workspace, automation.id)
    return !lstatSync(directory).isSymbolicLink() && isWithinDirectory(path, directory) && isWithinDirectory(path, app.getPath('userData'))
  } catch { return false }
}

export function createAutomation(rawName: unknown): Automation[] {
  const name = cleanName(rawName)
  const { workspace, automations } = data()
  if (automations.length >= MAX_AUTOMATIONS) throw new Error("Osiągnięto limit automatyzacji.")
  const item: Automation = {
    id: randomUUID(), name, enabled: false, profileId: null, metadataMode: 'manual', accounts: [], times: [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', youtubeVisibility: 'public', youtubeMadeForKids: false,
    lastSlots: {}, content: [],
    createdAt: new Date().toISOString(), lastRunAt: null, lastError: null
  }
  automations.unshift(item)
  save(workspace)
  return listAutomations()
}

export async function updateAutomation(id: unknown, raw: unknown): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) throw new Error("Poczekaj na zakończenie bieżącej operacji.")
  const update = validatedUpdate(raw)
  if (update.profileId) checkProfileAccounts(await getZernioOverview(), update.profileId, update.accounts)
  if (currentWorkspace() !== workspace || !cached.includes(automation) || busy.has(automation.id)) throw new Error("Automatyzacja zmieniła się podczas zapisywania. Spróbuj ponownie.")
  Object.assign(automation, update, { lastSlots: Object.fromEntries(Object.entries(automation.lastSlots).filter(([time]) => update.times.includes(time))) })
  save(workspace)
  return listAutomations()
}

export function deleteAutomation(id: unknown): Automation[] {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) throw new Error("Poczekaj na zakończenie bieżącej publikacji.")
  cached = cached.filter((item) => item.id !== automation.id)
  save(workspace)
  rmSync(bankPath(workspace, automation.id), { recursive: true, force: true })
  return listAutomations()
}

export async function addLibraryClipsToAutomation(id: unknown, outputDir: unknown, clipIndices: unknown): Promise<Automation[]> {
  const library = loadSettings().outputDirectory
  if (typeof outputDir !== 'string' || !isWithinDirectory(outputDir, library)) throw new Error("Zadanie jest poza biblioteką.")
  if (!Array.isArray(clipIndices) || clipIndices.length === 0 || clipIndices.length > 30 ||
      !clipIndices.every((index) => Number.isSafeInteger(index) && index >= 0) ||
      new Set(clipIndices).size !== clipIndices.length) throw new Error("Wybierz do 30 różnych klipów.")
  const output = await getJobOutput(outputDir, library)
  if (!output) throw new Error("To zadanie nie jest już dostępne w bibliotece.")
  const clips = clipIndices.map((index) => output.clips.find((clip) => clip.clip_index === index))
  if (clips.some((clip) => !clip)) throw new Error('Wybrany klip nie należy już do tego zadania.')
  const paths = clips.map((clip) => {
    const url = clip!.s3_url
    const path = clipFilePath(url)
    if (!isWithinDirectory(path, outputDir)) throw new Error('Wybrany klip znajduje się poza tym zadaniem.')
    assertMediaPath(path, library)
    return path
  })
  const titles = clips.map((clip) => clip!.summary || `Klip ${clip!.clip_index + 1}`)
  return addAutomationContent(id, paths, titles)
}

export async function addAutomationContent(id: unknown, paths: string[], titles?: readonly string[]): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 30 || automation.content.length + paths.length > MAX_CONTENT) throw new Error("Wybierz maksymalnie 30 klipów naraz.")
  if (busy.has(automation.id)) throw new Error("Poczekaj na zakończenie bieżącej operacji.")
  busy.add(automation.id)
  const directory = bankPath(workspace, automation.id)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    for (const [index, path] of paths.entries()) {
      if (currentWorkspace() !== workspace || !cached.includes(automation)) throw new Error("Automatyzacja zmieniła się podczas dodawania treści.")
      authorizeMedia(path)
      const source = await openAuthorizedMedia(path, loadSettings().outputDirectory)
      const extension = extname(source.canonical).toLowerCase()
      const itemId = randomUUID()
      const fileName = `${itemId}${extension}`
      const dest = join(directory, fileName)
      try {
        if (!VIDEO_EXTENSIONS.has(extension)) throw new Error("Użyj klipów w formacie MP4, MOV, M4V lub WebM.")
        if (source.size === 0 || source.size > MAX_FILE_BYTES) throw new Error("Rozmiar klipu musi wynosić od 1 bajta do 5 GB.")
        const target = await open(dest, 'wx', 0o600)
        try { await pipeline(source.handle.createReadStream({ autoClose: false }), createWriteStream('', { fd: target.fd, autoClose: false })) }
        finally { await target.close() }
        const title = Array.from(titles?.[index] || basename(path, extname(path))).filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').replace(/[_-]+/g, ' ').trim().slice(0, 500) || "Klip bez tytułu"
        const item: AutomationContent = { id: itemId, fileName, title, caption: title, transcript: null, generatedMetadata: null, status: 'queued', addedAt: new Date().toISOString(), postedAt: null, postId: null, error: null }
        automation.content.push(item)
        try { save(workspace) }
        catch (error) { automation.content.pop(); throw error }
      } catch (error) {
        await unlink(dest).catch(() => {})
        throw error
      } finally { await source.handle.close() }
    }
  } finally { busy.delete(automation.id) }
  return listAutomations()
}

export function updateAutomationContent(id: unknown, contentId: unknown, raw: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item || !raw || typeof raw !== 'object') throw new Error("Nie znaleziono klipu")
  if (item.status === 'posting' || busy.has(automation.id)) throw new Error("Poczekaj na zakończenie bieżącej publikacji.")
  const update = raw as { title?: unknown; caption?: unknown; returnToQueue?: unknown }
  if (typeof update.title !== 'string' || !update.title.trim() || update.title.length > 500 ||
      typeof update.caption !== 'string' || update.caption.length > 63_206) throw new Error("Wpisz tytuł i opis o dopuszczalnej długości.")
  item.title = update.title.trim()
  item.caption = update.caption
  item.generatedMetadata = null
  if (update.returnToQueue === true) {
    if (item.status !== 'needs_review') throw new Error("Do kolejki można przywrócić tylko klipy wymagające sprawdzenia.")
    if (item.postId) throw new Error("Ten klip ma publikację w Zernio. Sprawdź ją lub ponów w sekcji Publikacje na stronie Konta.")
    item.status = 'queued'
    item.error = null
  }
  save(workspace)
  return listAutomations()
}

export function removeAutomationContent(id: unknown, contentId: unknown): Automation[] {
  const { workspace, automation } = find(id)
  const item = automation.content.find((content) => content.id === contentId)
  if (!item) throw new Error("Nie znaleziono klipu")
  if (item.status === 'posting' || busy.has(automation.id)) throw new Error("Poczekaj na zakończenie bieżącej publikacji.")
  automation.content = automation.content.filter((content) => content.id !== item.id)
  save(workspace)
  rmSync(join(bankPath(workspace, automation.id), item.fileName), { force: true })
  return listAutomations()
}

export async function runAutomation(id: unknown, slot?: { time: string; date: string }): Promise<Automation[]> {
  const { workspace, automation } = find(id)
  if (busy.has(automation.id)) return listAutomations()
  if (slot && (!automation.enabled || automation.lastSlots[slot.time] === slot.date)) return listAutomations()
  if (slot) { automation.lastSlots[slot.time] = slot.date; save(workspace) }
  const item = automation.content.find((content) => content.status === 'queued')
  if (!item) {
    automation.lastError = "Brak klipów w kolejce."
    save(workspace)
    return listAutomations()
  }
  if (!automation.profileId || automation.accounts.length === 0) {
    automation.lastError = "Wybierz jeden profil Zernio i przynajmniej jedno z jego kont."
    save(workspace)
    return listAutomations()
  }
  let submissionStarted = false
  busy.add(automation.id)
  try {
    checkProfileAccounts(await getZernioOverview(), automation.profileId, automation.accounts)
    if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
    const path = join(bankPath(workspace, automation.id), item.fileName)
    if (!isAutomationMedia(path)) throw new Error("Brakuje pliku klipu w bazie treści.")
    authorizeMedia(path)
    const facebookFormat = automation.metadataMode === 'ai' && automation.accounts.some((account) => account.platform === 'facebook')
      ? defaultFacebookFormat(await probeClipForPosting(path, null)) : 'feed'
    let generated: GeneratedPlatformMetadata[] | null = null
    if (automation.metadataMode === 'ai') {
      const platforms = [...new Set(automation.accounts.map((account) => account.platform))]
      if (!item.transcript) {
        const transcript = await transcribeAutomationClip(path)
        if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
        item.transcript = transcript
        save(workspace)
      }
      if (!item.generatedMetadata || item.generatedMetadata.some((post) => post.topicTag === undefined) ||
          !platforms.every((platform) => item.generatedMetadata?.some((post) => post.platform === platform))) {
        const metadata = await generateAutomationMetadata(item.transcript, item.title, item.caption, platforms, { facebookFormat })
        if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
        item.generatedMetadata = metadata
        save(workspace)
      }
      generated = item.generatedMetadata
    }
    const youtube = generated?.find((post) => post.platform === 'youtube')
    const facebook = generated?.find((post) => post.platform === 'facebook')
    const threads = generated?.find((post) => post.platform === 'threads')
    const request: PostClipRequest = {
      attemptId: randomUUID(), clipPath: path, clipTitle: item.title, durationMs: null, caption: item.caption,
      targets: automation.accounts.map((account) => ({ ...account, ...(generated?.find((post) => post.platform === account.platform)?.caption
        ? { customContent: generated.find((post) => post.platform === account.platform)!.caption } : {}) })), timing: { mode: 'now' },
      options: {
        youtube: automation.accounts.some((account) => account.platform === 'youtube')
          ? { title: youtube?.title || youtubeTitleFor(item.title) || "Klip bez tytułu", visibility: automation.youtubeVisibility, madeForKids: automation.youtubeMadeForKids,
              ...(youtube?.categoryId ? { categoryId: youtube.categoryId } : {}), ...(youtube?.tags?.length ? { tags: youtube.tags } : {}) } : undefined,
        instagram: automation.accounts.some((account) => account.platform === 'instagram') ? { shareToFeed: true } : undefined,
        facebook: automation.accounts.some((account) => account.platform === 'facebook') ? { format: facebookFormat,
          ...(facebookFormat === 'reel' && facebook?.title ? { title: facebook.title } : {}) } : undefined,
        threads: threads?.topicTag ? { topicTag: threads.topicTag } : undefined
      }
    }
    parsePostClipRequest(request)
    item.status = 'posting'
    item.error = null
    automation.lastRunAt = new Date().toISOString()
    automation.lastError = null
    save(workspace)
    const result = await publishClip(request, (progress) => {
      if (progress.phase === 'publishing') submissionStarted = true
    })
    if (currentWorkspace() !== workspace || !cached.includes(automation)) return []
    item.postId = result.post?.id ?? null
    if (result.post && !['failed', 'duplicate', 'partial'].includes(result.outcome)) {
      item.status = 'posted'
      item.postedAt = new Date().toISOString()
    } else {
      item.status = 'needs_review'
      item.error = result.outcome === 'partial' ? "Publikacja na niektórych kontach nie powiodła się. Sprawdź sekcję Publikacje na stronie Konta przed przywróceniem klipu do kolejki." : result.message
      automation.lastError = item.error
    }
    save(workspace)
  } catch (error) {
    if (currentWorkspace() === workspace && cached.includes(automation)) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Publikacja nie powiodła się. Sprawdź Zernio przed ponowieniem."
      if (item.status === 'posting') {
        item.status = submissionStarted ? 'needs_review' : 'queued'
        item.error = message
      } else if (item.status === 'queued') item.error = message
      automation.lastError = message
      save(workspace)
    }
    logger.warn('automation.post.failed', { automationId: automation.id, contentId: item.id })
  } finally { busy.delete(automation.id) }
  return listAutomations()
}

export function startAutomationScheduler(): () => void {
  const tick = (): void => {
    try {
      if (!loadSettings().zernioApiKey) return
      const now = Date.now()
      for (const automation of listAutomations()) {
        if (!automation.enabled) continue
        // Distinct automations can post together; one slow upload must not delay another account's slot.
        void (async () => {
          for (const slot of dueSlots(automation.times, automation.timezone, now)) await runAutomation(automation.id, slot)
        })().catch((error) => logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : "Nieznany błąd" }))
      }
    } catch (error) {
      logger.warn('automation.scheduler.failed', { message: error instanceof Error ? error.message : "Nieznany błąd" })
    }
  }
  const timer = setInterval(tick, 15_000)
  setTimeout(tick, 2_000)
  return () => clearInterval(timer)
}
