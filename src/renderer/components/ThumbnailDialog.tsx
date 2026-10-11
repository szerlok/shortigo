import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FolderOpen, ImagePlus, RefreshCw, Star } from 'lucide-react'
import type { ClipArtifact, JobOutput } from '../../shared/job-output'
import { DEFAULT_THUMBNAIL_MODEL, DEFAULT_THUMBNAIL_PROMPT, type ThumbnailAspectRatio, type ThumbnailModel } from '../../shared/thumbnail'
import { clipFilePath } from '../../shared/media-path'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, localFileUrl } from '../lib/utils'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { titleInputClass } from './TitleControls'

const FAVORITE_KEY = 'shortigo.thumbnail.favoriteModel'
function savedFavorite(): string {
  try { return localStorage.getItem(FAVORITE_KEY) || DEFAULT_THUMBNAIL_MODEL } catch { return DEFAULT_THUMBNAIL_MODEL }
}

export function ThumbnailDialog({ clip, directory, onClose, onSaved }: {
  clip: ClipArtifact; directory: string; onClose: () => void; onSaved: (output: JobOutput) => void
}): React.JSX.Element {
  const [current, setCurrent] = useState(clip)
  const [title, setTitle] = useState(clip.summary || `Klip ${clip.clip_index + 1}`)
  const [prompt, setPrompt] = useState(clip.thumbnail_edit?.prompt || DEFAULT_THUMBNAIL_PROMPT)
  const [frameMs, setFrameMs] = useState(clip.thumbnail_edit?.frameMs ?? Math.min(1000, clip.duration_ms / 2))
  const [ratio, setRatio] = useState<ThumbnailAspectRatio>(clip.thumbnail_edit?.aspectRatio ?? '9:16')
  const [models, setModels] = useState<ThumbnailModel[]>([])
  const [favorite, setFavorite] = useState(savedFavorite)
  const [modelId, setModelId] = useState(savedFavorite)
  const [loadingModels, setLoadingModels] = useState(true)
  const [modelError, setModelError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'title' | 'generation' | null>(null)
  const [videoReady, setVideoReady] = useState(false)
  const player = useRef<HTMLVideoElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  const selectedModel = models.find(model => model.id === modelId)
  const buttonPrice = selectedModel?.priceUsd == null ? '' : ` · ${selectedModel.priceKind === 'estimate' ? 'od ok. ' : ''}$${selectedModel.priceUsd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  const titleChanged = title.trim() !== (current.summary || '')
  const source = clipFilePath(current.title_base_url || current.s3_url)
  const cover = current.thumbnail_url ? clipFilePath(current.thumbnail_url) : null
  const maxFrame = Math.max(0, current.duration_ms - 100)

  const loadModels = useCallback(async (): Promise<void> => {
    setLoadingModels(true); setModelError(null)
    try {
      const values = await getApi().clips.thumbnailModels()
      if (!mounted.current) return
      setModels(values)
      setModelId(previous => values.some(model => model.id === previous && model.available) ? previous :
        values.find(model => model.available)?.id ?? previous)
    } catch (e) { if (mounted.current) setModelError(errorMessage(e, 'Nie udało się pobrać modeli i cen')) }
    finally { if (mounted.current) setLoadingModels(false) }
  }, [])

  useEffect(() => {
    mounted.current = true
    void loadModels()
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video')]
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { mounted.current = false; document.removeEventListener('keydown', key); previous?.focus() }
  }, [close, loadModels])

  useEffect(() => {
    if (selectedModel?.available && !selectedModel.aspectRatios.includes(ratio)) {
      setRatio(selectedModel.aspectRatios[0] ?? '9:16')
    }
  }, [selectedModel, ratio])

  const chooseFavorite = (id: string): void => {
    try { localStorage.setItem(FAVORITE_KEY, id); setFavorite(id); setModelId(id) }
    catch { setError('Nie udało się zapamiętać modelu domyślnego') }
  }
  const seek = (time: number): void => {
    const next = Math.max(0, Math.min(maxFrame, Math.round(time)))
    setFrameMs(next)
    if (player.current) { player.current.pause(); player.current.currentTime = next / 1000 }
  }
  const accept = (output: JobOutput): ClipArtifact => {
    const next = output.clips.find(item => item.clip_index === clip.clip_index)
    if (!next) throw new Error('Nie znaleziono klipu po zapisaniu')
    setCurrent(next); onSaved(output)
    return next
  }
  const persistTitle = async (): Promise<ClipArtifact> => {
    if (!title.trim() || title.length > 240) throw new Error('Wpisz tytuł o długości od 1 do 240 znaków')
    if (!titleChanged) return current
    setBusy('title')
    const output = await getApi().clips.renameTitle(directory, clip.clip_index, title.trim())
    if (!output) throw new Error('Nie udało się odczytać zapisanego tytułu')
    const next = accept(output)
    setNotice('Zapisano nowy tytuł klipu.')
    return next
  }
  const saveTitle = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setError(null)
    try { await persistTitle() } catch (e) { setError(errorMessage(e, 'Nie udało się zapisać tytułu')) }
    finally { busyRef.current = false; setBusy(null) }
  }
  const generate = async (): Promise<void> => {
    if (busyRef.current || !selectedModel?.available || !videoReady) return
    busyRef.current = true; setError(null); setNotice(null)
    player.current?.pause()
    const selectedFrame = Math.max(0, Math.min(maxFrame, Math.round((player.current?.currentTime ?? frameMs / 1000) * 1000)))
    setFrameMs(selectedFrame)
    try {
      const updated = await persistTitle()
      setBusy('generation')
      const result = await getApi().clips.generateThumbnail(directory, clip.clip_index, {
        modelId, title: updated.summary || title.trim(), prompt, frameMs: selectedFrame, aspectRatio: ratio
      })
      if (!result.output) throw new Error('Miniaturka powstała, ale nie udało się odczytać biblioteki. Sprawdź folder klipu.')
      accept(result.output)
      setNotice(result.costUsd == null ? 'Miniaturka zapisana w folderze klipu.' :
        `Miniaturka zapisana. Koszt zgłoszony przez OpenRouter: $${result.costUsd.toFixed(4)}.`)
    } catch (e) { setError(errorMessage(e, 'Nie udało się utworzyć miniaturki')) }
    finally { busyRef.current = false; setBusy(null) }
  }

  return <Dialog ref={panel} aria-labelledby="thumbnail-heading" panelClassName="max-w-6xl" onBackdropMouseDown={close}>
    <div className="border-b border-line px-5 py-4"><h2 id="thumbnail-heading" className="text-lg font-semibold">Miniaturka</h2>
      <p className="mt-1 text-sm text-ink-muted">Wybierz kadr, dopasuj tytuł i stwórz jedną miniaturkę na żądanie.</p></div>
    <div className="grid min-h-0 gap-6 overflow-y-auto p-5 lg:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)]">
      <div className="space-y-4">
        <section className="space-y-2"><h3 className="font-medium">1. Wybierz kadr z filmu</h3>
          <div className="flex min-h-52 items-center justify-center overflow-hidden rounded-2xl bg-black">
            <video ref={player} key={source} src={localFileUrl(source)} controls={!busy} playsInline preload="metadata" className="max-h-[42vh] max-w-full"
              onLoadedMetadata={e => { setVideoReady(true); e.currentTarget.currentTime = Math.min(maxFrame, frameMs) / 1000
                if (!clip.thumbnail_edit) setRatio(e.currentTarget.videoWidth > e.currentTarget.videoHeight ? '16:9' : '9:16') }}
              onTimeUpdate={e => setFrameMs(Math.min(maxFrame, Math.round(e.currentTarget.currentTime * 1000)))}
              onError={() => { setVideoReady(false); setError('Nie można odtworzyć filmu do wyboru kadru') }} />
          </div>
          <input aria-label="Kadr do miniaturki" type="range" className="w-full" min="0" max={maxFrame} step="33" value={frameMs} disabled={!!busy || !videoReady} onChange={e => seek(Number(e.target.value))} />
          <div className="flex items-center justify-between gap-2"><Button size="sm" iconOnly aria-label="Poprzednia klatka" disabled={!!busy || !videoReady} icon={<ChevronLeft className="h-4 w-4" />} onClick={() => seek(frameMs - 1000 / 30)} />
            <span className="font-mono text-xs text-ink-muted">Wybrany kadr: {(frameMs / 1000).toFixed(2)} s</span>
            <Button size="sm" iconOnly aria-label="Następna klatka" disabled={!!busy || !videoReady} icon={<ChevronRight className="h-4 w-4" />} onClick={() => seek(frameMs + 1000 / 30)} /></div>
          <p className="text-xs text-ink-subtle">Zatrzymaj film na wybranym ujęciu. Ten kadr zostanie dołączony do polecenia.{current.title_base_url ? ' Podgląd pokazuje wersję bez tytułu na obrazie.' : ''}</p>
        </section>
        {cover && <section className="space-y-2 rounded-2xl border border-line p-3"><h3 className="font-medium">Zapisana miniaturka</h3>
          <img src={localFileUrl(cover)} alt="Wygenerowana miniaturka klipu" className="mx-auto max-h-72 max-w-full rounded-xl object-contain" />
          {current.thumbnail_edit?.title !== current.summary && <p className="text-xs text-amber-300">Miniaturka pochodzi sprzed zmiany tytułu. Możesz wygenerować nową.</p>}
          <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => { void getApi().shell.openPath(cover) }}>Otwórz miniaturkę</Button>
            <Button size="sm" icon={<FolderOpen className="h-4 w-4" />} onClick={() => { void getApi().shell.showItemInFolder(cover) }}>Pokaż plik</Button></div>
        </section>}
      </div>
      <div className="space-y-5">
        <section className="space-y-2"><label className="block font-medium" htmlFor="thumbnail-title">2. Tytuł klipu</label>
          <input id="thumbnail-title" className={titleInputClass} maxLength={240} value={title} disabled={!!busy} onChange={e => setTitle(e.target.value)} />
          <p className="text-xs text-ink-muted">Zmiana zostanie zapisana w bibliotece i użyta w nowych publikacjach.{current.title_base_url ? ' Zaktualizuje także tytuł na filmie.' : ' Ten starszy klip nie ma wersji do zmiany tytułu wypalonego na filmie.'}</p>
          {titleChanged && <Button size="sm" disabled={!!busy || !title.trim()} onClick={() => { void saveTitle() }}>Zapisz tytuł bez generowania</Button>}
          <label className="block pt-2 text-sm" htmlFor="thumbnail-prompt">Polecenie dla modelu</label>
          <textarea id="thumbnail-prompt" className={titleInputClass} rows={5} maxLength={6000} value={prompt} disabled={!!busy} onChange={e => setPrompt(e.target.value)} />
          <div className="flex items-start justify-between gap-3"><p className="text-xs text-ink-subtle">Aktualny tytuł i wybrany kadr dołączamy automatycznie.</p><button type="button" className="shrink-0 text-xs text-accent hover:underline" disabled={!!busy} onClick={() => setPrompt(DEFAULT_THUMBNAIL_PROMPT)}>Przywróć prompt</button></div>
        </section>
        <section className="space-y-3 border-t border-line pt-4"><div className="flex items-center justify-between gap-2"><h3 className="font-medium">3. Model i cena jednej miniaturki</h3>
          <Button size="sm" iconOnly aria-label="Odśwież modele i ceny" disabled={loadingModels || !!busy} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => { void loadModels() }} /></div>
          {loadingModels && <p role="status" className="text-sm text-ink-muted">Pobieram aktualne ceny z OpenRouter…</p>}
          {modelError && <p role="alert" className="text-sm text-danger">{modelError}</p>}
          <div role="radiogroup" aria-label="Model miniaturki" className="grid gap-2">{models.map(model => <div key={model.id} className={cn('flex items-center gap-2 rounded-xl border p-3', modelId === model.id ? 'border-accent bg-accent/10' : 'border-line bg-white/[0.02]')}>
            <button type="button" role="radio" aria-checked={modelId === model.id} disabled={!!busy || !model.available} className="min-w-0 flex-1 text-left disabled:opacity-50" onClick={() => setModelId(model.id)}>
              <span className="flex flex-wrap items-center justify-between gap-1 text-sm"><span className="font-medium">{model.name}</span><span className="text-accent">{model.priceLabel}</span></span>
              <span className="mt-1 block text-xs text-ink-muted">{model.description}</span>
              {model.resolution && <span className="mt-1 block text-2xs text-ink-subtle">{model.resolution}{favorite === model.id ? ' · Domyślny' : ''}</span>}
            </button><button type="button" aria-label={`Ustaw ${model.name} jako domyślny`} aria-pressed={favorite === model.id} title="Ulubiony model — wybierany domyślnie" className="rounded-lg p-2 text-amber-300 hover:bg-white/5 disabled:opacity-40" disabled={!!busy || !model.available} onClick={() => chooseFavorite(model.id)}><Star className="h-4 w-4" fill={favorite === model.id ? 'currentColor' : 'none'} /></button>
          </div>)}</div>
          <p className="text-xs text-ink-subtle">Gwiazdka zapamiętuje model domyślny. Ceny w USD.{selectedModel?.priceKind === 'estimate' ? ' Cena przybliżona; końcowe rozliczenie obejmuje także kadr i tekst polecenia.' : ''}</p>
          <label className="block text-sm">Format miniaturki<select aria-label="Format miniaturki" className={titleInputClass} value={ratio} disabled={!!busy} onChange={e => setRatio(e.target.value as ThumbnailAspectRatio)}>
            {(['9:16', '16:9', '1:1'] as const).map(value => <option key={value} value={value} disabled={!!selectedModel?.available && !selectedModel.aspectRatios.includes(value)}>{value === '9:16' ? '9:16 · pionowy Short' : value === '16:9' ? '16:9 · poziomy film' : '1:1 · kwadrat'}</option>)}
          </select></label>
        </section>
        {busy && <p role="status" className="text-sm text-ink-muted">{busy === 'title' ? 'Zapisuję tytuł i aktualizuję film lokalnie…' : 'Model tworzy miniaturkę. Może to potrwać kilka minut…'}</p>}
        {notice && <p role="status" className="text-sm text-emerald-400">{notice}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </div>
    <DialogFooter><span className="mr-auto hidden text-xs text-ink-subtle sm:block">Generowanie tylko na żądanie · 1 obraz</span><Button disabled={!!busy} onClick={close}>Zamknij</Button>
      <Button variant="primary" loading={!!busy} disabled={!selectedModel?.available || loadingModels || !videoReady || !title.trim() || !prompt.trim() || !!busy} icon={<ImagePlus className="h-4 w-4" />} onClick={() => { void generate() }}>Wygeneruj miniaturkę{selectedModel?.available ? buttonPrice : ''}</Button></DialogFooter>
  </Dialog>
}
