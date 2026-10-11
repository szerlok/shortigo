import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ImagePlus, Scissors, Undo2, Redo2, Video, Play, Pause, SkipBack, Trash2, Music2, ZoomIn, ZoomOut, GripVertical } from 'lucide-react'
import type { ClipArtifact, JobOutput } from '../../shared/job-output'
import { editorDuration, editorRenderKey, type EditorProject, type EditorSegment } from '../../shared/clip-editor'
import type { MusicTrack } from '../../shared/music'
import { getApi } from '../lib/ipc'
import { errorMessage, formatTimecode, localFileUrl } from '../lib/utils'
import { Dialog, DialogFooter } from './ui/Dialog'
import { Button } from './ui/Button'
import { titleInputClass } from './TitleControls'

const newId = (): string => crypto.randomUUID()
const preciseTime = (ms: number): string => `${formatTimecode(ms)}.${Math.floor(ms / 100) % 10}`
function segmentAt(project: EditorProject, positionMs: number): { segment: EditorSegment; index: number; startMs: number; sourceMs: number } {
  let startMs = 0
  for (let index = 0; index < project.segments.length; index++) {
    const segment = project.segments[index]
    const endMs = startMs + segment.endMs - segment.startMs
    if (positionMs < endMs || index === project.segments.length - 1) {
      return { segment, index, startMs, sourceMs: segment.startMs + Math.max(0, Math.min(positionMs - startMs, segment.endMs - segment.startMs)) }
    }
    startMs = endMs
  }
  throw new Error('Projekt nie ma fragmentów')
}

