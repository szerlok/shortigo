import { validateTitleOptions } from '../shared/title'
import { isAbsolute } from 'path'
import type { ClipJobConfig } from './pipeline-runner'
import { isWebUrl } from './security'
import { DURATION_IDS } from '../shared/job-contract'

export function validateJobConfig(value: unknown): ClipJobConfig {
  if (!value || typeof value !== 'object') throw new Error("Nieprawidłowe opcje zadania")
  const v = value as ClipJobConfig
  if (typeof v.videoUrl !== 'string' || v.videoUrl.length > 8192 || !(isWebUrl(v.videoUrl) || isAbsolute(v.videoUrl))) throw new Error("Wybierz plik wideo lub adres HTTP(S)")
  if (typeof v.autoClipCount !== 'boolean' || typeof v.includeCaptions !== 'boolean') throw new Error("Nieprawidłowe opcje zadania")
  if (typeof v.layoutVision !== 'boolean') throw new Error("Nieprawidłowa opcja analizy obrazu")
  if (v.maxClips !== null && (!Number.isInteger(v.maxClips) || v.maxClips < 1 || v.maxClips > 100)) throw new Error("Liczba klipów musi wynosić od 1 do 100")
  for (const [key, allowed] of Object.entries({ aspectRatio: ['9:16', '16:9'], layoutStyle: ['auto', 'fill', 'fit'], pacing: ['tight', 'natural'] })) {
    if (!allowed.includes(v[key as keyof ClipJobConfig] as string)) throw new Error(`Nieprawidłowa wartość: ${key}`)
  }
  if (typeof v.captionPreset !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.captionPreset)) throw new Error("Nieprawidłowy styl napisów")
  if (v.durationRanges !== null && (!Array.isArray(v.durationRanges) || v.durationRanges.length > DURATION_IDS.length || v.durationRanges.some((item) => !DURATION_IDS.includes(item)))) throw new Error("Nieprawidłowa długość klipu")
  for (const time of [v.startTimeSeconds, v.endTimeSeconds]) {
    if (time !== null && (typeof time !== 'number' || !Number.isFinite(time) || time < 0)) throw new Error("Nieprawidłowy czas przycięcia")
  }
  if (v.endTimeSeconds !== null && v.endTimeSeconds <= (v.startTimeSeconds ?? 0)) throw new Error("Koniec przycięcia musi być późniejszy niż początek")
  if (v.bannerPlatform !== null && (typeof v.bannerPlatform !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(v.bannerPlatform))) throw new Error("Nieprawidłowa platforma banera")
  if (v.bannerChannelUrl !== null && (!isWebUrl(v.bannerChannelUrl) || v.bannerChannelUrl.length > 8192)) throw new Error("Nieprawidłowy adres banera")
  if (v.removeHesitations !== undefined && typeof v.removeHesitations !== 'boolean') throw new Error('Nieprawidłowa opcja usuwania zawahań')
  if (v.backgroundMusic !== undefined && typeof v.backgroundMusic !== 'boolean') throw new Error('Nieprawidłowa opcja muzyki')
  if (v.strongerHook !== undefined && typeof v.strongerHook !== 'boolean') throw new Error('Nieprawidłowa opcja doboru początku')
  if (v.retainSource !== undefined && typeof v.retainSource !== 'boolean') throw new Error('Nieprawidłowa opcja zachowania źródła')
  validateTitleOptions(v.titleOptions)
  return v
}
