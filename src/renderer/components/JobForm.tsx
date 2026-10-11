import { TitlePresetPicker } from './TitlePresetPicker'
import { TITLE_PRESETS, selectedTitlePreset } from '../../shared/title-presets'
import { useEffect, useMemo, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, ListVideo, Minus, Plus, Sparkles } from 'lucide-react'
import { cn, MOD_KEY, parseTimecode, sourceLabel } from '../lib/utils'
import { useDraftStore, type ClipDraft, type WizardStep } from '../store/use-draft-store'
import { useActiveJobs } from '../store/use-job-store'
import type { ClipJobRequest } from '../../shared/jobs'
import { MAX_PARALLEL_JOBS } from '../../shared/jobs'
import { CaptionPresetPicker, CAPTION_PRESET_NAMES } from './CaptionPresetPicker'
import { SourcePicker } from './SourcePicker'
import { Panel } from './ui/Panel'
import { Switch } from './ui/Switch'
import { Button } from './ui/Button'
import { TextInput } from './ui/Field'
import { IconTile } from './ui/IconTile'
import { SettingRow } from './ui/SettingRow'
import { onRadioKeyDown } from './ui/Segmented'
import { DURATION_OPTIONS } from '../../shared/job-contract'

const DURATIONS = DURATION_OPTIONS

const FORMATS = [
  { id: '9:16', label: "Pionowy", hint: 'Shorts, Reels, TikTok', w: 12, h: 21 },
  { id: '16:9', label: "Poziomy", hint: 'YouTube, X, LinkedIn', w: 24, h: 14 }
] as const

const LAYOUT_STYLES = [
  { id: 'auto', label: "Inteligentny", hint: "Automatycznie kadruje ujęcia" },
  { id: 'fill', label: "Wypełnienie", hint: "Podąża za osobą mówiącą" },
  { id: 'fit', label: "Klasyczny", hint: "Cały kadr, rozmyte tło" }
] as const

const MAX_CLIPS = 100

export const WIZARD_STEPS: { id: WizardStep; label: string; title: string; description: string }[] = [
  { id: 'video', label: "Film", title: "Wybierz film", description: "Plik z komputera lub link do YouTube. Możesz wybrać tylko fragment." },
  { id: 'format', label: 'Format', title: "Format i kadrowanie", description: "Wybierz proporcje obrazu i sposób kadrowania ujęć." },
  { id: 'clips', label: "Klipy", title: "Długość i liczba klipów", description: "Wybierz zakresy długości lub odznacz wszystkie, aby pozwolić na dowolną długość." },
  { id: 'captions', label: "Napisy", title: "Napisy i tytuł", description: "Napisy wyświetlane słowo po słowie. Filmy bez mowy powstają bez napisów." },
  { id: 'review', label: "Podsumowanie", title: "Sprawdź i wygeneruj", description: "Sprawdź ustawienia i wygeneruj klipy. Kolejny film możesz od razu dodać do kolejki." }
]

export function parseTrimRange(enabled: boolean, startText: string, endText: string): {
  start: number | null
  end: number | null
  error: string | null
} {
  const start = enabled ? parseTimecode(startText) : null
  const end = enabled ? parseTimecode(endText) : null
  let error: string | null = null
  if (Number.isNaN(start) || Number.isNaN(end)) error = "Wpisz sekundy (90) lub czas (1:30)."
  else if (end != null && end <= (start ?? 0)) error = "Koniec musi być później niż początek."
  return { start, end, error }
}

/** The run request for the current draft. */
export function buildJobRequest(draft: ClipDraft, trim: { start: number | null; end: number | null }): ClipJobRequest {
  return {
    videoUrl: draft.source.trim(),
    maxClips: draft.autoClipCount ? null : draft.maxClips,
    autoClipCount: draft.autoClipCount,
    durationRanges: draft.durations.length > 0 ? draft.durations : null,
    aspectRatio: draft.aspectRatio,
    layoutStyle: draft.layoutStyle,
    layoutVision: draft.aspectRatio === '9:16' && draft.layoutStyle === 'auto' && draft.layoutVision,
    pacing: draft.pacing,
    retainSource: draft.retainSource ?? false,
    removeHesitations: draft.removeHesitations,
    backgroundMusic: draft.backgroundMusic ?? false,
    strongerHook: draft.strongerHook ?? false,
    includeCaptions: draft.includeCaptions,
    captionPreset: draft.captionPreset,
    titleOptions: draft.titleOptions,
    startTimeSeconds: trim.start,
    endTimeSeconds: trim.end,
    bannerPlatform: null,
    bannerChannelUrl: null
  }
}

