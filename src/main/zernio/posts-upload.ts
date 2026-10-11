import type { FileHandle } from 'fs/promises'
import { lookup as dnsLookup } from 'dns'
import { request as httpRequest, type ClientRequest, type RequestOptions } from 'http'
import { request as httpsRequest } from 'https'
import type { LookupFunction } from 'net'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import { setTimeout as delay } from 'timers/promises'
import { isPublicAddress } from '../network-policy'
import { isUploadUrl, ZernioApiError } from './client'
import { logger } from '../logger'
import { platform } from 'os'
import { sendSystemUpload, systemUploadTransport, type SystemUploadTransport } from './posts-upload-system'
import { sendPythonUpload } from './posts-upload-python'

type UploadTransport = SystemUploadTransport | 'python-tcp' | 'node'

export interface UploadOptions {
  contentType: string
  stableUpload?: boolean
  size: number
  onProgress?: (sent: number, total: number) => void
  onAttempt?: (info: UploadAttempt) => void
  signal?: AbortSignal
}

export interface UploadAttempt {
  attempt: number
  maxAttempts: number
  bytesPerSecond: number | null
}

export class ZernioUploadCancelledError extends ZernioApiError {
  constructor() {
    super("Przesyłanie anulowano.", 0)
  }
}

const STALL_MS = 60_000
/** Once every byte is sent, storage gets this long to confirm. */
const CONFIRM_MS = 120_000
/** Presigned upload URLs expire after an hour. */
const MAX_MS = 55 * 60_000
const RETRY_DELAYS = [1_000, 3_000]
const STABLE_RATES = [5, 2.5, 1].map(rate => rate * 1024 * 1024)
const STABLE_CHUNK_BYTES = 64 * 1024
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  // A corrupt TLS record ends that connection. Retry the same PUT on a fresh
  // socket; certificate and other TLS failures must still fail immediately.
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'CURL_HTTP2_ERROR'])

function transportCode(error: unknown): string | null {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown }
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)) return value.code
    current = value.cause
  }
  return null
}

// Validate at socket creation; retain the hostname for TLS SNI/certificate checks.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    const publicAddresses = addresses?.filter(({ address }) => isPublicAddress(address)) ?? []
    if (error || publicAddresses.length === 0) {
      callback(error ?? new Error('Adres docelowy nie jest publiczny'), '', 0)
      return
    }
    if (options.all) callback(null, publicAddresses)
    else callback(null, publicAddresses[0].address, publicAddresses[0].family)
  })
}

/** Native HTTP keeps a bounded pipe and surfaces early server rejections.
 * No redirects, reused sockets, URL logging or authorization headers.
 */
async function sendStream(uploadUrl: string, file: Readable, options: UploadOptions, signal: AbortSignal, secure: boolean): Promise<void> {
  let request: ClientRequest | undefined
  let continueTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let started = false
      let responded = false
      const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
        method: 'PUT', agent: false, signal, autoSelectFamily: true,
        ...(secure ? { lookup: publicLookup } : {}),
        headers: { 'Content-Type': options.contentType, 'Content-Length': String(options.size),
          Expect: '100-continue', Connection: 'close' }
      }
      request = (secure ? httpsRequest : httpRequest)(uploadUrl, requestOptions, response => {
        responded = true
        clearTimeout(continueTimer)
        const status = response.statusCode ?? 0
        response.on('error', reject)
        if (status < 200 || status >= 300) {
          // Reject before writing more bytes, retaining HTTP status instead of EPIPE.
          reject(new ZernioApiError(`Serwer przesyłania odrzucił plik (HTTP ${status}).`, status))
          response.destroy()
          return
        }
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 64 * 1024) response.destroy(new Error('Odpowiedź dostawcy jest zbyt duża'))
        })
        response.on('end', () => {
          if (!request?.writableFinished) {
            reject(new ZernioApiError('Serwer zakończył przesyłanie przed odebraniem całego pliku.', 0, 'upload_incomplete'))
          } else resolve()
        })
      })
      const start = (): void => {
        if (started || responded || request?.destroyed) return
        started = true
        clearTimeout(continueTimer)
        file.pipe(request!)
      }
      request.on('error', reject)
      file.once('error', reject)
      request.once('continue', start)
      // Some storage services ignore Expect; don't wait indefinitely for 100.
      continueTimer = setTimeout(start, 1500)
      request.flushHeaders()
    })
  } finally {
    clearTimeout(continueTimer)
    if (request) { file.unpipe(request); request.destroy() }
  }
}

/** Container types Zernio's presign accepts for the clip formats BridgeClip writes. */
const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

export function videoContentType(filePath: string): string | null {
  const match = /\.[^./\\]+$/.exec(filePath)
  return match ? VIDEO_TYPES[match[0].toLowerCase()] ?? null : null
}

/**
 * Stream a file to a presigned storage URL. The request carries no
 * Authorization header (storage authenticates by the signature in the URL),
 * reports progress as bytes leave the file, and aborts when nothing moves
 * for a minute.
 */
