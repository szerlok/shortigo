import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { nativeImage } from 'electron'
import { realpathSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { JobOutput } from '../shared/job-output'
import { THUMBNAIL_MODEL_CHOICES, validateThumbnailRequest, type ThumbnailAspectRatio, type ThumbnailEdit, type ThumbnailModel } from '../shared/thumbnail'
import { readLibraryClip } from './clip-library'
import { loadSettings } from './settings-store'
import { assertAbsolutePath, assertMediaPath, authorizeMedia } from './security'
import { exportingClips } from './title-editor'
import { resolveBinary } from './tools'

const API = 'https://openrouter.ai/api/v1/images'
const RATIOS: ThumbnailAspectRatio[] = ['9:16', '16:9', '1:1']
const active = new Set<string>()
type RecordValue = Record<string, unknown>
type Choice = typeof THUMBNAIL_MODEL_CHOICES[number]
type ModelRoute = { model: ThumbnailModel; provider: string; resolution: string }
let catalogue: { expires: number; routes: ModelRoute[] } | null = null
let loading: Promise<ModelRoute[]> | null = null
function record(v: unknown): v is RecordValue { return !!v && typeof v === 'object' && !Array.isArray(v) }
function money(value: number): string { return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}` }

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error('OpenRouter zwrócił pustą odpowiedź')
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body.cancel()
    throw new Error('Odpowiedź OpenRouter przekracza dozwolony rozmiar')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new Error('Odpowiedź OpenRouter przekracza dozwolony rozmiar')
      chunks.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Nieprawidłowa odpowiedź OpenRouter') }
  } finally { await reader.cancel().catch(() => undefined) }
}

async function catalogueJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), redirect: 'error' })
  if (!response.ok) { await response.body?.cancel(); throw new Error('Nie udało się pobrać cennika OpenRouter') }
  return await boundedJson(response, 2 * 1024 * 1024)
}

function accepts(p: RecordValue, key: string, value: string): boolean {
  const descriptor = p[key]
  return record(descriptor) && Array.isArray(descriptor.values) && descriptor.values.includes(value)
}

function availableRoute(choice: Choice, endpoint: unknown): ModelRoute | null {
  if (!record(endpoint) || typeof endpoint.provider_tag !== 'string' || !endpoint.provider_tag ||
      !record(endpoint.supported_parameters) || !Array.isArray(endpoint.pricing)) return null
  const parameters = endpoint.supported_parameters
  const references = parameters.input_references
  if (!record(references) || typeof references.max !== 'number' || references.max < 1 ||
      typeof references.min === 'number' && references.min > 1 || !accepts(parameters, 'resolution', choice.resolution)) return null
  const ratios = RATIOS.filter(ratio => accepts(parameters, 'aspect_ratio', ratio))
  if (!ratios.length) return null
  const lines = endpoint.pricing.filter(line => record(line) &&
    (line.variant === undefined || typeof line.variant === 'string' && line.variant.toLowerCase() === choice.resolution.toLowerCase())) as RecordValue[]
  if (!lines.some(line => line.billable === 'output_image')) return null
  let price = 0, estimate = false
  for (const line of lines) {
    if (typeof line.cost_usd !== 'number' || !Number.isFinite(line.cost_usd) || line.cost_usd < 0) return null
    if (line.unit === 'image' && ['output_image', 'input_image', 'input_reference'].includes(String(line.billable))) price += line.cost_usd
    else if (line.unit === 'token' && line.billable === 'output_image' && choice.id.startsWith('google/gemini-3.1-')) {
      // Google documents 1120 image output tokens at 1K. Input, reasoning and
      // text tokens vary, so this is explicitly an output-only estimate.
      // https://ai.google.dev/gemini-api/docs/pricing
      price += line.cost_usd * 1120
      estimate = true
    } else return null
  }
  return {
    provider: endpoint.provider_tag,
    resolution: choice.resolution,
    model: { ...choice, available: true, priceUsd: price, priceKind: estimate ? 'estimate' : 'fixed',
      priceLabel: estimate ? `ok. ${money(price)} za obraz + koszt danych wejściowych i tekstu` : `${money(price)} / miniaturkę (z kadrem)`,
      aspectRatios: ratios, pricingUpdatedAt: new Date().toISOString() }
  }
}

function unavailable(choice: Choice): ModelRoute {
  return { provider: '', resolution: choice.resolution, model: { ...choice, available: false, priceUsd: null,
    priceKind: 'unknown', priceLabel: 'Nie udało się potwierdzić dostępności lub ceny', aspectRatios: [], pricingUpdatedAt: null } }
}

async function loadCatalogue(): Promise<ModelRoute[]> {
  let models: RecordValue[]
  try {
    const data = await catalogueJson(`${API}/models`)
    if (!record(data) || !Array.isArray(data.data)) throw new Error('Nieprawidłowy katalog modeli')
    models = data.data.filter(record)
  } catch { return THUMBNAIL_MODEL_CHOICES.map(unavailable) }
  return await Promise.all(THUMBNAIL_MODEL_CHOICES.map(async choice => {
    try {
      const model = models.find(m => m.id === choice.id)
      if (!model || !record(model.architecture) || !Array.isArray(model.architecture.input_modalities) ||
          !model.architecture.input_modalities.includes('image') || !Array.isArray(model.architecture.output_modalities) ||
          !model.architecture.output_modalities.includes('image')) return unavailable(choice)
      const result = await catalogueJson(`${API}/models/${choice.id}/endpoints`)
      if (!record(result) || !Array.isArray(result.endpoints)) return unavailable(choice)
      return result.endpoints.map(endpoint => availableRoute(choice, endpoint)).filter((route): route is ModelRoute => !!route)
        .sort((a, b) => (a.model.priceUsd ?? Infinity) - (b.model.priceUsd ?? Infinity))[0] ?? unavailable(choice)
    } catch { return unavailable(choice) }
  }))
}

async function routes(): Promise<ModelRoute[]> {
  if (catalogue && catalogue.expires > Date.now()) return catalogue.routes
  if (!loading) loading = loadCatalogue().then(result => {
    catalogue = { routes: result, expires: Date.now() + (result.every(r => r.model.available) ? 5 * 60_000 : 15_000) }
    return result
  }).finally(() => { loading = null })
  return await loading
}

export async function listThumbnailModels(): Promise<ThumbnailModel[]> {
  return (await routes()).map(route => ({ ...route.model, aspectRatios: [...route.model.aspectRatios] }))
}

function extractFrame(source: string, frameMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBinary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', (frameMs / 1000).toFixed(3),
      '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv',
      '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,setsar=1",
      '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0, settled = false
    const fail = (message: string): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message)) }
    const timer = setTimeout(() => fail('Nie udało się odczytać kadru w wyznaczonym czasie'), 20_000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) fail('Wybrany kadr jest zbyt duży'); else chunks.push(chunk) })
    child.on('error', () => fail('Nie można uruchomić narzędzia do odczytu kadru'))
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0 || size < 32) { reject(new Error('Nie udało się odczytać kadru. Wybierz wcześniejszy moment filmu.')); return }
      resolve(Buffer.concat(chunks))
    })
  })
}

/** Read dimensions before decoding, so a small compressed response cannot allocate an enormous bitmap. */
function imageHeader(data: Buffer): { width: number; height: number; extension: string } | null {
  if (data.length < 32) return null
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), extension: 'png' }
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) return null
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      if (offset + 2 > data.length) return null
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length) return null
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3), extension: 'jpg' }
      offset += length
    }
  }
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const type = data.toString('ascii', 12, 16)
    if (type === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1, extension: 'webp' }
    if (type === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff, extension: 'webp' }
    if (type === 'VP8L' && data[20] === 0x2f) return { width: 1 + (((data[22] & 0x3f) << 8) | data[21]), height: 1 + (((data[24] & 0xf) << 10) | (data[23] << 2) | ((data[22] & 0xc0) >> 6)), extension: 'webp' }
  }
  return null
}

function decodeImage(result: unknown): { image: Buffer; extension: string; costUsd: number | null } {
  if (!record(result) || !Array.isArray(result.data) || result.data.length !== 1 || !record(result.data[0]) ||
      typeof result.data[0].b64_json !== 'string') throw new Error('OpenRouter nie zwrócił miniaturki')
  const encoded = result.data[0].b64_json
  if (encoded.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Nieprawidłowy obraz zwrócony przez OpenRouter')
  const image = Buffer.from(encoded, 'base64')
  const header = imageHeader(image)
  if (!header || header.width < 64 || header.height < 64 || header.width > 8192 || header.height > 8192 || header.width * header.height > 20_000_000) {
    throw new Error('OpenRouter zwrócił nieobsługiwany format lub rozmiar miniaturki')
  }
  const decoded = nativeImage.createFromBuffer(image)
  const dimensions = decoded.getSize()
  if (decoded.isEmpty() || dimensions.width !== header.width || dimensions.height !== header.height) throw new Error('Miniaturka zwrócona przez OpenRouter jest uszkodzona')
  const cost = record(result.usage) ? result.usage.cost : null
  return { image, extension: header.extension, costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null }
}

function apiError(status: number): Error {
  const detail = status === 401 ? 'Sprawdź klucz OpenRouter w ustawieniach.' : status === 402 ? 'Doładuj środki OpenRouter lub sprawdź limit klucza.'
    : status === 429 ? 'Limit OpenRouter został osiągnięty. Spróbuj później.' : status === 400 || status === 422 ? 'Model odrzucił polecenie lub kadr. Zmień polecenie albo wybierz inny model.'
    : status === 403 ? 'Ten model jest niedostępny dla Twojego klucza OpenRouter.' : 'Dostawca modelu nie zrealizował żądania. Spróbuj później.'
  return new Error(`Nie udało się utworzyć miniaturki (OpenRouter ${status}). ${detail}`)
}

export async function generateClipThumbnail(directory: unknown, index: unknown, value: unknown): Promise<{ output: JobOutput | null; path: string; costUsd: number | null }> {
  assertAbsolutePath(directory)
  const request = validateThumbnailRequest(value)
  const settings = loadSettings()
  if (!settings.openrouterApiKey) throw new Error('Dodaj klucz OpenRouter w ustawieniach, aby tworzyć miniaturki')
  const ctx = readLibraryClip(settings.outputDirectory, directory, index)
  const key = `${ctx.directory}:${index}`
  if (active.has(key)) throw new Error('Miniaturka tego klipu jest już tworzona')
  if (exportingClips.has(ctx.directory)) throw new Error('Poczekaj na zakończenie eksportu klipu')
  if (request.title !== ctx.clip.summary?.trim()) throw new Error('Tytuł klipu zmienił się. Zapisz aktualny tytuł przed utworzeniem miniaturki.')
  if (request.frameMs >= ctx.clip.duration_ms) throw new Error('Wybierz kadr przed końcem klipu')
  const sourceUrl = ctx.clip.title_base_url || ctx.clip.s3_url
  const source = fileURLToPath(sourceUrl)
  assertMediaPath(source, settings.outputDirectory)
  if (realpathSync(source) !== source || dirname(source) !== ctx.directory) throw new Error('Nieprawidłowe źródło kadru')
  active.add(key)
  exportingClips.add(ctx.directory)
  try {
    const route = (await routes()).find(entry => entry.model.id === request.modelId)
    if (!route?.model.available || !route.model.aspectRatios.includes(request.aspectRatio)) throw new Error('Nie można potwierdzić ceny lub obsługi tego formatu. Odśwież listę modeli.')
    const frame = await extractFrame(source, request.frameMs)
    const before = readLibraryClip(settings.outputDirectory, ctx.directory, index)
    if (before.clip.summary?.trim() !== request.title || (before.clip.title_base_url || before.clip.s3_url) !== sourceUrl) {
      throw new Error('Klip zmienił się podczas wybierania kadru. Otwórz miniaturkę ponownie.')
    }
    let response: Response
    let result: unknown
    try {
      response = await fetch(API, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5 * 60_000),
        headers: { Authorization: `Bearer ${settings.openrouterApiKey}`, 'Content-Type': 'application/json', 'X-Title': 'Shortigo' },
        body: JSON.stringify({ model: request.modelId, prompt: `Tytuł klipu: ${request.title}\n\n${request.prompt}`,
          n: 1, resolution: route.resolution, aspect_ratio: request.aspectRatio,
          input_references: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frame.toString('base64')}` } }],
          provider: { only: [route.provider], allow_fallbacks: false } })
      })
      if (!response.ok) { await response.body?.cancel(); throw apiError(response.status) }
      result = await boundedJson(response, 26 * 1024 * 1024)
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('Przekroczono czas tworzenia miniaturki. Nie ponowiono żądania automatycznie.')
      if (error instanceof TypeError) throw new Error('Połączenie z OpenRouter zostało przerwane. Nie ponowiono żądania automatycznie.')
      throw error
    }
    const generated = decodeImage(result)
    // No awaits between the final read and atomic metadata replacement: preserve
    // favorites, publication markers and other edits made during the API call.
    const id = randomUUID()
    const destination = join(ctx.directory, `clip_${String(index).padStart(2, '0')}.cover-${id}.${generated.extension}`)
    const temporary = join(ctx.directory, `.cover-${id}.json`)
    // Keep a paid, successfully generated image even if metadata subsequently
    // becomes unavailable. The error gives the user the retained local path.
    writeFileSync(destination, generated.image, { flag: 'wx', mode: 0o600 })
    try {
      const current = readLibraryClip(settings.outputDirectory, ctx.directory, index)
      const edit: ThumbnailEdit = { ...request, createdAt: new Date().toISOString(), costUsd: generated.costUsd }
      const clip = current.raw.clips.find((c: { clip_index: number }) => c.clip_index === index)
      Object.assign(clip, { thumbnail_url: pathToFileURL(destination).href, thumbnail_edit: edit })
      writeFileSync(temporary, JSON.stringify(current.raw, null, 2), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, current.metadata)
      authorizeMedia(destination)
      return { output: readLibraryClip(settings.outputDirectory, ctx.directory, index).output, path: destination, costUsd: generated.costUsd }
    } catch {
      throw new Error(`Miniaturka została utworzona i zapisana w ${destination}, ale nie udało się przypisać jej do biblioteki. Plik został zachowany.`)
    } finally {
      rmSync(temporary, { force: true })
    }
  } finally { active.delete(key); exportingClips.delete(ctx.directory) }
}
