import { ThumbnailDialog } from './ThumbnailDialog'
import { ClipTimelineEditor } from './ClipTimelineEditor'
import { ClipLibraryActions } from './ClipLibraryActions'
import { RunFolderActions } from './RunFolderActions'
import { parseJobOutput } from '../../shared/job-output'
import { TitleEditor } from './TitleEditor'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Clapperboard, CircleDollarSign, Clock3, Download, FolderOpen, ListPlus, Plus, Send, Timer } from 'lucide-react'
import { basename, cn, errorMessage, formatDuration, formatTimecode, formatUsd } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { clipFilePath } from '../lib/thumbnails'
import type { ApiCosts, ClipArtifact, JobOutput } from '../store/use-job-store'
import { ClipCard } from './ClipCard'
import { AddToAutomationDialog } from './AddToAutomationDialog'
import { PostDialog, type PostableClip } from './PostDialog'
import { Page } from './ui/Page'
import { PageHeader } from './ui/PageHeader'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { EmptyState } from './ui/EmptyState'
import { Callout } from './ui/Callout'
import { IconTile } from './ui/IconTile'
import { Segmented } from './ui/Segmented'
import type { Page as AppPage } from './Sidebar'

type Sort = 'score' | 'timeline'

interface ClipListProps {
  output: JobOutput
  /** The directory containing job_output.json, available for Library runs without clips. */
  outputDir?: string
  /** Shown above the title, e.g. a back link from the Library. */
  leading?: ReactNode
  onNewClip?: () => void
  onRunDeleted?: () => void
  /** Lets the post dialog send the user to Accounts to connect a platform. */
  onNavigate?: (page: AppPage) => void
}

/** Clips the post dialog handles in one go; each is still its own upload and post. */
const MAX_POST_BATCH = 10
const MAX_BANK_BATCH = 30

function toPostable(clip: ClipArtifact): PostableClip {
  return { path: clipFilePath(clip.s3_url), title: clip.summary || `Klip ${clip.clip_index + 1}`, tags: clip.tags, durationMs: clip.duration_ms, libraryKey: clip.library_key, sentTo: clip.sent_to }
}