interface JobFormProps {
  onSubmit: (config: ClipJobRequest) => void
  /** Opens a queued job on the Jobs page. */
  onViewJob?: (jobId: string) => void
  /** Why the job can't start yet (missing keys, tools); disables submit. */
  blockedReason?: ReactNode
  submitting?: boolean
  className?: string
}

type Update = (patch: Partial<ClipDraft>) => void

/**
 * The Create wizard: Video → Format → Clips → Captions → Review. Each step is
 * one compact panel with Back/Next pinned below it. After Generate the job is
 * queued and the wizard offers the next video, so several runs can go at once.
 */
export function JobForm({ onSubmit, onViewJob, blockedReason, submitting, className }: JobFormProps): React.JSX.Element {
  const draft = useDraftStore()
  const { update, step, setStep } = draft

  const trim = useMemo(
    () => parseTrimRange(draft.trimOpen, draft.trimStart, draft.trimEnd),
    [draft.trimOpen, draft.trimStart, draft.trimEnd]
  )

  const index = WIZARD_STEPS.findIndex((s) => s.id === step)
  const meta = WIZARD_STEPS[index]
  const hasSource = Boolean(draft.source)
  const stepValid = step === 'video' ? hasSource && !trim.error : true
  const canSubmit = hasSource && !blockedReason && !trim.error && !submitting && !draft.started

  const submit = (): void => {
    if (canSubmit) onSubmit(buildJobRequest(draft, trim))
  }

  // ⌘↵ / Ctrl+↵ generates from any step once a video is chosen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (draft.started) {
    return <StartedPanel className={className} onViewJob={onViewJob} />
  }

  const goTo = (target: WizardStep): void => {
    setStep(target)
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }
  const next = WIZARD_STEPS[index + 1]
  const back = WIZARD_STEPS[index - 1]

  return (
    <div className={cn('space-y-3', className)}>
      <Stepper current={step} reachable={hasSource ? WIZARD_STEPS.length - 1 : 0} onSelect={goTo} />

      <Panel className="p-4 xl:p-5">
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-ink">{meta.title}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{meta.description}</p>
        </div>
        {step === 'video' && <VideoStep draft={draft} update={update} trimError={trim.error} disabled={submitting} />}
        {step === 'format' && <FormatStep draft={draft} update={update} />}
        {step === 'clips' && <ClipsStep draft={draft} update={update} />}
        {step === 'captions' && <CaptionsStep draft={draft} update={update} />}
        {step === 'review' && <ReviewStep draft={draft} trim={trim} onEdit={goTo} />}
      </Panel>

      {/* Actions stay pinned to the bottom edge on a solid strip. */}
      <div className="sticky bottom-0 z-10 -mb-3 flex items-center gap-3 bg-canvas pb-3 pt-2">
        {back ? (
          <Button variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => goTo(back.id)}>
            Wstecz
          </Button>
        ) : <span />}
        <p className="min-w-0 flex-1 truncate text-center text-2xs text-ink-subtle">
          {blockedReason ?? (step === 'video' && !hasSource ? "Dodaj film, aby kontynuować." : `${MOD_KEY}↵ uruchamia generowanie z dowolnego kroku`)}
        </p>
        {next && step !== 'review' ? (
          <div className="flex items-center gap-2">
            {step !== 'video' && (
              <Button variant="ghost" onClick={submit} disabled={!canSubmit} loading={submitting} className="max-sm:hidden">
                Wygeneruj teraz
              </Button>
            )}
            <Button variant="primary" trailingIcon={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => goTo(next.id)} disabled={!stepValid}>
              Dalej: {next.label}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={submit} disabled={!canSubmit} loading={submitting}>
            Wygeneruj klipy
          </Button>
        )}
      </div>
    </div>
  )
}

