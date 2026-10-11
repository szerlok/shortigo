export type MusicEdit = { enabled: boolean; trackId: string | null; level: 'subtle' | 'standard' | 'strong' }
export type MusicTrack = { id: string; name: string }
export const DEFAULT_MUSIC: MusicEdit = { enabled: false, trackId: null, level: 'subtle' }
export function validateMusic(value: unknown): MusicEdit {
  const v = value as MusicEdit | null
  if (!v || typeof v.enabled !== 'boolean' || !['subtle', 'standard', 'strong'].includes(v.level) ||
      !(v.trackId === null || typeof v.trackId === 'string' && /^[a-f0-9]{16}$/.test(v.trackId)) ||
      v.enabled && !v.trackId) throw new Error('Wybierz utwór i głośność muzyki')
  return { enabled: v.enabled, trackId: v.trackId, level: v.level }
}
