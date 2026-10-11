import { spawn } from 'child_process'
import { lookup } from 'dns'
import { existsSync } from 'fs'
import { isIP } from 'net'
import { dirname, join } from 'path'
import type { Readable, Writable } from 'stream'
import { isPublicAddress } from '../network-policy'
import { logger } from '../logger'
import { isUploadUrl, ZernioApiError } from './client'
import { recordUploadRoute, selectUploadAddress } from './posts-upload-route'

const abortError = (): Error => Object.assign(new Error('Przesyłanie anulowano.'), { code: 'ABORT_ERR' })
const WORKER_CODES = new Set([
  'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'CERTIFICATE_VERIFY_FAILED', 'PYTHON_TLS_ERROR', 'PYTHON_UPLOAD_FAILED', 'python_upload_unavailable', 'upload_incomplete'
])

async function publicAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw abortError()
  if (isIP(host)) return isPublicAddress(host) ? [host] : []
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    lookup(host, { all: true }, (error, addresses) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(abortError())
      else if (error) reject(error)
      else resolve(addresses.filter(({ address }) => isPublicAddress(address)).map(({ address }) => address))
    })
  })
}

/** The helper receives the authorized stream and signed URL through separate
 * private pipes. It never reopens the clip or receives provider credentials.
 */
export async function sendPythonUpload(
  uploadUrl: string, file: Readable, options: { contentType: string; size: number },
  signal: AbortSignal, maxMs: number
): Promise<void> {
  if (signal.aborted) throw abortError()
  // eslint-disable-next-line no-control-regex -- Explicitly reject control characters in paths and request headers.
  if (!isUploadUrl(uploadUrl) || /[\r\n\x00]/.test(options.contentType) || options.contentType.length > 256 ||
      !Number.isSafeInteger(options.size) || options.size < 1 || !Number.isFinite(maxMs) || maxMs <= 0) {
    throw new ZernioApiError('Nieprawidłowe dane przesyłania.', 502)
  }
  const host = new URL(uploadUrl).hostname.replace(/^\[|\]$/g, '')
  const addresses = await publicAddresses(host, signal)
  if (signal.aborted) throw abortError()
  if (!addresses.length) throw new ZernioApiError('Adres docelowy nie jest publiczny.', 0)
  const address = selectUploadAddress(host, addresses)

  // Resolve only when this transport is used; the Node transport does not need
  // the engine, settings store, or Electron's application paths.
  const { getEnginePath, getBridgeRunnerPath, resolvePythonPath } = await import('../pipeline-runner')
  const { loadSettings } = await import('../settings-store')
  const python = resolvePythonPath(getEnginePath(), loadSettings().pythonPath)
  const worker = join(dirname(getBridgeRunnerPath()), 'zernio_upload.py')
  if (!existsSync(worker)) throw new ZernioApiError('Nie znaleziono narzędzia przesyłania.', 0, 'python_upload_unavailable')
  if (signal.aborted) throw abortError()
  const config = JSON.stringify({ url: uploadUrl, contentType: options.contentType, size: options.size,
    addresses: [address], timeoutSeconds: Math.max(1, Math.ceil(maxMs / 1000)) })

  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ['-I', '-u', worker], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C' }
    })
    const input = child.stdin!
    const configPipe = child.stdio[3] as Writable
    let output = ''
    let streamError: Error | undefined
    let invalidOutput = false
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      file.unpipe(input)
      input.destroy()
      configPipe.destroy()
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimer.unref()
    }
    const deadline = setTimeout(() => { timedOut = true; stop() }, maxMs)
    const failedInput = (error: Error): void => {
      // Preserve a structured HTTP/TLS error from the worker when it closes
      // stdin before Node has finished writing the clip.
      streamError ??= error
      file.unpipe(input)
      file.pause()
    }
    const failedFile = (error: Error): void => { streamError = error; stop() }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      signal.removeEventListener('abort', stop)
      file.removeListener('error', failedFile)
      file.unpipe(input)
      input.destroy()
      configPipe.destroy()
      if (error) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', stop, { once: true })
    file.once('error', failedFile)
    input.on('error', failedInput)
    configPipe.on('error', failedInput)
    // Discard stderr entirely: a Python traceback could contain a signed URL.
    child.stderr!.resume()
    child.stdout!.on('data', (chunk: Buffer) => {
      if (invalidOutput) return
      if (Buffer.byteLength(output, 'utf8') + chunk.length > 4096) { invalidOutput = true; stop(); return }
      output += chunk.toString('utf8')
    })
    child.once('error', () => finish(new ZernioApiError('Nie można uruchomić narzędzia przesyłania.', 0, 'python_upload_unavailable')))
    child.once('close', (exitCode) => {
      if (settled) return
      if (signal.aborted) return finish(abortError())
      if (timedOut) {
        recordUploadRoute(host, address, false)
        return finish(Object.assign(new Error('Przekroczono czas przesyłania.'), { code: 'ETIMEDOUT' }))
      }
      let result: Record<string, unknown> | undefined
      if (!invalidOutput) {
        try {
          const value: unknown = JSON.parse(output)
          if (value && typeof value === 'object' && !Array.isArray(value)) result = value as Record<string, unknown>
        } catch { /* Only the fixed result protocol is accepted. */ }
      }
      const status = typeof result?.status === 'number' && Number.isInteger(result.status) &&
        (result.status === 0 || (result.status >= 100 && result.status <= 599)) ? result.status : null
      const bytes = typeof result?.bytes === 'number' && Number.isSafeInteger(result.bytes) &&
        result.bytes >= 0 && result.bytes <= options.size ? result.bytes : null
      const code = typeof result?.code === 'string' && WORKER_CODES.has(result.code) ? result.code : null
      const writeCode = typeof result?.writeCode === 'string' && WORKER_CODES.has(result.writeCode) ? result.writeCode : null
      const tls = result?.tls === 'TLSv1.2' || result?.tls === 'TLSv1.3' ? result.tls : null
      const mss = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) &&
        value > 0 && value <= 65535 ? value : null
      logger.info('zernio.upload.connection', { transport: 'python-https', exitCode, httpStatus: status,
        uploadedBytes: bytes, expectedBytes: options.size, code, writeCode, tls,
        serverAddress: address,
        tcpCompatibility: result?.tcpCompatibility === true,
        mssBefore: mss(result?.mssBefore), mssAfter: mss(result?.mssAfter) })
      if (status !== null && status >= 300) {
        return finish(new ZernioApiError(`Serwer przesyłania odrzucił plik (HTTP ${status}).`, status))
      }
      if (code === 'python_upload_unavailable' || code === 'upload_incomplete') {
        return finish(new ZernioApiError('Narzędzie nie potwierdziło przesłania pliku.', 0, code))
      }
      if (code) {
        if (['EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
          'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'].includes(code)) {
          recordUploadRoute(host, address, false)
        }
        return finish(Object.assign(new Error('Połączenie przesyłania zostało przerwane.'), { code }))
      }
      if (streamError) return finish(streamError)
      if (exitCode !== 0 || status === null || status < 200 || bytes !== options.size || !input.writableFinished) {
        return finish(new ZernioApiError('Serwer nie potwierdził odebrania całego pliku.', 0, 'upload_incomplete'))
      }
      recordUploadRoute(host, address, true)
      finish()
    })
    if (signal.aborted) stop()
    else { configPipe.end(config); file.pipe(input) }
  })
}
