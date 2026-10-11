import { DEFAULT_TITLE, type TitleOptions } from './title'

export const TITLE_PRESETS = [
  { id: 'paper', name: 'Papier', description: 'Czarny tekst na jasnej karcie', visual: { style: 'card', font: 'poppins', size: 44, color: '#151515', background: '#ffffff', opacity: .96, radius: 16, uppercase: false } },
  { id: 'night', name: 'Noc', description: 'Biała typografia na ciemnym tle', visual: { style: 'card', font: 'montserrat', size: 44, color: '#ffffff', background: '#141821', opacity: .90, radius: 12, uppercase: false } },
  { id: 'alert', name: 'Alarm', description: 'Wyrazisty czerwony nagłówek', visual: { style: 'card', font: 'anton', size: 54, color: '#ffffff', background: '#db243b', opacity: 1, radius: 0, uppercase: true } },
  { id: 'marker', name: 'Marker', description: 'Czarny tekst na żółtym pasku', visual: { style: 'card', font: 'montserrat', size: 46, color: '#121212', background: '#ffe234', opacity: 1, radius: 0, uppercase: true } },
  { id: 'mint', name: 'Mięta', description: 'Miętowa, zaokrąglona etykieta', visual: { style: 'card', font: 'poppins', size: 42, color: '#083d35', background: '#a8f0d1', opacity: .96, radius: 60, uppercase: false } },
  { id: 'violet', name: 'Fiolet', description: 'Biały tekst na fioletowej karcie', visual: { style: 'card', font: 'poppins', size: 44, color: '#ffffff', background: '#7040cf', opacity: .96, radius: 24, uppercase: false } },
  { id: 'minimal', name: 'Minimal', description: 'Prosty biały tekst bez tła', visual: { style: 'plain', font: 'poppins', size: 40, color: '#ffffff', background: '#000000', opacity: 0, radius: 0, uppercase: false } },
  { id: 'cinema', name: 'Kino', description: 'Wysokie litery z czarnym obrysem', visual: { style: 'outline', font: 'anton', size: 58, color: '#ffffff', background: '#111111', opacity: 1, radius: 0, uppercase: true } },
  { id: 'comic', name: 'Komiks', description: 'Żółte litery z mocnym obrysem', visual: { style: 'outline', font: 'montserrat', size: 52, color: '#ffe234', background: '#17121d', opacity: 1, radius: 0, uppercase: true } },
  { id: 'magazine', name: 'Magazyn', description: 'Elegancka kursywa na kremowym tle', visual: { style: 'card', font: 'serif', size: 58, color: '#392c23', background: '#f4e8d5', opacity: .96, radius: 4, uppercase: false } }
] as const

export function applyTitlePreset(id: string, current: TitleOptions = DEFAULT_TITLE): TitleOptions {
  const preset = TITLE_PRESETS.find(p => p.id === id) ?? TITLE_PRESETS[0]
  return { ...current, ...preset.visual }
}
export function selectedTitlePreset(value: TitleOptions): string | null {
  return TITLE_PRESETS.find(p => Object.entries(p.visual).every(([key, expected]) =>
    (value[key as keyof TitleOptions] ?? DEFAULT_TITLE[key as keyof TitleOptions]) === expected))?.id ?? null
}