export function ClipList({ output: originalOutput, outputDir: runDirectory, leading, onNewClip, onRunDeleted, onNavigate }: ClipListProps): React.JSX.Element {
  const [updatedOutput, setUpdatedOutput] = useState<JobOutput | null>(null)
  const [editingThumbnail, setEditingThumbnail] = useState<ClipArtifact | null>(null)
  const [editingTimeline, setEditingTimeline] = useState<ClipArtifact | null>(null)
  const [editing, setEditing] = useState<ClipArtifact | null>(null)
  const output = updatedOutput?.job_id === originalOutput.job_id ? updatedOutput : originalOutput
  useEffect(() => { setUpdatedOutput(null); setEditingThumbnail(null); setEditing(null); setEditingTimeline(null) }, [originalOutput.job_id])
  const [sort, setSort] = useState<Sort>('score')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [posting, setPosting] = useState<PostableClip[] | null>(null)
  const [bankClips, setBankClips] = useState<number[] | null>(null)
  const [addedToBank, setAddedToBank] = useState(false)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exportingRef = useRef(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Older Shortigo engine runs do not record output format; use the first thumbnail for those.
  const [aspect, setAspect] = useState<number | null>(null)
  const settings = output.metrics?.requested_settings
  const requestedAspect = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).aspect_ratio : null
  const vertical = requestedAspect === '9:16' ? true : requestedAspect === '16:9' ? false : aspect == null ? true : aspect < 1

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  useEffect(() => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setSelected(new Set())
    setAspect(null)
    setPosting(null)
    setBankClips(null)
    setAddedToBank(false)
    setExportError(null)
    setNotice(null)
  }, [output])

  const firstClip = output.clips[0]
  const outputDir = runDirectory ?? (firstClip ? clipFilePath(firstClip.s3_url).replace(/[\\/][^\\/]+$/, '') : '')

  useEffect(() => {
    if (!outputDir) return
    let active = true
    getApi().history.getJob(outputDir).then(value => {
      const parsed = parseJobOutput(value)
      if (active && parsed) setUpdatedOutput(parsed)
    }).catch(() => { /* Keep the current snapshot if the run is unavailable. */ })
    return () => { active = false }
  }, [outputDir, originalOutput.job_id])

  const topIndex = useMemo(() => {
    let best: ClipArtifact | null = null
    for (const clip of output.clips) if (!best || clip.virality_score > best.virality_score) best = clip
    return best?.clip_index ?? null
  }, [output.clips])

  const clips = useMemo(() => {
    const list = [...output.clips]
    return sort === 'score'
      ? list.sort((a, b) => b.virality_score - a.virality_score)
      : list.sort((a, b) => a.start_time_ms - b.start_time_ms)
  }, [output.clips, sort])

  const allSelected = selected.size > 0 && selected.size === clips.length

  const toggle = (index: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const exportSelected = async (): Promise<void> => {
    const picked = clips.filter((c) => selected.has(c.clip_index))
    if (picked.length === 0 || exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    setExportError(null)
    try {
      const result = await getApi().clips.bulkExport(
        picked.map((c) => ({ path: clipFilePath(c.s3_url), name: c.summary || `Klip ${c.clip_index + 1}` }))
      )
      if (result.success) {
        setAddedToBank(false)
        setNotice(`Wyeksportowano klipy: ${result.count}${result.destDir ? ` do ${basename(result.destDir)}` : ''}${result.failedCount ? `; ${result.failedCount} nie udało się skopiować` : ''}`)
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(null), 3500)
      } else if (result.failedCount) {
        setExportError("Nie udało się skopiować klipów do tego folderu.")
      }
    } catch (err) {
      setExportError(errorMessage(err, "Nie udało się wyeksportować klipów. Spróbuj ponownie."))
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }

  const costs = readCosts(output.metrics?.api_costs)
  const hasCosts = costs !== null
  const framingNotice = framingProblem(output, vertical)
  const analysisNotice = sourceAnalysisNotice(output)

  return (
    <Page width="wide">
      <PageHeader
        leading={leading}
        eyebrow={leading ? undefined : "Twoje klipy"}
        title={output.source_video_title || "Film bez tytułu"}
        description={
          output.created_at
            ? `Wygenerowano ${new Date(output.created_at).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })}`
            : undefined
        }
        actions={
          <>
            {outputDir && (
              <Button icon={<FolderOpen className="h-4 w-4" />} onClick={() => getApi().shell.openPath(outputDir)}>
                Otwórz folder
              </Button>
            )}
            {onNewClip && (
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onNewClip}>
                Nowy klip
              </Button>
            )}
            {outputDir && (onRunDeleted || onNavigate) && <RunFolderActions directory={outputDir}
              onChanged={() => { if (onRunDeleted) onRunDeleted(); else onNavigate?.('library') }} />}
          </>
        }
      />

      {exportError && (
        <Callout tone="danger" className="mt-4" onDismiss={() => setExportError(null)}>
          {exportError}
        </Callout>
      )}

      <dl className="glass mt-5 grid grid-cols-2 overflow-hidden rounded-3xl min-[900px]:grid-cols-4 [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(odd)]:border-r min-[900px]:[&>div:nth-child(-n+2)]:border-b-0 min-[900px]:[&>div:not(:last-child)]:border-r">
        <Stat icon={<Clapperboard />} label="Klipy" value={String(output.total_clips)} />
        <Stat icon={<Timer />} label="Długość źródła" value={formatTimecode(output.source_video_duration_seconds * 1000)} />
        <Stat icon={<Clock3 />} label="Czas przetwarzania" value={formatDuration(output.processing_time_seconds * 1000)} />
        <Stat
          icon={<CircleDollarSign />}
          label="Koszt API"
          value={hasCosts ? formatUsd(costs!.total_estimated_cost_usd) : '—'}
          detail={hasCosts ? <CostDetail costs={costs!} /> : "Brak danych dla tego zadania"}
        />
      </dl>

      {framingNotice && (
        <Callout tone="warning" className="mt-3">
          <span className="text-ink-muted">{framingNotice}</span>
        </Callout>
      )}

      {analysisNotice && (
        <Callout tone="warning" className="mt-3">
          <span className="text-ink-muted">{analysisNotice}</span>
        </Callout>
      )}

      {/* Floating glass toolbar; sticks just below the 40px title-bar strip. */}
      <div className="glass-thick sticky top-12 z-10 mt-3 flex items-center justify-between gap-3 rounded-2xl py-2 pl-3 pr-2">
        <div className="flex min-w-0 items-center gap-3">
          <Checkbox
            checked={allSelected}
            indeterminate={selected.size > 0 && !allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(clips.map((c) => c.clip_index)))}
            label="Zaznacz wszystkie klipy"
          />
          <span className="whitespace-nowrap text-sm text-ink-muted">
            {selected.size > 0 ? (
              <>
                <span className="font-medium text-ink">{selected.size}</span> wybrano
              </>
            ) : (
              `${clips.length} klipów`
            )}
          </span>
          {notice && (
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-full bg-success/[0.1] px-2.5 py-1 text-xs text-success shadow-[inset_0_0_0_1px_rgb(var(--success)/0.25)] animate-fade-in">
              <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />
              <span className="truncate">{notice}</span>
              {addedToBank && onNavigate && <button className="shrink-0 font-semibold underline underline-offset-2" onClick={() => onNavigate('automations')}>Pokaż bank treści</button>}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selected.size > 0 && (
            <div className="flex items-center gap-1.5 animate-fade-in">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Wyczyść
              </Button>
              <Button
                size="sm"
                icon={<Send className="h-3.5 w-3.5" />}
                disabled={selected.size > MAX_POST_BATCH}
                title={selected.size > MAX_POST_BATCH ? `Opublikuj maksymalnie ${MAX_POST_BATCH} klipów jednocześnie` : undefined}
                onClick={() => setPosting(clips.filter((c) => selected.has(c.clip_index)).map(toPostable))}
              >
                Opublikuj {selected.size}
              </Button>
              {outputDir && <Button
                size="sm"
                icon={<ListPlus className="h-3.5 w-3.5" />}
                disabled={selected.size > MAX_BANK_BATCH}
                title={selected.size > MAX_BANK_BATCH ? `Dodaj maksymalnie ${MAX_BANK_BATCH} klipów jednocześnie` : "Skopiuj zaznaczone klipy do banku treści automatyzacji"}
                onClick={() => setBankClips(clips.filter((clip) => selected.has(clip.clip_index)).map((clip) => clip.clip_index))}
              >
                Dodaj {selected.size} do automatyzacji
              </Button>}
              <Button
                size="sm"
                variant="primary"
                loading={exporting}
                icon={<Download className="h-3.5 w-3.5" />}
                onClick={exportSelected}
              >
                Eksportuj {selected.size}
              </Button>
              <span aria-hidden className="mx-1 h-5 w-px bg-white/10" />
            </div>
          )}
          <Segmented<Sort>
            label="Sortowanie klipów"
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'score', label: "Najlepsze najpierw" },
              { value: 'timeline', label: "Chronologicznie" }
            ]}
          />
        </div>
      </div>

      {clips.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<Clapperboard />}
          title="Brak klipów w tym zadaniu"
          description="Zadanie zakończyło się bez zapisanych klipów. Sprawdź szczegóły w dzienniku."
        />
      ) : (
        <div
          className={cn(
            'mt-4 grid gap-4',
            vertical
              ? 'grid-cols-[repeat(auto-fill,minmax(160px,1fr))]'
              : 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]'
          )}
        >
          {clips.map((clip) => (
            <ClipCard
              key={clip.clip_index}
              clip={clip}
              vertical={vertical}
              topPick={clip.clip_index === topIndex && clips.length > 1}
              selected={selected.has(clip.clip_index)}
              selecting={selected.size > 0}
              onToggleSelect={() => toggle(clip.clip_index)}
              onAspect={aspect == null ? setAspect : undefined}
              onThumbnail={outputDir ? () => setEditingThumbnail(clip) : undefined}
              onEditTimeline={outputDir ? () => setEditingTimeline(clip) : undefined}
              onEditTitle={clip.title_base_url && clip.title_edit ? () => setEditing(clip) : undefined}
              onPost={() => setPosting([toPostable(clip)])}
              libraryActions={outputDir && <ClipLibraryActions directory={outputDir} clip={clip} onSaved={setUpdatedOutput} />}
            />
          ))}
        </div>
      )}

      {editingThumbnail && <ThumbnailDialog clip={editingThumbnail} directory={outputDir} onClose={() => setEditingThumbnail(null)} onSaved={setUpdatedOutput} />}
      {editingTimeline && <ClipTimelineEditor clip={editingTimeline} directory={outputDir} onClose={() => setEditingTimeline(null)} onSaved={(next) => { setUpdatedOutput(next); setEditingTimeline(null); setNotice("Dodano nowy klip z montażem. Oryginał pozostał w bibliotece.") }} />}
      {editing && <TitleEditor clip={editing} directory={outputDir} onClose={() => setEditing(null)} onSaved={(next) => { setUpdatedOutput(next); setEditing(null); setNotice("Zapisano nową wersję klipu.") }} />}
      {posting && <PostDialog clips={posting} onClose={() => setPosting(null)} onNavigate={onNavigate} />}
      {bankClips && outputDir && <AddToAutomationDialog
        outputDir={outputDir}
        clipIndices={bankClips}
        onClose={() => setBankClips(null)}
        onAdded={(name) => {
          setBankClips(null)
          setSelected(new Set())
          setAddedToBank(true)
          setNotice(`Dodano klipy (${bankClips.length}) do ${name}.`)
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
          noticeTimer.current = setTimeout(() => setNotice(null), 6000)
        }}
      />}
    </Page>
  )
}

