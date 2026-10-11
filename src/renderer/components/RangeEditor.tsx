import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipArtifact, JobOutput } from '../../shared/job-output'
import { validateClipRange, type RangeContext } from '../../shared/clip-range'
import { getApi } from '../lib/ipc'
import { errorMessage, formatTimecode, localFileUrl } from '../lib/utils'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { titleInputClass } from './TitleControls'

export function RangeEditor({ clip, directory, onClose, onSaved }: {
  clip: ClipArtifact; directory: string; onClose: () => void; onSaved: (output: JobOutput) => void
}): React.JSX.Element {
  const [context, setContext] = useState<RangeContext | null>(null)
  const [start, setStart] = useState(String(clip.start_time_ms / 1000))
  const [end, setEnd] = useState(String(clip.end_time_ms / 1000))
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(true)
  const [previewSource, setPreviewSource] = useState<string | null>(null)
  const [preparingPreview, setPreparingPreview] = useState(false)
  const [previewMessage, setPreviewMessage] = useState<string | null>(null)
  const previewRequest = useRef(0)
  const [busy, setBusy] = useState(false)
  const [position, setPosition] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const busyRef = useRef(false)
  const playingRange = useRef(false)
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab') return
      const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), video') ?? [])]
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [close])
  const preparePreview = useCallback(async (rebuild = false): Promise<void> => {
    const request = ++previewRequest.current
    setPreviewSource(null)
    setPreviewError(true); setPreparingPreview(true); setPreviewMessage(null)
    playingRange.current = false
    try {
      const path = await getApi().clips.rangePreview(directory, clip.clip_index, rebuild)
      if (previewRequest.current === request) setPreviewSource(path)
    } catch (e) {
      if (previewRequest.current === request) setPreviewMessage(errorMessage(e, 'Nie udało się przygotować podglądu. Spróbuj ponownie.'))
    } finally {
      if (previewRequest.current === request) setPreparingPreview(false)
    }
  }, [directory, clip.clip_index])
  useEffect(() => {
    let active = true
    setContext(null)
    setPreviewSource(null)
    setPreviewError(true)
    getApi().clips.rangeContext(directory, clip.clip_index).then(value => {
      if (active) {
        setContext(value)
        setStart(String(value.range.startMs / 1000))
        setEnd(String(Math.min(value.range.endMs, value.durationMs) / 1000))
        // Always use the compatible cached proxy; unsupported originals can stall
        // without emitting a media error, so an onError fallback is insufficient.
        void preparePreview()
      }
    }).catch(e => { if (active) setError(errorMessage(e, 'Nie udało się otworzyć źródła do poprawek')) })
    return () => { active = false; previewRequest.current++ }
  }, [directory, clip.clip_index, preparePreview])
  const startMs = start.trim() ? Math.round(Number(start) * 1000) : NaN
  const endMs = end.trim() ? Math.round(Number(end) * 1000) : NaN
  let invalid = ''
  try { validateClipRange({ startMs, endMs }, context?.durationMs ?? 0) } catch { invalid = 'Wybierz co najmniej sekundę filmu. Początek i koniec muszą mieścić się w źródle.' }
  const change = (side: 'start' | 'end', seconds: string): void => {
    playingRange.current = false
    videoRef.current?.pause()
    if (side === 'start') setStart(seconds); else setEnd(seconds)
    setError(null)
  }
  const setBoundary = (side: 'start' | 'end', ms: number): void => {
    if (!context || !Number.isFinite(ms)) return
    change(side, String(Math.max(0, Math.min(context.durationMs, Math.round(ms))) / 1000))
  }
  const earlier = context?.segments.filter(s => s.startMs < startMs - 20).at(-1)
  const later = context?.segments.find(s => s.endMs > endMs + 20)
  const spoken = context?.segments.filter(s => s.endMs > startMs && s.startMs < endMs).slice(0, 30) ?? []
  const save = async (): Promise<void> => {
    if (!context || invalid || busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    videoRef.current?.pause()
    try {
      const output = await getApi().clips.exportRange(directory, clip.clip_index, { startMs, endMs })
      if (!output) throw new Error('Nie udało się odczytać zapisanego klipu')
      onSaved(output)
    } catch (e) { setError(errorMessage(e, 'Nie udało się zapisać fragmentu')) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <Dialog ref={dialogRef} aria-labelledby="range-editor-heading" panelClassName="max-w-4xl" onBackdropMouseDown={close}>
    <div className="border-b border-line px-5 py-4">
      <h2 id="range-editor-heading" className="text-lg font-semibold">Popraw fragment</h2>
      <p className="mt-1 text-xs text-ink-muted">Zmień początek i koniec w oryginalnym filmie. Eksport automatycznie dopasuje napisy i tytuł.</p>
    </div>
    <div className="min-h-0 space-y-4 overflow-y-auto p-5">
      {!context && !error && <p role="status">Otwieram zachowane źródło…</p>}
      {context && <>
        {previewSource && <video key={previewRequest.current} ref={videoRef} src={localFileUrl(previewSource)} controls playsInline preload="auto"
          className="mx-auto max-h-[35vh] w-full rounded-xl bg-black"
          onLoadedMetadata={e => { e.currentTarget.currentTime = (Number.isFinite(startMs) ? startMs : context.range.startMs) / 1000 }}
          onCanPlay={() => { setPreviewError(false); setPreviewMessage(null) }}
          onTimeUpdate={e => {
            setPosition(Math.round(e.currentTarget.currentTime * 1000))
            if (playingRange.current && e.currentTarget.currentTime * 1000 >= endMs) { e.currentTarget.pause(); playingRange.current = false }
          }}
          onError={() => {
            setPreviewError(true)
            setPreviewMessage('Nie udało się odtworzyć podglądu. Spróbuj przygotować go ponownie.')
          }} />}
        <p className="text-xs text-ink-muted">Podgląd źródła: {formatTimecode(position)} / {formatTimecode(context.durationMs)}. Napisy, tytuł i cięcia będą widoczne po eksporcie. Kadrowanie zostanie obliczone lokalnie i może się nieco zmienić.</p>
        {preparingPreview && <p role="status" className="text-sm text-ink-muted">Przygotowuję zgodny podgląd z dźwiękiem… Przy długim filmie może to potrwać kilka minut. Gotowa kopia będzie używana przy kolejnych poprawkach. Bez opłat AI.</p>}
        {previewMessage && <div role="alert" className="space-y-2"><p className="text-sm text-warning">{previewMessage}</p><Button size="sm" disabled={preparingPreview} onClick={() => { void preparePreview(true) }}>Ponów przygotowanie podglądu</Button></div>}
        {previewSource && !previewError && !preparingPreview && <p className="text-xs text-ink-muted">Podgląd w niższej rozdzielczości. Eksport korzysta z oryginalnej jakości filmu.</p>}
        <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
          {(['start', 'end'] as const).map(side => {
            const value = side === 'start' ? start : end
            const ms = side === 'start' ? startMs : endMs
            const label = side === 'start' ? 'Początek' : 'Koniec'
            return <div key={side} className="space-y-2 rounded-xl border border-line p-3">
              <label className="block text-sm">{label} (sekundy)
                <input type="number" min="0" max={context.durationMs / 1000} step="0.1" value={value} className={titleInputClass}
                  onChange={e => change(side, e.target.value)} />
              </label>
              <input aria-label={`${label} na osi czasu`} type="range" min="0" max={context.durationMs} step="10"
                className="w-full" value={Number.isFinite(ms) ? ms : 0} onChange={e => setBoundary(side, Number(e.target.value))} />
              <div className="flex flex-wrap gap-1">
                <Button size="sm" onClick={() => setBoundary(side, ms - 1000)}>−1 s</Button>
                <Button size="sm" onClick={() => setBoundary(side, ms + 1000)}>+1 s</Button>
                <Button size="sm" disabled={previewError} onClick={() => setBoundary(side, (videoRef.current?.currentTime ?? 0) * 1000)}>Z odtwarzacza</Button>
              </div>
            </div>
          })}
          <Button size="sm" disabled={!earlier} onClick={() => earlier && setBoundary('start', earlier.startMs)}>Dodaj wcześniejszą wypowiedź</Button>
          <Button size="sm" disabled={!later} onClick={() => later && setBoundary('end', later.endMs)}>Dodaj następną wypowiedź</Button>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || !!invalid || previewError} onClick={() => {
            const video = videoRef.current
            if (video) {
              video.currentTime = startMs / 1000; playingRange.current = true
              void video.play().catch(() => { playingRange.current = false; setError('Nie udało się rozpocząć odtwarzania. Spróbuj przyciskiem w odtwarzaczu.') })
            }
          }}>Odtwórz wybrany zakres</Button>
          <Button variant="ghost" disabled={busy} onClick={() => {
            setBoundary('start', context.range.startMs); setBoundary('end', context.range.endMs)
          }}>Cofnij zmiany</Button>
          {!invalid && <span className="text-xs text-ink-muted">Zakres: {((endMs - startMs) / 1000).toFixed(1)} s przed usuwaniem pauz i zawahań.</span>}
        </div>
        {invalid && <p className="text-sm text-warning">{invalid}</p>}
        {spoken.length > 0 && <details className="rounded-xl border border-line p-3 text-xs text-ink-muted">
          <summary className="cursor-pointer">Transkrypcja w tym zakresie</summary>
          <div className="mt-2 max-h-32 space-y-2 overflow-y-auto">{spoken.map((s, i) => <p key={i}>{formatTimecode(s.startMs)} · {s.text}</p>)}</div>
        </details>}
        <p className="text-xs text-ink-muted">Zapisze się nowa wersja klipu. Poprzedni plik pozostanie w folderze. Bez ponownego pobierania, transkrypcji i opłat AI.</p>
      </>}
    </div>
    {error && <p role="alert" className="px-5 pb-3 text-sm text-danger">{error}</p>}
    {busy && <p role="status" className="px-5 pb-3 text-sm text-ink-muted">Przeliczam napisy i renderuję nowy fragment lokalnie. To może potrwać kilka minut…</p>}
    <DialogFooter><Button disabled={busy} onClick={close}>Anuluj</Button><Button variant="primary" loading={busy} disabled={!context || !!invalid} onClick={() => { void save() }}>Zapisz nową wersję</Button></DialogFooter>
  </Dialog>
}
