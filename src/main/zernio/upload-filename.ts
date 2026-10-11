import { createHash } from 'crypto'
import { extname } from 'path'

/** Name only the remote upload. The authorized library file is never renamed. */
export function uploadFilename(title: string, clipPath: string, attemptId: string): string {
  const slug = title.replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
    .replace(/_+$/g, '') || 'klip'
  const suffix = createHash('sha256').update(clipPath).update('\0').update(attemptId).digest('hex').slice(0, 10)
  return `${slug}_${suffix}${extname(clipPath).toLowerCase()}`
}
