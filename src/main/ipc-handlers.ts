import { musicTracks, editMusic, clearMusicPreview } from './music-editor'
import { checkedRunFolder, deleteRunFolder, renameRunFolder } from './run-folders'
import { readLibraryClip, setClipFavorite, deleteLibraryClip } from './clip-library'
import { copyClipToGoogleDrive } from './drive-export'
import type { FavoriteClip } from '../shared/clip-library'
import { rangeContext, rangePreview, exportRange, isPreparingRangePreview } from './range-editor'
import { loadClipProject, saveClipProject, importClipAsset, previewClipProject, exportClipProject } from './clip-editor'
import { previewTitle, exportTitle, exportingClips } from './title-editor'
import { listThumbnailModels, generateClipThumbnail } from './thumbnail-generator'
import { renameClipTitle } from './clip-title'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, realpathSync } from 'fs'
import { loadSettings, publicSettings, replaceApiKey, savePublicSettings, type ApiKeyName, type PublicSettings } from './settings-store'
import { ensureOutputDir, getJobHistory, getJobOutput, generateThumbnail } from './file-manager'
import {
  getEnginePath,
  getBridgeRunnerPath,
  resolvePythonPath,
  validatePython,
  preflightCheck,
  type ClipJobConfig
} from './pipeline-runner'
import { createRunRecord, finishRunRecord } from './run-history'
import { cancelTrackedJob, dismissJob, enqueueJob, initJobManager, listJobs, liveJobIds, updateJobLocation } from './job-manager'
import { logger, getLogFilePath } from './logger'
import { assertAbsolutePath, assertMediaPath, assertTrustedSender, authorizeMedia, isTrustedExternalUrl, isWebUrl, isWithinDirectory, openAuthorizedMedia } from './security'
import { assertPublicWebUrl } from './network-policy'
import { validateJobConfig } from './validation'
import { randomUUID } from 'crypto'
import { resolveBinary, supportsCaptionFilter } from './tools'
import { addAutomationContent, addLibraryClipsToAutomation, createAutomation, deleteAutomation, isAutomationMedia, listAutomations, removeAutomationContent, runAutomation, updateAutomation, updateAutomationContent } from './automations'
import {
  cancelZernioConnect,
  connectZernioAccount,
  createZernioProfile,
  disconnectZernioAccount,
  getPendingZernioConnect,
  getZernioOverview,
  readCachedOverview,
  resetZernioState,
  syncZernioAccounts
} from './zernio/service'
import {
  cancelPost,
  cancelUpload,
  dismissPost,
  getTikTokCreatorInfo,
  listPosts,
  openPostLink,
  openTikTokLegal,
  probeClipForPosting,
  publishClip,
  refreshPosts,
  reschedulePost,
  retryPost
} from './zernio/posts'

