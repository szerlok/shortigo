/** Decode file URLs once; keep plain paths and legacy unescaped URLs usable. */
export function clipFilePath(url: string): string {
  if (!url.startsWith('file://')) return url
  let path = url.slice('file://'.length)
  try { path = decodeURIComponent(path) } catch { /* Legacy paths may contain a literal %. */ }
  if (/^\/[a-z]:\//i.test(path)) return path.slice(1)
  if (path.startsWith('localhost/')) return path.slice('localhost'.length)
  if (!path.startsWith('/') && !/^[a-z]:[/\\]/i.test(path)) return `//${path}`
  return path
}
