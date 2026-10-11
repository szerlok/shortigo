export const DURATION_OPTIONS = [
  { id: 'xshort', label: "Bardzo krótki", range: '10–30s' },
  { id: 'short', label: "Krótki", range: '30–60s' },
  { id: 'medium', label: "Średni", range: '1–2m' },
  { id: 'long', label: "Długi", range: '2–5m' },
  { id: 'xlong', label: "Bardzo długi", range: '5–10m' },
  { id: 'extended', label: "Rozszerzony", range: '10–15m' },
  { id: 'feature', label: "Pełny", range: '15–30m' }
] as const

/** Increment when the desktop bridge and bundled BridgeClip engine job contract change. */
export const BRIDGE_CONTRACT_VERSION = 1

export type DurationId = (typeof DURATION_OPTIONS)[number]['id']
export const DURATION_IDS: readonly string[] = DURATION_OPTIONS.map((option) => option.id)