/** A passing engine check is reused briefly, so queuing several videos stays quick. */
const ENGINE_CHECK_TTL_MS = 5 * 60 * 1000

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  const selectedOutputDirectories = new Set<string>()
  let lastEngineCheck: { key: string; at: number } | null = null
  initJobManager(getMainWindow)
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, getMainWindow())
    return listener(event, ...args)
  })
  handle('settings:load', () => {
    return publicSettings(loadSettings())
  })

  handle('settings:save', (_event, settings: PublicSettings) => {
    const current = loadSettings()
    if (!settings || typeof settings !== 'object') throw new Error("Nieprawidłowe ustawienia")
    if (typeof settings.outputDirectory !== 'string' || typeof settings.pythonPath !== 'string' || typeof settings.customVocabulary !== 'string') throw new Error("Nieprawidłowe ustawienia")
    if (settings.outputDirectory !== current.outputDirectory && !selectedOutputDirectories.has(settings.outputDirectory)) throw new Error("Wybierz folder zapisu przyciskiem wyboru folderu")
    if (app.isPackaged && settings.pythonPath !== current.pythonPath) throw new Error("Nie można zmieniać ścieżek narzędzi w zainstalowanej aplikacji")
    return savePublicSettings(settings)
  })

  handle('settings:replaceApiKey', (_event, key: ApiKeyName, value: string) => {
    const previousZernioKey = key === 'zernioApiKey' ? loadSettings().zernioApiKey : null
    const saved = replaceApiKey(key, value)
    // A different Zernio key may be a different workspace; drop the old one's accounts.
    if (previousZernioKey !== null && loadSettings().zernioApiKey !== previousZernioKey) resetZernioState(getMainWindow)
    return saved
  })

  // Social accounts via the user's own Zernio key (main process only).
  handle('zernio:overview', () => getZernioOverview())
  handle('zernio:profiles:create', (_event, name: unknown) => createZernioProfile(name))
  handle('zernio:sync', () => syncZernioAccounts())
  handle('zernio:cachedOverview', () => readCachedOverview())
  handle('zernio:pendingConnect', () => getPendingZernioConnect())
  handle('zernio:connect', (_event, platform: unknown, profileId: unknown, options: unknown) => connectZernioAccount(platform, profileId, options, getMainWindow))
  handle('zernio:cancelConnect', () => cancelZernioConnect())
  handle('zernio:disconnect', (_event, accountId: unknown) => disconnectZernioAccount(accountId))

  // Posting clips through Zernio. Uploads and post links stay in the main process.
  handle('zernio:posts:probe', (_event, clipPath: unknown, durationMs: unknown) => probeClipForPosting(clipPath, durationMs))
  handle('zernio:posts:tiktokCreatorInfo', (_event, accountId: unknown) => getTikTokCreatorInfo(accountId))
  handle('zernio:posts:publish', (event, request: unknown) => publishClip(request, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('zernio:postProgress', progress)
  }))
  handle('zernio:posts:cancelUpload', (_event, attemptId: unknown) => cancelUpload(attemptId))
  handle('zernio:posts:list', () => listPosts())
  handle('zernio:posts:refresh', (_event, force: unknown) => refreshPosts(force))
  handle('zernio:posts:cancel', (_event, postId: unknown) => cancelPost(postId))
  handle('zernio:posts:reschedule', (_event, postId: unknown, scheduledFor: unknown, timezone: unknown) => reschedulePost(postId, scheduledFor, timezone))
  handle('zernio:posts:retry', (_event, postId: unknown) => retryPost(postId))
  handle('zernio:posts:dismiss', (_event, postId: unknown) => dismissPost(postId))
  handle('zernio:posts:open', (_event, postId: unknown, targetIndex: unknown) => openPostLink(postId, targetIndex))
  handle('zernio:posts:openTikTokLegal', (_event, key: unknown) => openTikTokLegal(key))

  handle('automations:list', () => listAutomations())
  handle('automations:create', (_event, name: unknown) => createAutomation(name))
  handle('automations:update', (_event, id: unknown, update: unknown) => updateAutomation(id, update))
  handle('automations:delete', (_event, id: unknown) => deleteAutomation(id))
  handle('automations:run', (_event, id: unknown) => runAutomation(id))
  handle('automations:addLibraryClips', (_event, id: unknown, outputDir: unknown, clipIndices: unknown) => addLibraryClipsToAutomation(id, outputDir, clipIndices))
  handle('automations:updateContent', (_event, id: unknown, contentId: unknown, update: unknown) => updateAutomationContent(id, contentId, update))
  handle('automations:removeContent', (_event, id: unknown, contentId: unknown) => removeAutomationContent(id, contentId))
  handle('automations:addContent', async (_event, id: unknown) => {
    const window = getMainWindow()
    if (!window) return listAutomations()
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: "Dodaj klipy do automatyzacji",
      filters: [{ name: "Filmy do publikacji", extensions: ['mp4', 'mov', 'm4v', 'webm'] }]
    })
    return result.canceled ? listAutomations() : addAutomationContent(id, result.filePaths)
  })

  handle('settings:selectOutputDir', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: "Wybierz folder zapisu"
    })

    if (result.canceled || result.filePaths.length === 0) return null
    selectedOutputDirectories.add(result.filePaths[0])
    return result.filePaths[0]
  })

  handle('job:start', async (_event, config: ClipJobConfig) => {
    const window = getMainWindow()
    if (!window) {
      logger.warn('job.start.noWindow')
      return { error: "Brak okna" }
    }

    try {
      config = validateJobConfig(config)
      if (isWebUrl(config.videoUrl)) await assertPublicWebUrl(config.videoUrl)
      else assertMediaPath(config.videoUrl, loadSettings().outputDirectory)
      if (config.bannerChannelUrl) await assertPublicWebUrl(config.bannerChannelUrl)
    } catch (error) { return { error: error instanceof Error ? error.message : "Nieprawidłowe opcje zadania" } }
    const settings = loadSettings()

    if (!settings.openrouterApiKey) {
      logger.warn('job.start.missingKey', { key: 'OPENROUTER_API_KEY' })
      return { error: "Do planowania klipów przez AI potrzebny jest klucz API OpenRouter. Dodaj go w ustawieniach." }
    }

    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath()
    const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

    const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
    if (!preflight.ok) {
      const message = preflight.hint
        ? `${preflight.error}\n\n${preflight.hint}`
        : preflight.error!
      logger.error('job.start.preflight.failed', {
        error: preflight.error,
        hint: preflight.hint,
        pythonPath,
        bridgePath,
        enginePath
      })
      return { error: message }
    }
    const engineKey = `${pythonPath}\0${enginePath}`
    if (!lastEngineCheck || lastEngineCheck.key !== engineKey || Date.now() - lastEngineCheck.at > ENGINE_CHECK_TTL_MS) {
      const pythonValidation = await validatePython(pythonPath, enginePath)
      if (!pythonValidation.ok) {
        lastEngineCheck = null
        return { error: "Silnik tworzenia klipów jest niekompletny lub niezgodny. Otwórz Ustawienia → Sprawdzenie systemu i napraw instalację Shortigo." }
      }
      lastEngineCheck = { key: engineKey, at: Date.now() }
    }
    if (config.includeCaptions && !(await supportsCaptionFilter())) {
      return { error: "FFmpeg nie może tworzyć napisów z powodu braku filtra ass. Zainstaluj FFmpeg z libass lub wyłącz napisy." }
    }

    if ([...exportingClips].some(directory => isWithinDirectory(config.videoUrl, directory))) {
      return { error: 'Poczekaj na zakończenie operacji na folderze z wybranym filmem.' }
    }
    ensureOutputDir(settings.outputDirectory)

    const jobId = randomUUID()
    logger.info('job.start.request', { jobId, sourceType: isWebUrl(config.videoUrl) ? 'remote' : 'local', aspectRatio: config.aspectRatio })
    try {
      createRunRecord(settings.outputDirectory, jobId, config.videoUrl)
    } catch {
      try { finishRunRecord(settings.outputDirectory, jobId, 'failed', "Nie udało się rozpocząć zadania.") } catch { /* Output folder may be unavailable. */ }
      return { error: "Nie udało się utworzyć zadania. Sprawdź folder zapisu i spróbuj ponownie." }
    }
    // Starts now when a slot is free; otherwise waits its turn in the queue.
    const job = enqueueJob(jobId, config, settings.outputDirectory)
    return { jobId, queued: job.status === 'queued' }
  })

  handle('job:cancel', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return false
    logger.info('job.cancel.request', { jobId })
    return cancelTrackedJob(jobId)
  })

  handle('jobs:list', () => listJobs())
  handle('jobs:dismiss', (_event, jobId: unknown) => typeof jobId === 'string' && dismissJob(jobId))

  handle('diagnostics:getLogPath', () => {
    return getLogFilePath()
  })

  handle('diagnostics:openLogFolder', () => {
    const logFile = getLogFilePath()
    if (existsSync(logFile)) {
      shell.showItemInFolder(logFile)
      return true
    }
    return false
  })

  handle('clips:musicTracks', () => musicTracks())
  handle('clips:copyToGoogleDrive', (_event, path: unknown, title: unknown) =>
    copyClipToGoogleDrive(path, title, loadSettings().outputDirectory))
  handle('clips:thumbnailModels', () => listThumbnailModels())
  handle('clips:generateThumbnail', async (_event, directory, index, request) => {
    const result = await generateClipThumbnail(directory, index, request)
    if (result.output) updateJobLocation(result.output.job_id, directory, result.output)
    return result
  })
  handle('clips:renameTitle', async (_event, directory, index, title) => {
    const output = await renameClipTitle(directory, index, title)
    if (output) updateJobLocation(output.job_id, directory, output)
    return output
  })
  handle('clips:previewMusic', (_event, directory, index, edit) => editMusic(directory, index, edit, true))
  handle('clips:exportMusic', (_event, directory, index, edit) => editMusic(directory, index, edit, false))
  handle('clips:clearMusicPreview', (_event, path) => clearMusicPreview(path))
  handle('clips:rangePreview', (_event, directory, index, rebuild) => rangePreview(directory, index, rebuild))
  handle('clips:rangeContext', (_event, directory, index) => rangeContext(directory, index))
  handle('clips:exportRange', (_event, directory, index, range) => exportRange(directory, index, range))
  handle('clips:loadProject', (_event, directory, index) => loadClipProject(directory, index))
  handle('clips:saveProject', (_event, directory, index, project) => saveClipProject(directory, index, project))
  handle('clips:importAsset', (_event, directory, index, kind) => importClipAsset(getMainWindow(), directory, index, kind))
  handle('clips:previewProject', (_event, directory, index, project) => previewClipProject(directory, index, project))
  handle('clips:exportProject', (_event, directory, index, project) => exportClipProject(directory, index, project))
  handle('clips:previewTitle', (_event, directory, index, edit) => previewTitle(directory, index, edit))
  handle('clips:exportTitle', (_event, directory, index, edit) => exportTitle(directory, index, edit))

  handle('history:list', () => {
    const settings = loadSettings()
    return getJobHistory(settings.outputDirectory, liveJobIds())
  })

  const assertRunIdle = (directory: string, jobId: string): void => {
    const live = liveJobIds()
    if (live.has(jobId) || listJobs().some(job => live.has(job.id) && isWithinDirectory(job.request.videoUrl, directory))) {
      throw new Error('Najpierw zakończ lub anuluj zadanie korzystające z tego folderu.')
    }
    if (exportingClips.has(directory) || isPreparingRangePreview(directory)) throw new Error('Poczekaj na zakończenie eksportu lub przygotowania podglądu.')
  }
  handle('history:renameFolder', (_event, directory: unknown) => {
    assertAbsolutePath(directory)
    const library = loadSettings().outputDirectory
    const ctx = checkedRunFolder(library, directory)
    assertRunIdle(ctx.directory, ctx.jobId)
    const result = renameRunFolder(library, ctx.directory)
    updateJobLocation(result.jobId, result.directory, result.output)
    return result.directory
  })
  handle('clips:setFavorite', (_event, directory: unknown, index: unknown, favorite: unknown) => {
    assertAbsolutePath(directory)
    const library = loadSettings().outputDirectory
    const ctx = checkedRunFolder(library, directory)
    assertRunIdle(ctx.directory, ctx.jobId)
    const output = setClipFavorite(library, ctx.directory, index, favorite)
    updateJobLocation(ctx.jobId, ctx.directory, output)
    return output
  })
  handle('clips:listFavorites', async () => {
    const library = loadSettings().outputDirectory
    const result: FavoriteClip[] = []
    for (const entry of await getJobHistory(library, liveJobIds())) {
      if (entry.status !== 'completed') continue
      const output = await getJobOutput(entry.outputDir, library)
      if (!output) continue
      for (const clip of output.clips.filter(c => c.is_favorite)) {
        const settings = output.metrics?.requested_settings as { aspect_ratio?: string } | undefined
        result.push({ directory: entry.outputDir, sourceTitle: output.source_video_title,
          clip, canEditRange: !!output.edit_source_url, vertical: settings?.aspect_ratio !== '16:9' })
      }
    }
    return result
  })
  handle('clips:delete', async (_event, directory: unknown, index: unknown) => {
    assertAbsolutePath(directory)
    const library = loadSettings().outputDirectory
    const ctx = readLibraryClip(library, directory, index)
    assertRunIdle(ctx.directory, ctx.jobId)
    const window = getMainWindow()
    if (!window) return null
    exportingClips.add(ctx.directory)
    try {
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Usuń klip', message: `Usunąć „${ctx.clip.summary || 'Klip'}”?`,
        detail: 'Ten klip i jego zapisane wersje zostaną trwale usunięte z dysku oraz z ulubionych. Pozostałe klipy i wspólne źródło filmu pozostaną.',
        buttons: ['Anuluj', 'Usuń klip'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) return null
      const current = checkedRunFolder(library, ctx.directory)
      if (current.jobId !== ctx.jobId || liveJobIds().has(ctx.jobId) || listJobs().some(job => liveJobIds().has(job.id) && isWithinDirectory(job.request.videoUrl, ctx.directory))) throw new Error('Folder jest używany lub zmienił się. Spróbuj ponownie.')
      const output = deleteLibraryClip(library, ctx.directory, index)
      updateJobLocation(ctx.jobId, ctx.directory, output)
      return output
    } finally { exportingClips.delete(ctx.directory) }
  })
  handle('history:deleteRun', async (_event, directory: unknown) => {
    assertAbsolutePath(directory)
    const library = loadSettings().outputDirectory
    const ctx = checkedRunFolder(library, directory)
    assertRunIdle(ctx.directory, ctx.jobId)
    const window = getMainWindow()
    if (!window) return { deleted: false }
    exportingClips.add(ctx.directory)
    try {
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Usuń zadanie i pliki',
        message: `Usunąć „${ctx.title}”?`,
        detail: 'Cały folder zadania zostanie trwale usunięty z dysku: klipy, poprzednie wersje, zachowane źródło i podglądy. Kopie wyeksportowane poza ten folder pozostaną.\n\n' + ctx.directory,
        buttons: ['Anuluj', 'Usuń zadanie i pliki'], defaultId: 0, cancelId: 0, noLink: true
      })
      if (confirmation.response !== 1) return { deleted: false }
      // Recheck ownership and usage after the confirmation dialog.
      const current = checkedRunFolder(library, ctx.directory)
      if (current.jobId !== ctx.jobId || liveJobIds().has(ctx.jobId) || listJobs().some(job => liveJobIds().has(job.id) && isWithinDirectory(job.request.videoUrl, ctx.directory))) throw new Error('Folder jest używany lub zmienił się. Spróbuj ponownie.')
      await deleteRunFolder(library, ctx.directory)
      dismissJob(ctx.jobId)
      return { deleted: true, jobId: ctx.jobId }
    } finally { exportingClips.delete(ctx.directory) }
  })

  handle('history:getJob', (_event, outputDir: string) => {
    assertAbsolutePath(outputDir)
    if (!isWithinDirectory(outputDir, loadSettings().outputDirectory)) throw new Error("Zadanie jest poza biblioteką")
    return getJobOutput(outputDir, loadSettings().outputDirectory)
  })

  handle('thumbnails:generate', async (_event, videoPath: string, seekSeconds?: number) => {
    if (isAutomationMedia(videoPath)) authorizeMedia(videoPath)
    else assertMediaPath(videoPath, loadSettings().outputDirectory)
    if (seekSeconds !== undefined && (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > 6 * 60 * 60)) throw new Error("Nieprawidłowy czas miniatury")
    const thumbnail = await generateThumbnail(videoPath, seekSeconds)
    if (thumbnail) authorizeMedia(thumbnail)
    return thumbnail
  })

  handle('shell:openPath', async (_event, path: unknown) => {
    if (isWebUrl(path)) {
      if (!isTrustedExternalUrl(path)) throw new Error("Ten link zewnętrzny nie jest obsługiwany")
      await shell.openExternal(path)
      return true
    }
    assertAbsolutePath(path)
    if (!existsSync(path)) return false
    // Check and open the same canonical name: an alias can hide a .app suffix.
    const canonical = realpathSync(path)
    if (!isWithinDirectory(canonical, loadSettings().outputDirectory)) assertMediaPath(canonical, loadSettings().outputDirectory)
    const { statSync } = await import('fs')
    if (statSync(canonical).isDirectory()) {
      if (canonical.split(/[\\/]+/).some((part) => /\.(app|bundle)$/i.test(part))) throw new Error("Nie można otwierać aplikacji z biblioteki")
    } else {
      assertMediaPath(canonical, loadSettings().outputDirectory)
    }
    return (await shell.openPath(canonical)) === ''
  })

  handle('shell:showItemInFolder', (_event, path: string) => {
    assertAbsolutePath(path)
    if (!isWithinDirectory(path, loadSettings().outputDirectory)) assertMediaPath(path, loadSettings().outputDirectory)
    if (!existsSync(path)) return false
    shell.showItemInFolder(path)
    return true
  })

  handle('dialog:selectVideo', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: "Wybierz film",
      filters: [
        { name: "Pliki wideo", extensions: ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'flv'] },
        { name: "Wszystkie pliki", extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return authorizeMedia(result.filePaths[0])
  })

  handle('clips:bulkExport', async (_event, clips: { path: string; name: string }[]) => {
    const window = getMainWindow()
    if (!Array.isArray(clips) || clips.length > 500) throw new Error("Nieprawidłowy wybór do eksportu")
    for (const clip of clips) {
      if (!clip || typeof clip.name !== 'string' || clip.name.length > 500) throw new Error("Nieprawidłowy wybór do eksportu")
      assertMediaPath(clip.path, loadSettings().outputDirectory)
    }
    if (!window || clips.length === 0) return { success: false, count: 0, failedCount: clips.length }

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: "Eksportuj klipy do…"
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, count: 0, failedCount: 0 }

    const destDir = result.filePaths[0]
    const { open, rm } = await import('fs/promises')
    const { pipeline } = await import('stream/promises')
    const { extname, join } = await import('path')
    let count = 0

    for (const clip of clips) {
      try {
        const source = await openAuthorizedMedia(clip.path, loadSettings().outputDirectory)
        try {
          const ext = extname(clip.path) || '.mp4'
          const safeName = Array.from(clip.name).filter((char) => char.charCodeAt(0) >= 32).join('').replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'clip'
          let suffix = 0
          while (true) {
            const dest = join(destDir, `${safeName}${suffix ? ` (${suffix})` : ''}${ext}`)
            let target: Awaited<ReturnType<typeof open>> | undefined
            try {
              target = await open(dest, 'wx', 0o600)
              await pipeline(source.handle.createReadStream({ autoClose: false }), target.createWriteStream({ autoClose: false }))
              await target.close()
              break
            } catch (error) {
              await target?.close()
              if (target) await rm(dest, { force: true })
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || ++suffix > 10000) throw error
            }
          }
          count++
        } finally {
          await source.handle.close()
        }
      } catch { /* Counted below as an unsuccessful copy. */ }
    }

    return { success: count > 0, count, failedCount: clips.length - count, destDir }
  })

  handle('system:isPackaged', () => {
    return app.isPackaged
  })

  handle('system:checkTools', async () => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const { join } = await import('path')
    const settings = loadSettings()
    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath()
    const resolvedPython = resolvePythonPath(enginePath, settings.pythonPath)

    // ffmpeg/ffprobe only accept `-version`; `--version` exits non-zero and
    // made the check report them missing even when installed.
    const check = async (cmd: string, flag = '--version'): Promise<boolean> => {
      try {
        await execFileAsync(cmd, [flag], { timeout: 5000 })
        return true
      } catch {
        return false
      }
    }

    const [pythonValidation, python, ffmpeg, ffmpegCaptions, ffprobe, ytdlp] = await Promise.all([
      validatePython(resolvedPython, enginePath),
      check(resolvedPython),
      check(resolveBinary('ffmpeg'), '-version'),
      supportsCaptionFilter(),
      check(resolveBinary('ffprobe'), '-version'),
      check(resolveBinary('yt-dlp'))
    ])

    const result = {
      python,
      pythonDeps: pythonValidation.ok,
      pythonPath: resolvedPython,
      pythonError: pythonValidation.error,
      ffmpeg,
      ffmpegCaptions,
      ffprobe,
      ytdlp,
      engine: existsSync(join(enginePath, 'clip_engine', 'bridge_contract.py')),
      enginePath,
      bridgeRunner: existsSync(bridgePath),
      bridgePath
    }
    logger.info('system.checkTools', result)
    return result
  })
}