function Stepper({ current, reachable, onSelect }: { current: WizardStep; reachable: number; onSelect: (step: WizardStep) => void }): React.JSX.Element {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === current)
  return (
    <nav aria-label="Kroki tworzenia klipów">
      <ol className="flex items-center gap-1.5">
        {WIZARD_STEPS.map((s, i) => {
          const active = i === currentIndex
          const done = i < currentIndex
          const enabled = i <= reachable
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none">
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                disabled={!enabled}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'group flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-xs transition-colors duration-200',
                  active ? 'bg-white/[0.08] font-medium text-ink' : enabled ? 'text-ink-muted hover:bg-white/[0.05] hover:text-ink' : 'text-ink-faint'
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-2xs tabular',
                    active ? 'bg-accent text-accent-ink' : done ? 'bg-ink text-canvas' : 'bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]'
                  )}
                >
                  {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn('truncate', !active && 'max-md:hidden')}>{s.label}</span>
              </button>
              {i < WIZARD_STEPS.length - 1 && (
                <span aria-hidden className={cn('h-px min-w-3 flex-1', done ? 'bg-ink/40' : 'bg-white/[0.08]')} />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function VideoStep({ draft, update, trimError, disabled }: { draft: ClipDraft; update: Update; trimError: string | null; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <SourcePicker value={draft.source} onChange={(source) => update({ source })} disabled={disabled} />
      <SettingRow
        title="Wybierz fragment filmu"
        description="Ustaw początek i koniec. Puste pole oznacza brak ograniczenia."
        control={<Switch label="Wybierz zakres źródła" checked={draft.trimOpen} onChange={(trimOpen) => update({ trimOpen })} />}
      />
      {draft.trimOpen && (
        <div className="animate-fade-in">
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              mono
              placeholder="Początek 0:00"
              value={draft.trimStart}
              onChange={(e) => update({ trimStart: e.target.value })}
              aria-label="Czas początku"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
            <TextInput
              mono
              placeholder="Koniec"
              value={draft.trimEnd}
              onChange={(e) => update({ trimEnd: e.target.value })}
              aria-label="Czas końca"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
          </div>
          <p id="trim-help" role={trimError ? 'alert' : undefined} className={cn('mt-1.5 text-2xs', trimError ? 'text-danger' : 'text-ink-subtle')}>
            {trimError ?? "Wpisz sekundy (90) lub mm:ss (1:30)."}
          </p>
        </div>
      )}
    </div>
  )
}

/** Format, framing and pacing. Exported for the keyboard-navigation test. */
export function FormatStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Group label="Format">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => {
            const selected = draft.aspectRatio === f.id
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onKeyDown={onRadioKeyDown}
                onClick={() => update({ aspectRatio: f.id })}
                className={cn('glass-tile glass-tile-hover flex items-center gap-3 rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}
              >
                <span className="flex h-6 w-7 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      'rounded-[4px] border-[1.5px] transition-colors duration-200',
                      selected ? 'border-accent-hover bg-accent/25' : 'border-ink-subtle bg-white/[0.04]'
                    )}
                    style={{ width: f.w, height: f.h }}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">
                    {f.label} <span className="font-mono text-2xs font-normal text-ink-subtle">{f.id}</span>
                  </span>
                  <span className="block truncate text-2xs text-ink-subtle">{f.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Group>

      {draft.aspectRatio === '9:16' && (
        <Group label="Kadrowanie">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Kadrowanie">
            {LAYOUT_STYLES.map((style) => {
              const selected = draft.layoutStyle === style.id
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={onRadioKeyDown}
                  onClick={() => update({ layoutStyle: style.id })}
                  className={cn(
                    'glass-tile glass-tile-hover flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left',
                    selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                  )}
                >
                  <FramingGlyph style={style.id} selected={selected} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{style.label}</span>
                    <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{style.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {draft.layoutStyle === 'auto' && (
            <SettingRow
              className="mt-2"
              title="Sprawdzaj trudne ujęcia za pomocą AI"
              description="Analizuje niejednoznaczne ujęcia. Może zwiększyć koszt OpenRouter."
              control={<Switch label="Analiza obrazu AI do kadrowania" checked={draft.layoutVision} onChange={(layoutVision) => update({ layoutVision })} />}
            />
          )}
        </Group>
      )}

      <Group label="Muzyka">
        <SettingRow title="Dodaj muzykę w tle"
          description="Losuje utwory z folderu muzyki. Cichy początek, łagodne narastanie i stała głośność podczas mowy. Utwór zmienisz później w bibliotece."
          control={<Switch label="Dodaj muzykę w tle" checked={draft.backgroundMusic ?? false} onChange={(backgroundMusic) => update({ backgroundMusic })} />} />
      </Group>
      <Group label="Późniejsze poprawki">
        <SettingRow
          title="Zachowaj źródło do poprawek"
          description="Pozwala zmienić początek i koniec gotowych klipów bez ponownej analizy AI. Zachowuje jedną kopię całego filmu na dysku dla tej serii."
          control={<Switch label="Zachowaj źródło do poprawek" checked={draft.retainSource ?? false} onChange={(retainSource) => update({ retainSource })} />}
        />
      </Group>
      <Group label="Początek klipu">
        <SettingRow
          title="Dobierz mocniejszy początek"
          description="Porównuje maksymalnie trzy początki i wybiera bardziej angażującą, samodzielną wypowiedź. Gdy brak lepszej propozycji, zachowuje obecny zakres. Dla krótkich klipów z mową; w ramach obecnej analizy AI, z nieco dłuższą odpowiedzią."
          control={<Switch label="Dobierz mocniejszy początek" checked={draft.strongerHook ?? false} onChange={(strongerHook) => update({ strongerHook })} />}
        />
      </Group>
      <Group label="Tempo">
        <SettingRow
          title="Wycinaj ciszę"
          description="Usuwa długie pauzy i wypełniacze, zachowuje demonstracje."
          control={
            <Switch label="Wycinaj ciszę i wypełniacze" checked={draft.pacing === 'tight'} onChange={(on) => update({ pacing: on ? 'tight' : 'natural' })} />
          }
        />
        <SettingRow
          className="mt-2"
          title="Usuń zawahania"
          description="Ukrywa rozpoznane „yy”, „yyy”, „eee”, „ym” w napisach. Wycina je także z dźwięku, gdy jest to bezpieczne dla sąsiednich słów. Bez dodatkowego kosztu AI. Wybór jest zapamiętywany po zamknięciu aplikacji."
          control={<Switch label="Usuń zawahania" checked={draft.removeHesitations ?? false} onChange={(removeHesitations) => update({ removeHesitations })} />}
        />
      </Group>
    </div>
  )
}

function ClipsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const toggleDuration = (id: string): void => {
    update({ durations: draft.durations.includes(id) ? draft.durations.filter((d) => d !== id) : [...draft.durations, id] })
  }
  return (
    <div className="space-y-4">
      <Group label="Długość klipów" aside={draft.durations.length === 0 ? "Dowolna długość" : `${draft.durations.length} wybrano`}>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="group" aria-label="Zakresy długości klipów">
          {DURATIONS.map((d) => {
            const selected = draft.durations.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleDuration(d.id)}
                className={cn(
                  'glass-tile glass-tile-hover rounded-xl px-1 py-1.5 text-center',
                  selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                )}
              >
                <span className="block font-mono text-xs tabular">{d.range}</span>
                <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{d.label}</span>
              </button>
            )
          })}
        </div>
      </Group>

      <Group label="Liczba klipów">
        <SettingRow
          title="Pozwól zdecydować AI"
          description="Wszystkie fragmenty warte publikacji."
          control={<Switch label="Pozwól AI wybrać liczbę klipów" checked={draft.autoClipCount} onChange={(autoClipCount) => update({ autoClipCount })} />}
        />
        {!draft.autoClipCount && (
          <div className="mt-2 flex max-w-xs items-center gap-2 animate-fade-in">
            <Button
              iconOnly
              aria-label="Mniej klipów"
              onClick={() => update({ maxClips: Math.max(1, draft.maxClips - 1) })}
              disabled={draft.maxClips <= 1}
              icon={<Minus className="h-3.5 w-3.5" />}
            />
            <TextInput
              className="flex-1 rounded-full [&_input]:text-center"
              inputMode="numeric"
              value={String(draft.maxClips)}
              onChange={(e) => {
                const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
                update({ maxClips: Number.isFinite(n) ? Math.min(MAX_CLIPS, Math.max(1, n)) : 1 })
              }}
              aria-label="Maksymalna liczba klipów"
              mono
            />
            <Button
              iconOnly
              aria-label="Więcej klipów"
              onClick={() => update({ maxClips: Math.min(MAX_CLIPS, draft.maxClips + 1) })}
              disabled={draft.maxClips >= MAX_CLIPS}
              icon={<Plus className="h-3.5 w-3.5" />}
            />
          </div>
        )}
      </Group>
    </div>
  )
}

function CaptionsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <SettingRow
        title="Dodaj napisy do filmu"
        description="Napisy dialogowe. Styl tytułu wybierzesz poniżej."
        control={<Switch label="Napisy" checked={draft.includeCaptions} onChange={(includeCaptions) => update({ includeCaptions })} />}
      />
      <div
        className={cn('transition-[opacity,filter] duration-300 ease-out', !draft.includeCaptions && 'pointer-events-none opacity-35 saturate-50')}
        aria-disabled={!draft.includeCaptions}
      >
        <CaptionPresetPicker
          value={draft.captionPreset}
          onChange={(captionPreset) => update({ captionPreset })}
          disabled={!draft.includeCaptions}
        />
      </div>
      <TitlePresetPicker creation value={draft.titleOptions} onChange={(titleOptions) => update({ titleOptions })} />
      <p className="text-xs text-ink-muted">Zapiszemy również wersję bez tytułu do późniejszej edycji. Zajmie dodatkowe miejsce na dysku.</p>
    </div>
  )
}

function ReviewStep({ draft, trim, onEdit }: {
  draft: ClipDraft
  trim: { start: number | null; end: number | null }
  onEdit: (step: WizardStep) => void
}): React.JSX.Element {
  const active = useActiveJobs()
  const runningCount = active.filter((job) => job.status !== 'queued').length
  const lengths = draft.durations.length === 0
    ? "Dowolna długość"
    : DURATIONS.filter((d) => draft.durations.includes(d.id)).map((d) => d.range).join(', ')
  const framing = draft.aspectRatio === '9:16'
    ? `${LAYOUT_STYLES.find((s) => s.id === draft.layoutStyle)?.label ?? "Inteligentny"} — kadrowanie${draft.layoutStyle === 'auto' && draft.layoutVision ? " · analiza obrazu AI" : ''}`
    : "Cały kadr"
  const trimLabel = draft.trimOpen && (trim.start != null || trim.end != null)
    ? ` · ${trim.start != null ? formatSeconds(trim.start) : 'początek'} – ${trim.end != null ? formatSeconds(trim.end) : 'koniec'}`
    : ''

  const rows: { step: WizardStep; label: string; value: string }[] = [
    { step: 'video', label: "Film", value: `${sourceLabel(draft.source)}${trimLabel}` },
    { step: 'format', label: 'Format', value: `${FORMATS.find((f) => f.id === draft.aspectRatio)?.label ?? draft.aspectRatio} ${draft.aspectRatio} · ${framing}` },
    { step: 'format', label: "Tempo", value: draft.pacing === 'tight' ? "Wycinaj ciszę" : "Oryginalne tempo" },
    { step: 'format', label: 'Późniejsze poprawki', value: draft.retainSource ? 'Zachowaj źródło' : 'Bez zachowania źródła' },
    { step: 'format', label: 'Zawahania', value: draft.removeHesitations ? 'Usuwaj rozpoznane yyy/eee' : 'Bez dodatkowego usuwania' },
    { step: 'format', label: 'Muzyka', value: draft.backgroundMusic ? 'Losowa · subtelna' : 'Wyłączona' },
    { step: 'format', label: 'Mocniejszy początek', value: draft.strongerHook ? 'Automatyczny dobór (krótkie klipy z mową)' : 'Wyłączony' },
    { step: 'clips', label: "Klipy", value: `${lengths} · ${draft.autoClipCount ? "Liczbę wybiera AI" : `Maksymalnie ${draft.maxClips}`}` },
    { step: 'captions', label: 'Tytuł', value: draft.titleOptions.enabled ? `${draft.titleOptions.mode === 'all' ? 'Cały klip' : draft.titleOptions.mode === 'intro' ? `Pierwsze ${draft.titleOptions.end} s` : `${draft.titleOptions.start}–${draft.titleOptions.end} s`} · ${TITLE_PRESETS.find(p => p.id === selectedTitlePreset(draft.titleOptions))?.name ?? 'Własny'}` : 'Wyłączony' },
    { step: 'captions', label: "Napisy", value: draft.includeCaptions ? CAPTION_PRESET_NAMES[draft.captionPreset] ?? draft.captionPreset : "Wyłączone" }
  ]

  return (
    <div className="space-y-3">
      <dl className="glass-well divide-y divide-white/[0.05] overflow-hidden rounded-xl">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-3 py-2">
            <dt className="w-20 shrink-0 text-xs text-ink-subtle">{row.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-sm text-ink" title={row.value}>{row.value}</dd>
            <Button size="sm" variant="ghost" onClick={() => onEdit(row.step)} aria-label={`Edytuj ${row.label.toLowerCase()}`}>
              Edytuj
            </Button>
          </div>
        ))}
      </dl>
      <p className="flex items-start gap-2 text-2xs text-ink-subtle">
        <Clock3 className="mt-px h-3.5 w-3.5 shrink-0" />
        {runningCount >= MAX_PARALLEL_JOBS
          ? `${runningCount} zadań w toku. To zadanie poczeka w kolejce i uruchomi się automatycznie.`
          : active.length > 0
            ? `Działa równolegle. Pozostałe zadania: ${active.length}. Maksymalnie ${MAX_PARALLEL_JOBS} zadania działają jednocześnie.`
            : "Działa na tym komputerze. Transkrypcja i planowanie klipów obciążają konto OpenRouter."}
      </p>
    </div>
  )
}

function StartedPanel({ className, onViewJob }: { className?: string; onViewJob?: (jobId: string) => void }): React.JSX.Element | null {
  const started = useDraftStore((s) => s.started)
  const startAnother = useDraftStore((s) => s.startAnother)
  if (!started) return null
  return (
    <Panel className={cn('flex flex-col items-center px-5 py-8 text-center animate-fade-in', className)}>
      <IconTile tone="success" size="lg">
        <CheckCircle2 />
      </IconTile>
      <h2 className="mt-3 text-base font-semibold text-ink">{started.queued ? "W kolejce" : "Rozpoczęto tworzenie klipów"}</h2>
      <p className="mt-1 max-w-md truncate text-sm text-ink-muted" title={started.source}>{sourceLabel(started.source)}</p>
      <p className="mt-1 max-w-md text-xs text-ink-subtle">
        {started.queued
          ? `Maksymalnie ${MAX_PARALLEL_JOBS} zadań działa jednocześnie. To ruszy, gdy zwolni się miejsce.`
          : "Zadanie działa w tle. Możesz dodać kolejne filmy lub korzystać z innych funkcji."}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={startAnother}>
          Dodaj kolejny film
        </Button>
        {onViewJob && (
          <Button icon={<ListVideo className="h-3.5 w-3.5" />} onClick={() => onViewJob(started.jobId)}>
            Pokaż zadanie
          </Button>
        )}
      </div>
    </Panel>
  )
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Tiny 9:16 diagram of a framing style: split panels, full bleed, or letterbox. */
function FramingGlyph({ style, selected }: { style: 'auto' | 'fill' | 'fit'; selected: boolean }): React.JSX.Element {
  const fill = selected ? 'bg-accent-hover/80' : 'bg-ink-subtle/60'
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[24px] w-[14px] shrink-0 flex-col gap-px overflow-hidden rounded-[4px] border-[1.5px] p-px transition-colors duration-200',
        selected ? 'border-accent-hover' : 'border-ink-subtle'
      )}
    >
      {style === 'auto' && (
        <>
          <span className={cn('flex-1 rounded-[1px]', fill)} />
          <span className={cn('flex-1 rounded-[1px] opacity-60', fill)} />
        </>
      )}
      {style === 'fill' && <span className={cn('flex-1 rounded-[1px]', fill)} />}
      {style === 'fit' && <span className={cn('my-auto h-[6px] rounded-[1px]', fill)} />}
    </span>
  )
}

function Group({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {aside && <span className="text-2xs text-ink-subtle">{aside}</span>}
      </div>
      {children}
    </div>
  )
}
