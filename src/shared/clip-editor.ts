import { validateMusic, type MusicEdit } from './music'
import { validateTitleOptions, type TitleOptions } from './title'

export interface EditorSegment { id: string; file: string; startMs: number; endMs: number }
export interface EditorOverlay { id: string; file: string; startMs: number; endMs: number; x: number; y: number; width: number }
export interface EditorProject { version: 1; name?: string; segments: EditorSegment[]; overlays: EditorOverlay[]; music: MusicEdit; title?: { text: string; options: TitleOptions } }

const mediaName = /^clip_\d{2,}(?:\.(?:base|dry)|\.(?:title|range|music|edit)-[0-9a-f-]{36}(?:\.(?:base|dry))?|\.asset-[0-9a-f-]{36})?\.(?:mp4|m4v|mov|mkv|webm|avi|png|jpg|jpeg|webp)$/i
const idPattern = /^[0-9a-f-]{36}$/i
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function validateEditorProject(value: unknown): EditorProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Nieprawidłowy projekt edytora')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || !Array.isArray(raw.segments) || raw.segments.length < 1 || raw.segments.length > 30 ||
      !Array.isArray(raw.overlays) || raw.overlays.length > 20) throw new Error('Projekt ma nieprawidłową liczbę elementów')
  const segments = raw.segments.map((v): EditorSegment => {
    const s = v as EditorSegment
    if (!s || !idPattern.test(s.id) || typeof s.file !== 'string' || !mediaName.test(s.file) ||
        !/\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(s.file) || !finite(s.startMs) || !finite(s.endMs) ||
        s.startMs < 0 || s.endMs - s.startMs < 100 || s.endMs > 12 * 60 * 60 * 1000) throw new Error('Nieprawidłowy fragment filmu')
    return { id: s.id, file: s.file, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) }
  })
  const duration = segments.reduce((sum, s) => sum + s.endMs - s.startMs, 0)
  if (duration > 20 * 60 * 1000) throw new Error('Projekt może mieć maksymalnie 20 minut')
  const overlays = raw.overlays.map((v): EditorOverlay => {
    const o = v as EditorOverlay
    if (!o || !idPattern.test(o.id) || typeof o.file !== 'string' || !mediaName.test(o.file) ||
        !/\.(png|jpg|jpeg|webp)$/i.test(o.file) || !finite(o.startMs) || !finite(o.endMs) ||
        !finite(o.x) || !finite(o.y) || !finite(o.width) || o.startMs < 0 || o.endMs <= o.startMs ||
        o.endMs > duration || o.x < 0 || o.y < 0 || o.width < 0.05 || o.width > 1 || o.x + o.width > 1 || o.y > 1) {
      throw new Error('Nieprawidłowa grafika na osi czasu')
    }
    return { id: o.id, file: o.file, startMs: Math.round(o.startMs), endMs: Math.round(o.endMs), x: o.x, y: o.y, width: o.width }
  })
  if (!raw.music) throw new Error('Brak ustawień muzyki')
  const music = validateMusic(raw.music)
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 240 || raw.name.includes('\0'))) throw new Error('Nazwa klipu jest nieprawidłowa')
  let title: EditorProject['title']
  if (raw.title !== undefined) {
    if (!raw.title || typeof raw.title !== 'object' || Array.isArray(raw.title)) throw new Error('Nieprawidłowy tytuł')
    const value = raw.title as Record<string, unknown>
    if (typeof value.text !== 'string' || value.text.length > 240 || value.text.includes('\0')) throw new Error('Nieprawidłowy tekst tytułu')
    const options = validateTitleOptions(value.options)
    if (options.enabled && !value.text.trim()) throw new Error('Wpisz tekst tytułu lub wyłącz jego wyświetlanie')
    title = { text: value.text.trim(), options }
  }
  return { version: 1, ...(typeof raw.name === 'string' ? { name: raw.name.trim() } : {}), segments, overlays, music, ...(title ? { title } : {}) }
}

export function editorDuration(project: EditorProject): number {
  return project.segments.reduce((sum, s) => sum + s.endMs - s.startMs, 0)
}

export function editorRenderKey(project: EditorProject): string {
  return JSON.stringify([project.segments, project.overlays, project.music, project.title])
}
