import { spawn } from 'child_process'
import { accessSync, constants } from 'fs'
import { lookup } from 'dns'
import { isIP } from 'net'
import type { Readable, Writable } from 'stream'
import { isPublicAddress } from '../network-policy'
import { isUploadUrl, ZernioApiError } from './client'
import { logger } from '../logger'
import { recordUploadRoute, selectUploadAddress } from './posts-upload-route'

const abortError = (): Error => Object.assign(new Error('Przesyłanie anulowano.'), { code: 'ABORT_ERR' })

export type SystemUploadTransport = 'macos-openssl' | 'macos-system'

/** Use the native Apple Silicon/OpenSSL curl when present; alternate TLS stacks on retry. */
export function systemUploadTransport(attempt: number): SystemUploadTransport {
  if (attempt % 2 === 1 || process.arch !== 'arm64') return 'macos-system'
  try {
    accessSync('/opt/homebrew/opt/curl/bin/curl', constants.X_OK)
    return 'macos-openssl'
  } catch {
    return 'macos-system'
  }
}

async function uploadAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw abortError()
  if (isIP(host)) return isPublicAddress(host) ? [host] : []
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    lookup(host, { all: true }, (error, addresses) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(abortError())
      else if (error) reject(error)
      else {
        const publicAddresses = addresses.filter(({ address }) => isPublicAddress(address))
        // Prefer IPv4, retaining IPv6 as another route if IPv4 transfers fail.
        resolve(publicAddresses.sort((a, b) => a.family - b.family).map(({ address }) => address))
      }
    })
  })
}

function configValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- Explicitly reject control characters in paths and request headers.
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Nieprawidłowy adres przesyłania.')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** macOS ships curl with a separate TLS implementation from Electron/Node.
 * Stream the already-authorized handle via stdin; never reopen its pathname.
 * The signed URL travels through a private config pipe, not argv or a file.
 */
