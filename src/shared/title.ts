export interface TitleOptions {
  font?: 'montserrat' | 'poppins' | 'anton' | 'serif'
  uppercase?: boolean
  radius?: number
  enabled: boolean
  mode: 'all' | 'intro' | 'range'
  start: number
  end: number
  size: number
  color: string
  background: string
  opacity: number
  position: 'auto' | 'manual'
  y: number
  fade: boolean
  style: 'card' | 'plain' | 'outline'
}
export const DEFAULT_TITLE: TitleOptions = {
  font: 'poppins', uppercase: false, radius: 16,
  enabled: true, mode: 'intro', start: 0, end: 3, size: 44,
  color: '#151515', background: '#ffffff', opacity: 0.96,
  position: 'auto', y: 6, fade: true, style: 'card'
}
export interface TitleEdit { text: string; name: string; options: TitleOptions }
export interface TitlePreview { image: string; width: number; height: number; imageWidth: number; imageHeight: number; y: number; duration: number }
export function validateTitleOptions(value: unknown): TitleOptions {
  if (value === undefined) return { ...DEFAULT_TITLE }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Nieprawidłowe ustawienia tytułu')
  const v = { ...value, font: (value as TitleOptions).font ?? 'montserrat', uppercase: (value as TitleOptions).uppercase ?? false, radius: (value as TitleOptions).radius ?? 16 } as TitleOptions
  if (typeof v.enabled !== 'boolean' || typeof v.fade !== 'boolean' || typeof v.uppercase !== 'boolean') throw new Error('Nieprawidłowe ustawienia tytułu')
  for (const [key, allowed] of Object.entries({ font: ['montserrat', 'poppins', 'anton', 'serif'], mode: ['all', 'intro', 'range'], position: ['auto', 'manual'], style: ['card', 'plain', 'outline'] })) {
    if (!allowed.includes(v[key as keyof TitleOptions] as string)) throw new Error('Nieprawidłowy styl tytułu')
  }
  for (const [key, low, high] of [['start', 0, 21600], ['end', 0.1, 21600], ['size', 20, 100], ['opacity', 0, 1], ['y', 0, 90], ['radius', 0, 100]] as const) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < low || v[key] > high) throw new Error(`Nieprawidłowa wartość: ${key}`)
  }
  if (v.mode === 'range' && v.end <= v.start) throw new Error('Koniec musi być później niż początek')
  if (![v.color, v.background].every(c => typeof c === 'string' && /^#[a-f0-9]{6}$/i.test(c))) throw new Error('Nieprawidłowy kolor')
  return Object.fromEntries(Object.keys(DEFAULT_TITLE).map(key => [key, v[key as keyof TitleOptions]])) as unknown as TitleOptions
}