export function ClipTimelineEditor({ clip, directory, onClose, onSaved }: {
  clip: ClipArtifact; directory: string; onClose: () => void; onSaved: (output: JobOutput) => void
}): React.JSX.Element {
  const [project, setProject] = useState<EditorProject | null>(null)
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [past, setPast] = useState<EditorProject[]>([])
  const [future, setFuture] = useState<EditorProject[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [preview, setPreview] = useState<{ path: string; key: string } | null>(null)
  const [busy, setBusy] = useState<'preview' | 'save' | 'export' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const panel = useRef<HTMLDivElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const sourceDurations = useRef<Record<string, number>>({})
  const draggingSegment = useRef<string | null>(null)
  const trimming = useRef<{ project: EditorProject; id: string; edge: 'startMs' | 'endMs'; x: number; msPerPixel: number; maximum: number } | null>(null)
  const autoAdvance = useRef(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])

  useEffect(() => {
    mounted.current = true
    let active = true
    Promise.all([getApi().clips.loadProject(directory, clip.clip_index), getApi().clips.musicTracks()])
      .then(([loaded, available]) => { if (active) { setProject({ ...loaded, name: loaded.name ?? `${clip.summary || `Klip ${clip.clip_index + 1}`} (montaż)` }); setTracks(available); setSelected(loaded.segments[0]?.id ?? null) } })
      .catch(e => { if (active) setError(errorMessage(e, 'Nie udało się otworzyć edytora')) })
    return () => { active = false; mounted.current = false }
  }, [directory, clip.clip_index])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')].filter(item => item.getClientRects().length > 0)
        const first = items[0], last = items[items.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [close])

  const normalizeProject = (next: EditorProject): EditorProject => {
    const total = editorDuration(next)
    return { ...next, overlays: next.overlays
      .filter(o => o.startMs < total - 100)
      .map(o => ({ ...o, endMs: Math.min(total, Math.max(o.startMs + 100, o.endMs)) })) }
  }
  const change = (next: EditorProject): void => {
    if (!project) return
    autoAdvance.current = false
    player.current?.pause()
    next = normalizeProject(next)
    setPast(previous => [...previous.slice(-29), project]); setFuture([]); setProject(next)
    setError(null); setNotice(null)
    setPlayheadMs(v => Math.min(v, editorDuration(next)))
  }
  const undo = (): void => {
    if (!project || !past.length) return
    autoAdvance.current = false; player.current?.pause()
    setPlayheadMs(v => Math.min(v, editorDuration(past[past.length - 1])))
    setSelected(past[past.length - 1].segments.some(s => s.id === selected) ? selected : past[past.length - 1].segments[0].id)
    setFuture([project, ...future]); setProject(past[past.length - 1]); setPast(past.slice(0, -1))
  }
  const redo = (): void => {
    if (!project || !future.length) return
    autoAdvance.current = false; player.current?.pause()
    setPlayheadMs(v => Math.min(v, editorDuration(future[0])))
    setSelected(future[0].segments.some(s => s.id === selected) ? selected : future[0].segments[0].id)
    setPast([...past, project]); setProject(future[0]); setFuture(future.slice(1))
  }
  const run = async (action: 'preview' | 'save' | 'export'): Promise<void> => {
    if (!project || busyRef.current) return
    autoAdvance.current = false; player.current?.pause()
    busyRef.current = true; setBusy(action); setError(null); setNotice(null)
    try {
      if (action === 'preview') {
        const path = await getApi().clips.previewProject(directory, clip.clip_index, project)
        if (mounted.current) { setPreview({ path, key: editorRenderKey(project) }); setPlayheadMs(0) }
      } else if (action === 'save') {
        await getApi().clips.saveProject(directory, clip.clip_index, project)
        if (mounted.current) setNotice('Projekt zapisany. Możesz wrócić do niego później.')
      } else {
        const output = await getApi().clips.exportProject(directory, clip.clip_index, project)
        if (!output) throw new Error('Nie udało się odczytać zapisanego klipu')
        if (mounted.current) onSaved(output)
      }
    } catch (e) { if (mounted.current) setError(errorMessage(e, 'Nie udało się przygotować klipu')) }
    finally { busyRef.current = false; if (mounted.current) setBusy(null) }
  }
  const importAsset = async (kind: 'video' | 'image'): Promise<void> => {
    if (!project || busyRef.current) return
    busyRef.current = true; setBusy('import'); setError(null)
    try {
      const asset = await getApi().clips.importAsset(directory, clip.clip_index, kind)
      if (!asset || !mounted.current) return
      if (kind === 'video') {
        const segment = { id: newId(), file: asset.file, startMs: 0, endMs: asset.durationMs }
        sourceDurations.current[asset.file] = asset.durationMs
        change({ ...project, segments: [...project.segments, segment] }); setSelected(segment.id)
      } else {
        const total = editorDuration(project)
        const begin = Math.min(playheadMs, Math.max(0, total - 100))
        const overlay = { id: newId(), file: asset.file, startMs: begin, endMs: Math.min(total, begin + 5000), x: 0.6, y: 0.12, width: 0.3 }
        change({ ...project, overlays: [...project.overlays, overlay] })
      }
    } catch (e) { if (mounted.current) setError(errorMessage(e, 'Nie udało się dodać pliku')) }
    finally { busyRef.current = false; if (mounted.current) setBusy(null) }
  }
  const duration = project ? editorDuration(project) : 0
  const selectedSegment = project?.segments.find(s => s.id === selected) ?? null
  const selectedIndex = project?.segments.findIndex(s => s.id === selected) ?? -1
  const previewCurrent = project && preview?.key === editorRenderKey(project)
  const active = project ? segmentAt(project, playheadMs) : null
  const playerPath = previewCurrent ? preview.path : active ? `${directory}/${active.segment.file}` : ''
  const playerKey = previewCurrent ? preview.path : active?.segment.id ?? ''
  const split = (): void => {
    if (!project) return
    let elapsed = 0
    const index = project.segments.findIndex(s => { const hit = playheadMs > elapsed + 100 && playheadMs < elapsed + s.endMs - s.startMs - 100; elapsed += s.endMs - s.startMs; return hit })
    if (index < 0) { setError('Ustaw wskaźnik co najmniej 0,1 s od granicy fragmentu.'); return }
    const segment = project.segments[index]
    const local = playheadMs - (elapsed - (segment.endMs - segment.startMs))
    const cut = segment.startMs + local
    const first: EditorSegment = { ...segment, endMs: cut }
    const second: EditorSegment = { ...segment, id: newId(), startMs: cut }
    change({ ...project, segments: [...project.segments.slice(0, index), first, second, ...project.segments.slice(index + 1)] })
    setSelected(second.id)
  }
  const updateSegment = (part: Partial<EditorSegment>): void => {
    if (!project || selectedIndex < 0) return
    const segments = project.segments.map((s, i) => i === selectedIndex ? { ...s, ...part } : s)
    const updated = segments[selectedIndex]
    if (!Number.isFinite(updated.startMs) || !Number.isFinite(updated.endMs) || updated.endMs - updated.startMs < 100 || updated.startMs < 0 ||
      updated.endMs > (sourceDurations.current[updated.file] ?? project.segments[selectedIndex].endMs)) return
    change({ ...project, segments })
  }
  const moveSegment = (direction: -1 | 1): void => {
    if (!project || selectedIndex < 0) return
    const target = selectedIndex + direction
    if (target < 0 || target >= project.segments.length) return
    const segments = [...project.segments]; [segments[selectedIndex], segments[target]] = [segments[target], segments[selectedIndex]]
    change({ ...project, segments })
  }
  const updateOverlay = (id: string, part: Partial<EditorProject['overlays'][number]>): void => {
    if (!project) return
    change({ ...project, overlays: project.overlays.map(o => {
      if (o.id !== id) return o
      const next = { ...o, ...part }
      next.startMs = Math.max(0, Math.min(duration - 100, next.startMs))
      next.endMs = Math.max(next.startMs + 100, Math.min(duration, next.endMs))
      next.width = Math.max(0.05, Math.min(1, next.width))
      next.x = Math.max(0, Math.min(1 - next.width, next.x))
      next.y = Math.max(0, Math.min(1, next.y))
      return next
    }) })
  }
  const seek = (position: number, resume = false): void => {
    if (!project || busyRef.current) return
    const at = Math.max(0, Math.min(position, duration))
    const target = segmentAt(project, at)
    autoAdvance.current = resume
    player.current?.pause()
    setPlayheadMs(at)
    if (!player.current) return
    if (previewCurrent || target.segment.id === active?.segment.id) {
      player.current.currentTime = (previewCurrent ? at : target.sourceMs) / 1000
      if (resume) { autoAdvance.current = false; void player.current.play().catch(() => {}) }
    }
  }
  const togglePlayback = (): void => {
    if (!project || busyRef.current || !player.current) return
    if (!player.current.paused) { autoAdvance.current = false; player.current.pause() }
    else if (playheadMs >= duration - 50) seek(0, true)
    else void player.current.play().catch(() => setError('Podgląd jeszcze się wczytuje. Spróbuj ponownie za chwilę.'))
  }
  const removeSegment = (): void => {
    if (!project || project.segments.length < 2 || !selectedSegment || busyRef.current) return
    const segments = project.segments.filter(s => s.id !== selected)
    change({ ...project, segments }); setSelected(segments[Math.min(selectedIndex, segments.length - 1)].id)
  }
  const dropSegment = (id: string): void => {
    if (!project || busyRef.current || !draggingSegment.current || draggingSegment.current === id) return
    const segments = [...project.segments]
    const from = segments.findIndex(s => s.id === draggingSegment.current)
    const to = segments.findIndex(s => s.id === id)
    if (from < 0 || to < 0) return
    const [moved] = segments.splice(from, 1); segments.splice(to, 0, moved)
    change({ ...project, segments }); setSelected(moved.id); draggingSegment.current = null
  }
  const timelinePosition = (clientX: number): number => {
    const box = timeline.current?.getBoundingClientRect()
    return box ? Math.round(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration) : 0
  }
  // Keep a paused source preview aligned when a trim changes its in/out points.
  useEffect(() => {
    if (active && !previewCurrent && player.current && player.current.readyState >= 1 && player.current.paused) {
      player.current.currentTime = active.sourceMs / 1000
    }
  }, [active?.segment.startMs, active?.segment.endMs, playerPath, previewCurrent])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      if (!project || busyRef.current || !panel.current?.contains(event.target as Node)) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo() }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
      else if (!modifier && !event.altKey) {
        if (event.code === 'Space') { event.preventDefault(); togglePlayback() }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(playheadMs + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100)) }
        else if (event.key.toLowerCase() === 's') { event.preventDefault(); split() }
        else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSegment() }
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  })
  return <Dialog ref={panel} aria-labelledby="timeline-heading" panelClassName="max-w-[1380px]" onBackdropMouseDown={close}>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
      <div><h2 id="timeline-heading" className="text-lg font-semibold">Edytuj klip</h2><p className="mt-0.5 max-w-lg truncate text-xs text-ink-muted">{clip.summary || `Klip ${clip.clip_index + 1}`}</p></div>
      <span className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-muted">Eksport zapisuje nowy klip</span>
    </div>
    <div className="min-h-0 overflow-y-auto">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-label="Podgląd filmu" className="flex min-w-0 flex-col bg-black/15 p-4">
          <div className="mb-3 flex items-center justify-between gap-2 text-xs text-ink-muted"><span>Podgląd</span><span>{previewCurrent ? 'Podgląd gotowego montażu' : 'Podgląd roboczy'}</span></div>
          <div className="flex min-h-[260px] flex-1 items-center justify-center rounded-xl bg-black/70">
            <div className="relative mx-auto w-fit max-w-full overflow-hidden">
              <video ref={player} key={playerKey} src={playerPath ? localFileUrl(playerPath) : undefined} playsInline preload="metadata"
                aria-label="Podgląd klipu" className="max-h-[41vh] max-w-full cursor-pointer" onClick={togglePlayback}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onLoadedMetadata={e => {
                  if (previewCurrent || !active) return
                  sourceDurations.current[active.segment.file] = Math.round(e.currentTarget.duration * 1000)
                  e.currentTarget.currentTime = active.sourceMs / 1000
                  if (autoAdvance.current && active.sourceMs === 0) { autoAdvance.current = false; void e.currentTarget.play().catch(() => {}) }
                }}
                onSeeked={e => { if (autoAdvance.current) { autoAdvance.current = false; void e.currentTarget.play().catch(() => {}) } }}
                onTimeUpdate={e => {
                  if (previewCurrent) { setPlayheadMs(Math.round(e.currentTarget.currentTime * 1000)); return }
                  if (!active || !project) return
                  const current = e.currentTarget.currentTime * 1000
                  if (current < active.segment.startMs - 40) { e.currentTarget.currentTime = active.segment.startMs / 1000; return }
                  if (current >= active.segment.endMs - 40) {
                    // pause() emits one more timeupdate; keep the pending transition's play intent.
                    const continuePlayback = autoAdvance.current || !e.currentTarget.paused || e.currentTarget.ended
                    e.currentTarget.pause()
                    if (active.index < project.segments.length - 1) {
                      autoAdvance.current = continuePlayback
                      setPlayheadMs(active.startMs + active.segment.endMs - active.segment.startMs)
                    } else setPlayheadMs(editorDuration(project))
                  } else setPlayheadMs(Math.round(active.startMs + current - active.segment.startMs))
                }}
                onError={() => setError('Nie można odtworzyć podglądu w aplikacji. Spróbuj przygotować pełny podgląd przyciskiem poniżej.')} />
              {!previewCurrent && project?.overlays.filter(o => playheadMs >= o.startMs && playheadMs < o.endMs).map(o => <img key={o.id} src={localFileUrl(`${directory}/${o.file}`)} alt="Grafika na filmie"
                title="Przeciągnij, aby przesunąć grafikę"
                onPointerDown={e => { if (busy) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); player.current?.pause(); setPast(previous => [...previous.slice(-29), project]); setFuture([]) }}
                onPointerMove={e => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                  const box = e.currentTarget.parentElement?.getBoundingClientRect()
                  if (!box) return
                  const x = Math.max(0, Math.min(1 - o.width, (e.clientX - box.left - e.currentTarget.offsetWidth / 2) / box.width))
                  const y = Math.max(0, Math.min(1, (e.clientY - box.top - e.currentTarget.offsetHeight / 2) / box.height))
                  setProject(current => current ? { ...current, overlays: current.overlays.map(item => item.id === o.id ? { ...item, x, y } : item) } : current)
                }}
                style={{ position: 'absolute', left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.width * 100}%`, touchAction: 'none', cursor: 'grab' }} />)}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button size="sm" iconOnly title="Wróć na początek" aria-label="Wróć na początek" disabled={!project || !!busy} onClick={() => seek(0)} icon={<SkipBack className="h-4 w-4" />} />
              <Button variant="primary" iconOnly title="Odtwórz / pauza · Spacja" aria-label={playing ? 'Pauza' : 'Odtwórz podgląd'} disabled={!project || !!busy} onClick={togglePlayback} icon={playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />} />
              <span className="ml-1 font-mono text-xs tabular-nums">{preciseTime(playheadMs)}<span className="text-ink-muted"> / {preciseTime(duration)}</span></span>
            </div>
            <Button size="sm" loading={busy === 'preview'} disabled={!project || !!busy} onClick={() => { void run('preview') }}>Przygotuj podgląd</Button>
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">{previewCurrent ? 'Gotowy obraz i dźwięk, tak jak w eksporcie.' : 'Cięcia i grafiki widać od razu. Przygotuj podgląd, aby usłyszeć muzykę i zobaczyć tytuł.'}</p>
        </section>
        <aside className="min-w-0 border-l border-line p-4 lg:max-h-[54vh] lg:overflow-y-auto"><fieldset disabled={!!busy} className="min-w-0 space-y-4">
          {!project ? <p role="status" className="text-sm text-ink-muted">Wczytuję projekt…</p> : <>
            <label className="block text-xs font-medium">Nazwa nowego klipu<input className={titleInputClass} maxLength={240} value={project.name ?? ''} onChange={e => change({ ...project, name: e.target.value })} /></label>
            <section className="space-y-3 rounded-xl border border-line bg-white/[0.025] p-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Scissors className="h-4 w-4 text-blue-400" />{selectedSegment ? `Fragment ${selectedIndex + 1}` : 'Przycinanie'}</div>
              {selectedSegment ? <>
                <p className="text-xs text-ink-muted">Przeciągnij krawędzie fragmentu na osi lub wpisz początek i koniec w materiale źródłowym.</p>
                <div className="grid grid-cols-2 gap-3">{(['startMs', 'endMs'] as const).map(field => <label key={field} className="text-xs text-ink-muted">{field === 'startMs' ? 'Początek (s)' : 'Koniec (s)'}<input type="number" min="0" step="0.1" value={selectedSegment[field] / 1000} className={titleInputClass} onChange={e => updateSegment({ [field]: Math.round(Number(e.target.value) * 1000) })} /></label>)}</div>
                <div className="flex items-center gap-1.5"><Button size="sm" title="Przesuń fragment wcześniej" disabled={selectedIndex === 0 || !!busy} onClick={() => moveSegment(-1)} icon={<ArrowLeft className="h-3.5 w-3.5" />}>Wcześniej</Button><Button size="sm" title="Przesuń fragment później" disabled={selectedIndex === project.segments.length - 1 || !!busy} onClick={() => moveSegment(1)} icon={<ArrowRight className="h-3.5 w-3.5" />}>Później</Button></div>
              </> : <p className="text-xs text-ink-muted">Kliknij fragment na osi czasu, aby go przyciąć.</p>}
            </section>
            <section className="space-y-3 border-t border-line pt-3"><h3 className="flex items-center gap-2 text-sm font-medium"><Music2 className="h-4 w-4 text-emerald-400" />Muzyka</h3><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={project.music.enabled} disabled={!!busy || (!tracks.length && !project.music.enabled)} onChange={e => change({ ...project, music: { ...project.music, enabled: e.target.checked, trackId: project.music.trackId ?? tracks[0]?.id ?? null } })} />Muzyka w tle</label>
              {project.music.enabled && <div className="space-y-2"><label className="block text-xs">Utwór<select className={titleInputClass} value={project.music.trackId ?? ''} onChange={e => change({ ...project, music: { ...project.music, trackId: e.target.value } })}>{tracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label className="block text-xs">Głośność<select className={titleInputClass} value={project.music.level} onChange={e => change({ ...project, music: { ...project.music, level: e.target.value as EditorProject['music']['level'] } })}><option value="subtle">Subtelna</option><option value="standard">Standardowa</option><option value="strong">Wyraźna</option></select></label></div>}
            </section>
            {project.overlays.length > 0 && <section className="space-y-3 border-t border-line pt-3"><h3 className="text-sm font-medium">Grafiki</h3><p className="text-xs text-ink-muted">Przeciągnij grafikę na obrazie lub ustaw jej pozycję i czas poniżej.</p>
              {project.overlays.map((o, i) => <details key={o.id} open={project.overlays.length === 1} className="rounded-xl border border-line p-3 text-xs"><summary className="cursor-pointer font-medium">Grafika {i + 1} · {formatTimecode(o.startMs)}–{formatTimecode(o.endMs)}</summary><div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">{([['startMs','Początek (s)'],['endMs','Koniec (s)'],['x','Poziom (%)'],['y','Pion (%)'],['width','Szerokość (%)']] as const).map(([field,label]) => <label key={field}>{label}<input className={titleInputClass} type="number" step={field.endsWith('Ms') ? '0.1' : '1'} min={field === 'width' ? 5 : 0} max={field.endsWith('Ms') ? duration / 1000 : 100}
                  value={field.endsWith('Ms') ? o[field] * 0.001 : Math.round(o[field] * 100)} onChange={e => updateOverlay(o.id, { [field]: field.endsWith('Ms') ? Math.round(Number(e.target.value) * 1000) : Number(e.target.value) / 100 })} /></label>)}</div><Button size="sm" variant="ghost" onClick={() => change({ ...project, overlays: project.overlays.filter(item => item.id !== o.id) })} icon={<Trash2 className="h-3.5 w-3.5" />}>Usuń grafikę</Button></div></details>)}
            </section>}
          </>}
        </fieldset></aside>
      </div>
      {project && <section className="space-y-3 border-t border-line bg-black/20 p-4" aria-labelledby="timeline-track-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2"><h3 id="timeline-track-heading" className="mr-2 text-sm font-medium">Oś filmu</h3><Button size="sm" title="Cofnij · ⌘/Ctrl Z" aria-label="Cofnij" iconOnly disabled={!past.length || !!busy} onClick={undo} icon={<Undo2 className="h-4 w-4" />} /><Button size="sm" title="Ponów · ⌘/Ctrl Shift Z" aria-label="Ponów" iconOnly disabled={!future.length || !!busy} onClick={redo} icon={<Redo2 className="h-4 w-4" />} /><span className="mx-1 h-5 w-px bg-white/10" /><Button size="sm" title="Podziel w miejscu wskaźnika · S" disabled={!!busy} onClick={split} icon={<Scissors className="h-4 w-4" />}>Podziel tutaj</Button><Button size="sm" title="Usuń zaznaczony fragment · Delete" disabled={project.segments.length === 1 || !selectedSegment || !!busy} onClick={removeSegment} icon={<Trash2 className="h-4 w-4" />}>Usuń fragment</Button></div>
          <div className="flex items-center gap-1"><Button size="sm" iconOnly aria-label="Oddal oś czasu" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 0.5))} icon={<ZoomOut className="h-4 w-4" />} /><span className="w-10 text-center font-mono text-xs text-ink-muted">{zoom}×</span><Button size="sm" iconOnly aria-label="Przybliż oś czasu" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + 0.5))} icon={<ZoomIn className="h-4 w-4" />} /></div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-line bg-black/20 px-3 pb-3 pt-2">
          <div ref={timeline} className="relative" style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
            <div className="relative mb-2 h-7 cursor-crosshair select-none" title="Kliknij, aby przewinąć film" onPointerDown={e => { if (busy) return; e.currentTarget.setPointerCapture(e.pointerId); seek(timelinePosition(e.clientX)) }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(timelinePosition(e.clientX)) }}>
              {Array.from({ length: 11 }, (_, i) => <span key={i} className="pointer-events-none absolute bottom-0 border-l border-white/15 pl-1 pb-1 font-mono text-[10px] text-ink-muted" style={{ left: `${i * 10}%`, transform: i === 10 ? 'translateX(-100%)' : undefined }}>{(duration < 10000 ? preciseTime : formatTimecode)(duration * i / 10)}</span>)}
            </div>
            <div className="flex h-16">{project.segments.map((s, i) => <div key={s.id} draggable={!busy} onDragStart={e => { draggingSegment.current = s.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id) }} onDragEnd={() => { draggingSegment.current = null }} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }} onDrop={e => { e.preventDefault(); dropSegment(s.id) }}
              className={`relative min-w-0 shrink-0 overflow-hidden rounded-md border ${selected === s.id ? 'z-10 border-blue-300 bg-blue-500/40 ring-1 ring-blue-300/70' : 'border-blue-400/25 bg-blue-500/15'}`} style={{ width: `${(s.endMs - s.startMs) / duration * 100}%` }}>
              <button type="button" title={`${s.file} · ${formatTimecode(s.endMs - s.startMs)}`} disabled={!!busy} onClick={e => { setSelected(s.id); seek(timelinePosition(e.clientX)); panel.current?.focus() }} className="h-full w-full overflow-hidden px-3 text-left text-xs text-blue-100">
                <span className="flex items-center gap-1.5 truncate"><Video className="h-3.5 w-3.5 shrink-0 opacity-70" /><span className="truncate">{s.file.includes('.asset-') ? 'Dodany film' : `Klip ${i + 1}`}</span></span><span className="mt-1 block truncate font-mono text-[10px] opacity-70">{formatTimecode(s.endMs - s.startMs)}</span>
              </button>
              {selected === s.id && (['startMs', 'endMs'] as const).map(edge => <button key={edge} type="button" aria-label={edge === 'startMs' ? 'Przytnij początek fragmentu' : 'Przytnij koniec fragmentu'} title="Przeciągnij, aby przyciąć" disabled={!!busy} draggable={false} onDragStart={e => e.preventDefault()}
                className={`absolute bottom-0 top-0 flex w-2.5 cursor-ew-resize items-center justify-center bg-blue-300/70 text-blue-950 hover:bg-blue-200 ${edge === 'startMs' ? 'left-0' : 'right-0'}`} style={{ touchAction: 'none' }}
                onPointerDown={e => { e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); autoAdvance.current = false; player.current?.pause(); trimming.current = { project, id: s.id, edge, x: e.clientX, msPerPixel: duration / (timeline.current?.getBoundingClientRect().width || 1), maximum: sourceDurations.current[s.file] ?? s.endMs }; setPast(previous => [...previous.slice(-29), project]); setFuture([]) }}
                onPointerMove={e => {
                  const drag = trimming.current
                  if (!drag || !e.currentTarget.hasPointerCapture(e.pointerId)) return
                  const original = drag.project.segments.find(item => item.id === drag.id)!
                  const delta = Math.round((e.clientX - drag.x) * drag.msPerPixel / 100) * 100
                  const value = drag.edge === 'startMs' ? Math.max(0, Math.min(original.endMs - 100, original.startMs + delta)) : Math.max(original.startMs + 100, Math.min(drag.maximum, original.endMs + delta))
                  const next = normalizeProject({ ...drag.project, segments: drag.project.segments.map(item => item.id === drag.id ? { ...item, [drag.edge]: value } : item) })
                  setProject(next); setPlayheadMs(v => Math.min(v, editorDuration(next))); setNotice(null)
                }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); trimming.current = null }} onPointerCancel={() => { trimming.current = null }}><GripVertical className="h-4 w-3" /></button>)}
            </div>)}</div>
            {project.overlays.map((o, i) => <div key={o.id} className="relative mt-1.5 h-6"><button type="button" title={`Grafika ${i + 1}: ${formatTimecode(o.startMs)}–${formatTimecode(o.endMs)}`} onClick={() => seek(o.startMs)} className="absolute h-full overflow-hidden rounded border border-purple-400/30 bg-purple-500/20 px-2 text-left text-[10px] text-purple-200" style={{ left: `${o.startMs / duration * 100}%`, width: `${(o.endMs - o.startMs) / duration * 100}%` }}>Grafika {i + 1}</button></div>)}
            {project.music.enabled && <div className="mt-1.5 flex h-6 items-center gap-2 overflow-hidden rounded border border-emerald-400/20 bg-emerald-500/15 px-2 text-[10px] text-emerald-200"><Music2 className="h-3 w-3 shrink-0" /><span className="truncate">{tracks.find(t => t.id === project.music.trackId)?.name ?? 'Muzyka w tle'}</span></div>}
            <div className="pointer-events-none absolute bottom-0 top-4 z-20 w-px bg-white/90 shadow-sm" style={{ left: `${Math.min(playheadMs / (duration || 1), 1) * 100}%` }}><div className="absolute -left-1 -top-1 h-2.5 w-2.5 rotate-45 rounded-[1px] bg-white" /></div>
          </div>
        </div>
        <input aria-label="Pozycja na osi czasu" type="range" min="0" max={duration || 1} step="100" value={Math.min(playheadMs, duration)} className="block h-2 w-full accent-blue-400" disabled={!!busy} onChange={e => seek(Number(e.target.value))} />
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-2"><Button size="sm" disabled={!!busy || project.segments.length >= 30} onClick={() => { void importAsset('video') }} icon={<Video className="h-4 w-4" />}>Dodaj fragment innego filmu</Button><Button size="sm" disabled={!!busy || project.overlays.length >= 20} onClick={() => { void importAsset('image') }} icon={<ImagePlus className="h-4 w-4" />}>Dodaj grafikę w tym miejscu</Button></div><p className="text-[11px] text-ink-muted">Przeciągnij fragmenty, aby zmienić kolejność · Spacja: odtwarzanie · S: podział</p></div>
      </section>}
      {(busy || notice || error) && <div className="border-t border-line px-5 py-3">
        {busy && <p role="status" className="text-sm text-ink-muted">{busy === 'preview' ? 'Przygotowuję podgląd…' : busy === 'export' ? 'Zapisuję gotowy klip…' : busy === 'import' ? 'Dodaję plik…' : 'Zapisuję projekt…'}</p>}
        {notice && <p role="status" className="text-sm text-emerald-400">{notice}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>}
    </div>
    <DialogFooter><Button disabled={!!busy} onClick={close}>Zamknij</Button><Button disabled={!project || !!busy} loading={busy === 'save'} onClick={() => { void run('save') }}>Zapisz projekt</Button><Button variant="primary" disabled={!project || !!busy} loading={busy === 'export'} onClick={() => { void run('export') }}>Eksportuj klip</Button></DialogFooter>
  </Dialog>
}