export async function sendSystemUpload(
  uploadUrl: string, file: Readable, options: { contentType: string; size: number },
  signal: AbortSignal, maxMs: number, transport: SystemUploadTransport = 'macos-system'
): Promise<void> {
  // eslint-disable-next-line no-control-regex -- Explicitly reject control characters in paths and request headers.
  if (!isUploadUrl(uploadUrl) || /[\r\n\x00]/.test(options.contentType)) {
    throw new ZernioApiError('Nieprawidłowy adres przesyłania.', 502)
  }
  const url = new URL(uploadUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = await uploadAddresses(host, signal)
  if (signal.aborted) throw abortError()
  if (addresses.length === 0) throw new ZernioApiError('Adres docelowy nie jest publiczny.', 0)
  const address = selectUploadAddress(host, addresses)
  const ipFamily = isIP(address)

  const config = `url = ${configValue(uploadUrl)}\n`
  const curlBinary = transport === 'macos-openssl' ? '/opt/homebrew/opt/curl/bin/curl' : '/usr/bin/curl'
  const args = [
    '-q', '--config', '/dev/fd/3', '--silent', '--show-error', '--globoff', '--path-as-is',
    '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '0',
    '--proxy', '', '--noproxy', '*',
    ...(transport === 'macos-openssl' ? ['--http1.1'] : ['--http2', '--tlsv1.2', '--tls-max', '1.2']),
    ...(ipFamily === 4 ? ['--ipv4'] : ipFamily === 6 ? ['--ipv6'] : []),
    '--connect-timeout', '30', '--max-time', String(Math.max(1, Math.ceil(maxMs / 1000))),
    '--retry', '0', '--upload-file', '-',
    '--header', `Content-Type: ${options.contentType}`, '--header', `Content-Length: ${options.size}`,
    '--header', 'Transfer-Encoding:', '--header', 'Expect:',
    '--output', '/dev/null', '--max-filesize', '65536',
    '--write-out', '%{http_code} %{size_upload} %{http_version}'
  ]
  // Pin public DNS results without changing the hostname used for certificates
  // or SNI. IP literals have already been checked and need no DNS override.
  if (!isIP(host)) args.push('--resolve', `${host}:443:${ipFamily === 6 ? `[${address}]` : address}`)

  await new Promise<void>((resolve, reject) => {
    // Ignore shell/curl configuration and proxy/CA override environment vars.
    const child = spawn(curlBinary, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' }
    })
    const input = child.stdin!
    const configPipe = child.stdio[3] as Writable
    let result = ''
    let diagnostic = ''
    let streamError: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const stop = (): void => {
      file.unpipe(input)
      input.destroy()
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimer.unref()
    }
    const failedInput = (error: Error): void => {
      // An early HTTP/TLS rejection closes stdin. Wait for curl's exit to retain
      // its HTTP status/TLS error, instead of reporting only the pipe's EPIPE.
      streamError ??= error
      file.unpipe(input)
      file.pause()
    }
    const failedFile = (error: Error): void => { streamError = error; stop() }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
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
    child.stderr!.on('data', (chunk: Buffer) => {
      // Parse only fixed diagnostic categories. Never persist or return stderr:
      // it can contain the signed upload URL or other provider data.
      if (diagnostic.length < 4096) diagnostic += chunk.toString('utf8').slice(0, 4096 - diagnostic.length)
    })
    child.stdout!.on('data', (chunk: Buffer) => {
      result += chunk.toString('utf8')
      if (result.length > 128) { streamError = new Error('Nieprawidłowa odpowiedź przesyłania.'); stop() }
    })
    child.once('error', () => finish(new ZernioApiError('Nie można uruchomić systemowego wysyłania pliku.', 0, 'system_upload_unavailable')))
    child.once('close', (exitCode, exitSignal) => {
      if (signal.aborted) return finish(abortError())
      const match = /^(\d{3}) (\d+) ([\d.]+)$/.exec(result.trim())
      const status = match ? Number(match[1]) : 0
      const detail = /bad[_ ]record[_ ]mac|bad decrypt/i.test(diagnostic) ? 'tls_bad_record_mac'
        : /SSLWrite|SSL_write/i.test(diagnostic) ? 'tls_write_failed'
          : /SSLRead|SSL_read/i.test(diagnostic) ? 'tls_read_failed'
            : /certificate/i.test(diagnostic) ? 'certificate_failed'
              : /reset by peer/i.test(diagnostic) ? 'connection_reset'
                : /broken pipe/i.test(diagnostic) ? 'broken_pipe'
                  : /timed? out/i.test(diagnostic) ? 'connection_timeout' : null
      logger.info('zernio.upload.connection', { transport, exitCode, exitSignal, httpStatus: status,
        uploadedBytes: match ? Number(match[2]) : null, expectedBytes: options.size, detail,
        httpVersion: match?.[3] ?? null, ipFamily, serverAddress: address,
        inputCode: (streamError as NodeJS.ErrnoException | undefined)?.code ?? null })
      if (status >= 300) return finish(new ZernioApiError(`Serwer przesyłania odrzucił plik (HTTP ${status}).`, status))
      if (exitCode !== 0) {
        if ([7, 18, 28, 52, 55, 56, 16, 92].includes(exitCode ?? -1)) recordUploadRoute(host, address, false)
        const codes: Record<number, string> = {
          6: 'EAI_AGAIN', 7: 'ECONNREFUSED', 18: 'ECONNRESET', 28: 'ETIMEDOUT',
          35: 'CURL_TLS_ERROR', 51: 'CURL_CERTIFICATE_ERROR', 52: 'ECONNRESET',
          55: 'EPIPE', 56: 'ECONNRESET', 60: 'CURL_CERTIFICATE_ERROR',
          16: 'CURL_HTTP2_ERROR', 92: 'CURL_HTTP2_ERROR'
        }
        // Never include raw stderr, request URL or subprocess arguments.
        return finish(Object.assign(new Error('Systemowe połączenie przesyłania zostało przerwane.'),
          { code: codes[exitCode ?? -1] ?? 'SYSTEM_UPLOAD_FAILED' }))
      }
      if (streamError) return finish(streamError)
      if (status < 200 || !match || Number(match[2]) !== options.size || !input.writableFinished) {
        return finish(new ZernioApiError('Serwer nie potwierdził odebrania całego pliku.', 0, 'upload_incomplete'))
      }
      recordUploadRoute(host, address, true)
      finish()
    })
    if (signal.aborted) stop()
    else { configPipe.end(config); file.pipe(input) }
  })
}