/** Small glass capsule that returns from a run to the list it was opened from (ClipList's `leading`). */
export function BackLink({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="btn-glass inline-flex h-[30px] items-center gap-1.5 rounded-full pl-2.5 pr-3.5 text-xs font-medium text-ink-muted transition-[background,box-shadow,color] duration-200 hover:text-ink"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

/** Persisted runs may contain incomplete cost data; only display complete sections. */
function readCosts(value: unknown): ApiCosts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const amount = raw.total_estimated_cost_usd
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null
  const section = (name: string): Record<string, unknown> | null => {
    const part = raw[name]
    return part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null
  }
  const validMoney = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  const result: ApiCosts = { total_estimated_cost_usd: amount }
  const transcription = section('transcription')
  if (transcription && typeof transcription.provider === 'string' && typeof transcription.model === 'string' &&
      validMoney(transcription.audio_duration_seconds) && validMoney(transcription.estimated_cost_usd)) {
    result.transcription = transcription as unknown as NonNullable<ApiCosts['transcription']>
  }
  const planning = section('planning')
  if (planning && typeof planning.model === 'string' && validMoney(planning.total_tokens) &&
      validMoney(planning.attempts) && validMoney(planning.estimated_cost_usd)) {
    result.planning = planning as unknown as NonNullable<ApiCosts['planning']>
  }
  const layoutVision = section('layout_vision')
  if (layoutVision && typeof layoutVision.model === 'string' && validMoney(layoutVision.estimated_cost_usd)) {
    result.layout_vision = layoutVision as unknown as NonNullable<ApiCosts['layout_vision']>
  }
  return result
}

/** Explain when a vertical clip kept its whole frame or fell back during rendering. */
export function framingProblem(output: JobOutput, vertical: boolean): string | null {
  if (!vertical || output.clips.length === 0) return null
  const requested = output.metrics?.requested_settings
  const requestedClassic = requested && typeof requested === 'object' && !Array.isArray(requested) &&
    (requested as Record<string, unknown>).layout_style !== 'auto'
  if (requestedClassic) return null
  if (output.metrics?.smart_framing_available === false) {
    return "Inteligentne kadrowanie było niedostępne, więc klipy pokazują cały kadr. Brakuje OpenCV lub modelu twarzy. Otwórz Ustawienia → Sprawdzenie systemu."
  }
  const fallbacks = output.clips.filter((clip) => clip.render_fallback).length
  const notices: string[] = []
  if (fallbacks > 0) {
    notices.push(`${fallbacks} z ${output.clips.length} klipów używa całego kadru z powodu błędu inteligentnego kadrowania. Szczegóły są w dzienniku.`)
  }
  const clipIndices = new Set(output.clips.map((clip) => clip.clip_index))
  const wholeFrame = new Set<number>()
  const layouts = output.metrics?.clip_layouts
  if (Array.isArray(layouts)) {
    for (const layout of layouts) {
      if (layout && typeof layout === 'object' && layout.framing_status === 'whole_frame_auto' &&
        Number.isSafeInteger(layout.clip_index) && clipIndices.has(layout.clip_index)) {
        wholeFrame.add(layout.clip_index)
      }
    }
  }
  if (wholeFrame.size > 0) {
    const sorted = [...wholeFrame].sort((a, b) => a - b)
    const shown = sorted.slice(0, 5).map((index) => index + 1).join(', ')
    const more = sorted.length > 5 ? ` oraz ${sorted.length - 5} więcej` : ''
    notices.push(`Inteligentne kadrowanie zachowało cały kadr w klipach: ${shown}${more}. Sprawdź kadrowanie, jeśli oczekujesz bliższego ujęcia.`)
  }
  return notices.join(' ') || null
}

export function sourceAnalysisNotice(output: JobOutput): string | null {
  if (output.metrics?.planning_source !== 'visual') return null
  if (output.metrics.transcription_status === 'no_speech') {
    return "Nie wykryto mowy. Klipy wybrano na podstawie obrazu, więc napisy dialogowe są niedostępne."
  }
  if (output.metrics.transcription_status === 'failed') {
    return "Transkrypcja nie powiodła się. Klipy wybrano na podstawie obrazu, więc napisy dialogowe są niedostępne."
  }
  return null
}

function Stat({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0 px-4 py-4">
      <dt className="flex items-center gap-2">
        <IconTile size="sm" className="h-6 w-6 rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-ink-muted">{icon}</IconTile>
        <span className="eyebrow">{label}</span>
      </dt>
      <dd className="mt-3 font-mono text-xl font-medium tabular tracking-[-0.03em] text-ink">{value}</dd>
      {detail && <dd className="mt-1 truncate text-2xs text-ink-subtle">{detail}</dd>}
    </div>
  )
}

function CostDetail({ costs }: { costs: ApiCosts }): React.JSX.Element {
  const parts: string[] = []
  if (costs.transcription) parts.push(`Transkrypcja ${formatUsd(costs.transcription.estimated_cost_usd)}`)
  if (costs.planning) parts.push(`Planowanie ${formatUsd(costs.planning.estimated_cost_usd)}`)
  if (costs.layout_vision) parts.push(`Kadrowanie ${formatUsd(costs.layout_vision.estimated_cost_usd)}`)
  const title = [
    costs.transcription &&
      `Transkrypcja: ${costs.transcription.provider}/${costs.transcription.model}, ${formatDuration(costs.transcription.audio_duration_seconds * 1000)} dźwięku`,
    costs.planning &&
      `Planowanie: ${costs.planning.model}, ${costs.planning.total_tokens.toLocaleString()} tokenów${costs.planning.attempts > 1 ? `, ${costs.planning.attempts} prób` : ''}`,
    costs.layout_vision && `Kadrowanie: ${costs.layout_vision.model} sprawdzono położenie kamery i ekranu`,
    "Renderowanie: lokalnie w FFmpeg, bez opłat"
  ]
    .filter(Boolean)
    .join('\n')
  return <span title={title}>{parts.join(' · ')}</span>
}
