export interface ClipRange { startMs: number; endMs: number }
export interface RangeContext {
  source: string
  durationMs: number
  range: ClipRange
  segments: { startMs: number; endMs: number; text: string }[]
}

export function validateClipRange(value: unknown, durationMs: number): ClipRange {
  const range = value as ClipRange | null
  if (!range || !Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs) ||
      range.startMs < 0 || range.endMs > durationMs || range.endMs - range.startMs < 1000) {
    throw new Error('Wybierz co najmniej sekundę filmu, w granicach źródła.')
  }
  return { startMs: range.startMs, endMs: range.endMs }
}
