import { app } from 'electron'
import { constants, lstatSync, realpathSync } from 'fs'
import { mkdir, open, rmdir, stat, unlink } from 'fs/promises'
import { extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { safeRunName } from './run-folders'
import { openAuthorizedMedia } from './security'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.flv'])

/** Copy into the user's existing Google Drive sync folder, leaving the library file intact. */
export async function copyClipToGoogleDrive(
  clipPath: unknown,
  title: unknown,
  library: string
): Promise<{ folderName: string; fileName: string }> {
  if (typeof clipPath !== 'string' || typeof title !== 'string' || title.length > 500) {
    throw new Error('Nieprawidłowy klip lub tytuł')
  }

  const root = join(app.getPath('home'), 'BridgeClip', 'shortigo')
  let rootStat: ReturnType<typeof lstatSync>
  try { rootStat = lstatSync(root) }
  catch { throw new Error('Nie znaleziono folderu Dysku Google: ~/BridgeClip/shortigo. Sprawdź, czy Dysk Google jest połączony.') }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Folder Dysku Google jest niedostępny lub ma nieprawidłowy typ.')
  }
  const canonicalRoot = realpathSync(root)
  const source = await openAuthorizedMedia(clipPath, library)
  let folder: string | null = null
  let targetPath: string | null = null
  try {
    const extension = extname(source.canonical).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(extension)) throw new Error('Na Dysk Google można wysłać tylko plik wideo.')
    const name = safeRunName(title.replace(/\.(mp4|m4v|mov|webm|mkv|avi|flv)$/i, ''))
    let folderName = name
    for (let suffix = 2; ; suffix++) {
      try {
        const candidate = join(canonicalRoot, folderName)
        await mkdir(candidate, { mode: 0o700 })
        folder = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || suffix > 10000) throw error
        folderName = `${name} (${suffix})`
      }
    }

    const fileName = `${name}${extension}`
    targetPath = join(folder, fileName)
    const target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await pipeline(
        source.handle.createReadStream({ autoClose: false }),
        target.createWriteStream({ autoClose: false })
      )
    } finally {
      await target.close()
    }
    if ((await stat(targetPath)).size !== source.size) {
      throw new Error('Kopia klipu ma inny rozmiar niż oryginał. Spróbuj ponownie.')
    }
    return { folderName, fileName }
  } catch (error) {
    if (targetPath) await unlink(targetPath).catch(() => {})
    if (folder) await rmdir(folder).catch(() => {})
    throw error
  } finally {
    await source.handle.close()
  }
}
