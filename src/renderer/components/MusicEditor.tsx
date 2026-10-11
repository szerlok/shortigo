import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_MUSIC, type MusicEdit, type MusicTrack } from '../../shared/music'
import type { ClipArtifact, JobOutput } from '../../shared/job-output'
import { getApi } from '../lib/ipc'
import { errorMessage, localFileUrl } from '../lib/utils'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { titleInputClass } from './TitleControls'

export function MusicEditor({ clip, directory, onClose, onSaved }: {
  clip: ClipArtifact; directory: string; onClose: () => void; onSaved: (output: JobOutput) => void
}): React.JSX.Element {
  const [edit, setEdit] = useState<MusicEdit>(clip.music_edit ?? { ...DEFAULT_MUSIC })
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ path: string; settings: string } | null>(null)
  const previewPath = useRef<string | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const panel = useRef<HTMLDivElement>(null)
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  useEffect(() => {
    mounted.current = true
    let active = true
    getApi().clips.musicTracks().then(value => { if (active) setTracks(value) })
      .catch(e => { if (active) setError(errorMessage(e, 'Nie udało się wczytać utworów')) })
      .finally(() => { if (active) setLoading(false) })
    return () => {
      active = false; mounted.current = false
      if (previewPath.current) void getApi().clips.clearMusicPreview(previewPath.current).catch(() => {})
    }
  }, [])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab') return
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), audio') ?? [])]
      const first = elements[0], last = elements[elements.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [close])
  const run = async (action: 'preview' | 'save'): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(action); setError(null)
    try {
      if (action === 'preview') {
        const path = await getApi().clips.previewMusic(directory, clip.clip_index, edit)
        if (!mounted.current) { void getApi().clips.clearMusicPreview(path).catch(() => {}); return }
        if (previewPath.current) void getApi().clips.clearMusicPreview(previewPath.current).catch(() => {})
        previewPath.current = path
        setPreview({ path, settings: JSON.stringify(edit) })
      } else {
        const output = await getApi().clips.exportMusic(directory, clip.clip_index, edit)
        if (!output) throw new Error('Nie udało się odczytać zapisanego klipu')
        if (mounted.current) onSaved(output)
      }
    } catch (e) { if (mounted.current) setError(errorMessage(e, 'Nie udało się przygotować muzyki')) }
    finally { busyRef.current = false; if (mounted.current) setBusy(null) }
  }
  const currentPreview = preview?.settings === JSON.stringify(edit) ? preview : null
  const valid = !edit.enabled || tracks.some(t => t.id === edit.trackId)
  return <Dialog ref={panel} aria-labelledby="music-heading" panelClassName="max-w-xl" onBackdropMouseDown={close}>
    <div className="border-b border-line px-5 py-4"><h2 id="music-heading" className="text-lg font-semibold">Muzyka w tle</h2><p className="mt-1 text-sm text-ink-muted">{clip.summary || 'Klip'}</p></div>
    <div className="space-y-4 overflow-y-auto p-5">
      <label className="flex items-center gap-3"><input type="checkbox" checked={edit.enabled} disabled={!!busy || loading} onChange={e => setEdit({ ...edit, enabled: e.target.checked, trackId: edit.trackId ?? tracks[0]?.id ?? null })} />Dodaj muzykę w tle</label>
      {loading && <p role="status">Wczytuję utwory…</p>}
      {!loading && !tracks.length && <p className="text-sm text-ink-muted">Brak utworów w folderze music aplikacji.</p>}
      <fieldset disabled={!!busy || !edit.enabled || loading} className="space-y-3 disabled:opacity-50">
        <legend className="mb-2 text-sm font-medium">Wybierz utwór</legend>
        {tracks.map(track => <label key={track.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-line p-3 text-sm"><input type="radio" name="music-track" checked={edit.trackId === track.id} onChange={() => setEdit({ ...edit, trackId: track.id })} />{track.name}</label>)}
        <Button size="sm" disabled={!!busy || !edit.enabled || tracks.length < 2} onClick={() => {
          const others = tracks.filter(t => t.id !== edit.trackId)
          const chosen = others[Math.floor(Math.random() * others.length)]
          if (chosen) setEdit({ ...edit, trackId: chosen.id })
        }}>Wylosuj inny</Button>
        <label className="block text-sm">Głośność<select className={titleInputClass} value={edit.level} onChange={e => setEdit({ ...edit, level: e.target.value as MusicEdit['level'] })}>
          <option value="subtle">Subtelnie — zalecane</option><option value="standard">Standardowo</option><option value="strong">Wyraźniej</option>
        </select></label>
      </fieldset>
      <p className="text-xs text-ink-muted">Pierwsze 3 sekundy ciszej, potem łagodne narastanie. Muzyka utrzymuje stałą głośność podczas mowy i wygasa na końcu.</p>
      <Button disabled={!!busy || loading || !valid} loading={busy === 'preview'} onClick={() => { void run('preview') }}>Przygotuj odsłuch z głosem</Button>
      {currentPreview && <audio key={currentPreview.path} controls className="w-full" src={localFileUrl(currentPreview.path)} onError={() => setError('Nie można odtworzyć odsłuchu. Spróbuj przygotować go ponownie.')} />}
      {preview && !currentPreview && <p className="text-xs text-ink-muted">Zmieniono ustawienia. Przygotuj nowy odsłuch.</p>}
      {busy && <p role="status" className="text-sm text-ink-muted">{busy === 'preview' ? 'Przygotowuję odsłuch…' : 'Zapisuję nową wersję klipu…'}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <p className="text-xs text-ink-muted">Zapis ustawi nową wersję w bibliotece. Możesz później zmienić utwór lub wyłączyć muzykę. Bez ponownej analizy AI.</p>
    </div>
    <DialogFooter><Button disabled={!!busy} onClick={close}>Anuluj</Button><Button variant="primary" loading={busy === 'save'} disabled={!!busy || loading || !valid} onClick={() => { void run('save') }}>Zapisz klip</Button></DialogFooter>
  </Dialog>
}
