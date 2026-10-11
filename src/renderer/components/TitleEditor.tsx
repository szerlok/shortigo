import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_TITLE, validateTitleOptions, type TitleEdit, type TitlePreview } from '../../shared/title'
import type { ClipArtifact, JobOutput } from '../../shared/job-output'
import { getApi } from '../lib/ipc'
import { errorMessage, localFileUrl } from '../lib/utils'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { TitleControls, titleInputClass } from './TitleControls'

export function TitleEditor({ clip, directory, onClose, onSaved }: { clip: ClipArtifact; directory: string; onClose: () => void; onSaved: (output: JobOutput) => void }): React.JSX.Element {
  const [edit, setEdit] = useState<TitleEdit>({ name: clip.summary || 'Klip', text: clip.title_edit?.text ?? clip.summary ?? '', options: clip.title_edit?.options ?? { ...DEFAULT_TITLE } })
  const [preview, setPreview] = useState<(TitlePreview & { base: string }) | null>(null)
  const [previewing, setPreviewing] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [time, setTime] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const busyRef = useRef(false)
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab') return
      const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video') ?? [])]
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [close])
  useEffect(() => {
    let active = true
    setPreviewing(true)
    setError(null)
    const timer = setTimeout(() => {
      try { validateTitleOptions(edit.options) } catch (e) { setError(errorMessage(e, 'Sprawdź ustawienia')); setPreviewing(false); return }
      getApi().clips.previewTitle(directory, clip.clip_index, edit).then(value => {
        if (active) { setPreview(value); setPreviewing(false) }
      }).catch(e => { if (active) { setError(errorMessage(e, 'Nie udało się przygotować podglądu')); setPreviewing(false) } })
    }, 300)
    return () => { active = false; clearTimeout(timer) }
  }, [edit, directory, clip.clip_index])
  const duration = preview?.duration ?? clip.duration_ms / 1000
  const start = edit.options.mode === 'range' ? edit.options.start : 0
  const end = edit.options.mode === 'all' ? duration : Math.min(duration, edit.options.end)
  const fade = edit.options.fade ? Math.min(.25, Math.max(0, end - start) / 2) : 0
  const opacity = !edit.options.enabled || !edit.text.trim() || time < start || time >= end ? 0 : fade ? Math.max(0, Math.min(1, (time - start) / fade, (end - time) / fade)) : 1
  const save = async (): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const output = await getApi().clips.exportTitle(directory, clip.clip_index, edit)
      if (!output) throw new Error('Nie udało się odczytać zapisanego klipu')
      onSaved(output)
    } catch (e) { setError(errorMessage(e, 'Eksport nie powiódł się')) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <Dialog ref={dialogRef} aria-labelledby="title-editor-heading" panelClassName="max-w-5xl" onBackdropMouseDown={close}>
    <div className="border-b border-line px-5 py-4"><h2 id="title-editor-heading" className="text-lg font-semibold">Edytuj tytuł</h2><p className="mt-1 text-xs text-ink-muted">Podgląd i eksport korzystają z wersji bez tytułu. Bez ponownej analizy AI.</p></div>
    <div className="grid min-h-0 gap-5 overflow-y-auto p-5 md:grid-cols-2">
      <div className="space-y-3">
        {preview && <div className="relative mx-auto overflow-hidden rounded-xl bg-black" style={{ aspectRatio: `${preview.width}/${preview.height}`, maxHeight: '55vh', maxWidth: preview.width < preview.height ? '290px' : '100%' }}>
          <video ref={videoRef} src={localFileUrl(preview.base)} controls playsInline className="h-full w-full" onTimeUpdate={e => setTime(e.currentTarget.currentTime)} onSeeked={e => setTime(e.currentTarget.currentTime)} onError={() => setError('Nie można odtworzyć wersji bazowej')} />
          <img alt="" src={preview.image} className="pointer-events-none absolute" style={{ width: `${preview.imageWidth / preview.width * 100}%`, left: `${(1 - preview.imageWidth / preview.width) * 50}%`, top: `${preview.y / preview.height * 100}%`, opacity }} />
        </div>}
        {previewing && <p role="status" className="text-xs text-ink-muted">Aktualizuję podgląd…</p>}
        <Button size="sm" onClick={() => { const t = Math.min(duration - .05, start + .5); if (videoRef.current) { videoRef.current.currentTime = Math.max(0, t); setTime(Math.max(0, t)) } }}>Pokaż moment z tytułem</Button>
        <label className="block text-xs text-ink-muted">Nazwa klipu w bibliotece<input aria-label="Nazwa klipu w bibliotece" disabled={busy} className={titleInputClass} maxLength={240} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
        <label className="block text-xs text-ink-muted">Tekst na filmie<textarea aria-label="Tekst na filmie" disabled={busy} className={titleInputClass} rows={3} maxLength={240} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} /></label>
        <p className="text-xs text-ink-muted">Eksport zapisze nową wersję i ustawi ją jako bieżący klip w bibliotece. Poprzedni plik pozostanie w folderze.</p>
      </div>
      <TitleControls disabled={busy} value={edit.options} onChange={options => setEdit({ ...edit, options })} />
    </div>
    {error && <p role="alert" className="px-5 pb-3 text-sm text-danger">{error}</p>}
    {busy && <p role="status" className="px-5 pb-3 text-sm text-ink-muted">Eksportuję film lokalnie. To może potrwać kilka minut…</p>}
    <DialogFooter><Button disabled={busy} onClick={close}>Anuluj</Button><Button variant="primary" loading={busy} disabled={previewing || !preview || !!error} onClick={() => { void save() }}>Eksportuj klip</Button></DialogFooter>
  </Dialog>
}
