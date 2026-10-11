export type ThumbnailAspectRatio = '9:16' | '16:9' | '1:1'
export type ThumbnailRequest = {
  modelId: string
  title: string
  prompt: string
  frameMs: number
  aspectRatio: ThumbnailAspectRatio
}
export type ThumbnailEdit = ThumbnailRequest & { createdAt: string; costUsd: number | null }
export type ThumbnailModel = {
  id: string
  name: string
  description: string
  available: boolean
  priceUsd: number | null
  priceLabel: string
  priceKind: 'fixed' | 'estimate' | 'unknown'
  resolution: string | null
  aspectRatios: ThumbnailAspectRatio[]
  pricingUpdatedAt: string | null
}

export const DEFAULT_THUMBNAIL_MODEL = 'bytedance-seed/seedream-5-0-lite'
export const DEFAULT_THUMBNAIL_PROMPT = 'Na podstawie wybranego kadru i tytułu klipu stwórz atrakcyjną, czytelną miniaturkę. Zachowaj rozpoznawalny wygląd osoby i główny temat kadru. Popraw kompozycję, światło i kontrast. Umieść duży, krótki napis po polsku, wynikający z tytułu, z poprawnymi polskimi znakami. Napis musi być czytelny na telefonie i odsunięty od krawędzi. Nie dodawaj logotypów, znaków wodnych ani informacji, których nie ma w tytule.'

export const THUMBNAIL_MODEL_CHOICES = [
  { id: DEFAULT_THUMBNAIL_MODEL, name: 'Seedream 5.0 Lite', description: 'Dobry punkt startowy: kompozycja, edycja kadru i stała cena.', resolution: '2K' },
  { id: 'qwen/qwen-image-3', name: 'Qwen Image 3', description: 'Precyzyjne napisy i szczegóły; cena obejmuje jeden kadr.', resolution: '1K' },
  { id: 'google/gemini-3.1-flash-lite-image', name: 'Nano Banana 2 Lite', description: 'Szybkie, niedrogie warianty na podstawie kadru.', resolution: '1K' },
  { id: 'google/gemini-3.1-flash-image', name: 'Nano Banana 2', description: 'Dokładna edycja kadru i bardziej złożonych poleceń.', resolution: '1K' }
] as const

export function validateThumbnailRequest(value: unknown): ThumbnailRequest {
  const v = value as ThumbnailRequest | null
  if (!v || !THUMBNAIL_MODEL_CHOICES.some(m => m.id === v.modelId) ||
      typeof v.title !== 'string' || !v.title.trim() || v.title.length > 240 || v.title.includes('\0') ||
      typeof v.prompt !== 'string' || !v.prompt.trim() || v.prompt.length > 6000 || v.prompt.includes('\0') ||
      !Number.isSafeInteger(v.frameMs) || v.frameMs < 0 || v.frameMs > 24 * 60 * 60 * 1000 ||
      !['9:16', '16:9', '1:1'].includes(v.aspectRatio)) throw new Error('Wybierz model, kadr, format i wpisz tytuł oraz polecenie miniaturki')
  return { modelId: v.modelId, title: v.title.trim(), prompt: v.prompt.trim(), frameMs: v.frameMs, aspectRatio: v.aspectRatio }
}

export function parseThumbnailEdit(value: unknown): ThumbnailEdit | null {
  const v = value as ThumbnailEdit | null
  if (!v || typeof v.createdAt !== 'string' || v.createdAt.length > 40 || !Number.isFinite(Date.parse(v.createdAt)) ||
      !(v.costUsd === null || typeof v.costUsd === 'number' && Number.isFinite(v.costUsd) && v.costUsd >= 0)) return null
  try { return { ...validateThumbnailRequest(v), createdAt: v.createdAt, costUsd: v.costUsd } } catch { return null }
}