export async function putFile(uploadUrl: string, source: FileHandle, options: UploadOptions): Promise<void> {
  const started = Date.now()
  const original = await source.stat()
  let rateIndex = 0
  let pythonUnavailable = false
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new ZernioUploadCancelledError()
    const current = await source.stat()
    if (current.size !== options.size || current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
      throw new ZernioApiError('Klip zmienił się podczas przesyłania. Wybierz go ponownie.', 0)
    }
    const bytesPerSecond = options.stableUpload ? STABLE_RATES[rateIndex] : null
    const systemUpload = platform() === 'darwin' && isUploadUrl(uploadUrl)
    const transport: UploadTransport = systemUpload
      ? pythonUnavailable ? systemUploadTransport(attempt) : 'python-tcp'
      : 'node'
    const info: UploadAttempt = { attempt: attempt + 1, maxAttempts: RETRY_DELAYS.length + 1, bytesPerSecond }
    options.onAttempt?.(info)
    logger.info('zernio.upload.start', { ...info, total: options.size, stableUpload: options.stableUpload === true,
      transport })
    try {
      await putFileOnce(uploadUrl, source, options, Math.max(1, MAX_MS - (Date.now() - started)), bytesPerSecond, transport)
      logger.info('zernio.upload.complete', { ...info, total: options.size, elapsedMs: Date.now() - started })
      return
    } catch (error) {
      const unavailable = transport === 'python-tcp' && error instanceof ZernioApiError && error.code === 'python_upload_unavailable'
      if (unavailable) pythonUnavailable = true
      const transportFailure = error instanceof ZernioApiError && error.status === 0 &&
        (error.code === 'upload_stalled' || (error.code !== null && TRANSIENT_CODES.has(error.code)))
      const retryable = error instanceof ZernioApiError && !(error instanceof ZernioUploadCancelledError) &&
        ([408, 500, 502, 503, 504].includes(error.status) || transportFailure || unavailable)
      if (!retryable || attempt >= RETRY_DELAYS.length || Date.now() - started + RETRY_DELAYS[attempt] >= MAX_MS) throw error
      if (options.stableUpload && transportFailure) rateIndex = Math.min(rateIndex + 1, STABLE_RATES.length - 1)
      logger.info('zernio.upload.retry', { attempt: attempt + 2, code: error.code, status: error.status,
        bytesPerSecond: options.stableUpload ? STABLE_RATES[rateIndex] : null })
      try { await delay(RETRY_DELAYS[attempt], undefined, { signal: options.signal }) }
      catch { throw new ZernioUploadCancelledError() }
      // Retry only the same storage PUT, never the publication request.
      // Every attempt reads the authorized handle from byte zero.
      options.onProgress?.(0, options.size)
    }
  }
}

async function putFileOnce(uploadUrl: string, source: FileHandle, options: UploadOptions, maxMs: number, bytesPerSecond: number | null, transport: UploadTransport): Promise<void> {
  if (options.signal?.aborted) throw new ZernioUploadCancelledError()
  const secure = isUploadUrl(uploadUrl)
  if (!secure && !(uploadUrl.startsWith('http://') && isUploadUrl(uploadUrl, true))) {
    throw new ZernioApiError("Zernio nie zwróciło bezpiecznego adresu przesyłania.", 502)
  }
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })

  let sent = 0
  let lastActivity = Date.now()
  let stalled = false
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivity > (sent >= options.size ? CONFIRM_MS : STALL_MS)) {
      stalled = true
      controller.abort()
    }
  }, 2_000)
  const deadline = setTimeout(() => {
    stalled = true
    controller.abort()
  }, maxMs)

  // Destroying FileHandle.createReadStream also closes its handle, even with
  // autoClose:false. Positional reads preserve ownership for retries/caller.
  const chunkBytes = bytesPerSecond ? STABLE_CHUNK_BYTES : 256 * 1024
  const file = Readable.from((async function* () {
    let position = 0
    let nextChunkAt = performance.now()
    while (position < options.size && !controller.signal.aborted) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, options.size - position))
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) throw new ZernioApiError('Klip zmienił się podczas przesyłania. Wybierz go ponownie.', 0)
      if (bytesPerSecond) {
        // Pace each chunk, without catch-up bursts after a slow socket/read.
        nextChunkAt = Math.max(nextChunkAt, performance.now()) + bytesRead / bytesPerSecond * 1000
        await delay(Math.max(1, Math.ceil(nextChunkAt - performance.now())), undefined, { signal: controller.signal })
      }
      if (controller.signal.aborted) return
      position += bytesRead
      sent = position
      lastActivity = Date.now()
      options.onProgress?.(sent, options.size)
      yield buffer.subarray(0, bytesRead)
    }
  })(), { objectMode: false, highWaterMark: chunkBytes })
  const streamStopped = finished(file, { cleanup: true }).catch(() => {})

  try {
    if (transport === 'python-tcp') await sendPythonUpload(uploadUrl, file, options, controller.signal, maxMs)
    else if (transport !== 'node') await sendSystemUpload(uploadUrl, file, options, controller.signal, maxMs, transport)
    else await sendStream(uploadUrl, file, options, controller.signal, secure)
  } catch (error) {
    const code = stalled ? 'upload_stalled' : transportCode(error)
    logger.warn('zernio.upload.failed', { code, sent, total: options.size,
      status: error instanceof ZernioApiError ? error.status : 0, cancelled: options.signal?.aborted ?? false,
      stableUpload: options.stableUpload === true, bytesPerSecond, transport })
    if (error instanceof ZernioApiError) throw error
    if (options.signal?.aborted) throw new ZernioUploadCancelledError()
    throw new ZernioApiError(
      stalled ? 'Przesyłanie zatrzymało się. Spróbuj ponownie.' :
        `Przesyłanie przerwano${code ? ` (${code})` : ''}. Połączenie z serwerem plików zostało przerwane przed publikacją.`,
      0, code
    )
  } finally {
    controller.abort()
    clearInterval(watchdog)
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', cancel)
    file.destroy()
    await streamStopped
  }
}
