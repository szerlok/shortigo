import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, BookA, Check, ChevronDown, Cpu, FolderOpen, Github, Info, KeyRound, Loader2, RefreshCw, ScrollText } from 'lucide-react'
import { useSettingsStore } from '../store/use-settings-store'
import { useApiKeyDrafts } from '../hooks/use-api-key-drafts'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import { APP_NAME, APP_VERSION, BRIDGEMIND_URL, ISSUES_URL, LICENSE_NAME, PROVIDER_LINKS, REPO_URL } from '../config/brand'
import type { ClipSettings, ToolStatus } from '../../preload/index'
import { ApiKeyInput } from '../components/ApiKeyInput'
import { ShortigoLogo } from '../components/brand/ShortigoLogo'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { Button } from '../components/ui/Button'
import { Field, TextArea, TextInput } from '../components/ui/Field'
import { Badge, StatusDot } from '../components/ui/Badge'
import { IconTile } from '../components/ui/IconTile'
import { Callout } from '../components/ui/Callout'

type SectionId = 'keys' | 'vocabulary' | 'output' | 'system' | 'about'
type SectionTone = 'success' | 'warning' | 'danger' | 'idle'

export function SettingsPage(): React.JSX.Element {
  const { outputDirectory, pythonPath, customVocabulary, openrouterConfigured, zernioConfigured, saving, save, toolStatus, toolError, checkTools, checkingTools } =
    useSettingsStore()
  const keys = useApiKeyDrafts()
  const [isPackaged, setIsPackaged] = useState(true)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    getApi().system.isPackaged().then(setIsPackaged).catch(() => {})
  }, [])

  const commit = async (patch: Partial<ClipSettings>, recheck = false): Promise<void> => {
    try {
      await save(patch)
      setSaveError(null)
      setSavedAt(Date.now())
      if (recheck) checkTools()
    } catch (err) {
      setSaveError(errorMessage(err, "Nie udało się zapisać ustawień"))
    }
  }

  const lastSaved = Math.max(savedAt ?? 0, keys.savedAt ?? 0)
  const error = saveError ?? keys.error
  const tools = toolRows(toolStatus)
  const toolsChecked = tools.every((row) => row.ok != null)
  const toolsMissing = tools.filter((row) => !row.optional && row.ok === false).length
  const keysMissing = Number(!openrouterConfigured)
  const vocabularyTerms = customVocabulary.split('\n').filter((line) => line.trim()).length

  const sections: { id: SectionId; label: string; icon: ReactNode; tone: SectionTone }[] = [
    { id: 'keys', label: "Klucze API", icon: <KeyRound />, tone: keysMissing ? 'warning' : 'success' },
    { id: 'vocabulary', label: "Słownictwo", icon: <BookA />, tone: 'idle' },
    { id: 'output', label: "Pliki wynikowe", icon: <FolderOpen />, tone: 'idle' },
    { id: 'system', label: "Sprawdzenie systemu", icon: <Cpu />, tone: !toolsChecked ? 'idle' : toolsMissing ? 'danger' : 'success' },
    { id: 'about', label: "O aplikacji", icon: <Info />, tone: 'idle' }
  ]
  const active = useActiveSection(sections.map((section) => section.id))
  const jump = (id: SectionId): void => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const checks: { label: string; ok: boolean | null; detail: string; section: SectionId; optional?: boolean; tone?: 'danger' }[] = [
    { label: 'OpenRouter', ok: openrouterConfigured, detail: openrouterConfigured ? "Klucz zapisany" : "Wymagany do transkrypcji i wyboru klipów", section: 'keys' },
    { label: "Narzędzia", ok: toolsChecked ? toolsMissing === 0 : null, detail: !toolsChecked ? (checkingTools ? 'Checking…' : "Nie sprawdzono") : toolsMissing ? `${toolsMissing} brakuje` : "Wszystkie zainstalowane", section: 'system', tone: 'danger' },
    { label: 'Zernio', ok: zernioConfigured, detail: zernioConfigured ? "Publikowanie włączone" : "Opcjonalne, do publikacji", section: 'keys', optional: true }
  ]
  const blocking = checks.filter((check) => !check.optional && check.ok === false).length

  return (
    <Page width="default" className="max-w-[1080px]">
      <PageHeader
        eyebrow="Preferencje"
        title="Ustawienia"
        description="Zmiany zapisują się automatycznie."
        actions={<SaveIndicator saving={saving} savedAt={lastSaved || null} error={error} />}
      />

      <div className="mt-5 grid items-start gap-4 lg:grid-cols-[184px_minmax(0,1fr)]">
        <nav aria-label="Sekcje ustawień" className="hidden space-y-0.5 lg:sticky lg:top-12 lg:block">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => jump(section.id)}
              aria-current={active === section.id ? 'true' : undefined}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-left text-sm transition-colors duration-150 [&_svg]:h-3.5 [&_svg]:w-3.5',
                active === section.id ? 'bg-white/[0.09] text-ink' : 'text-ink-muted hover:bg-white/[0.05] hover:text-ink'
              )}
            >
              {section.icon}
              <span className="flex-1">{section.label}</span>
              {section.tone !== 'idle' && <StatusDot tone={section.tone} />}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          <Panel>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <IconTile tone={blocking ? 'warning' : 'success'} size="lg">{blocking ? <KeyRound /> : <Check strokeWidth={3} />}</IconTile>
                <div>
                  <h2 className="text-sm font-semibold text-ink">{blocking ? `Do skonfigurowania przed tworzeniem klipów: ${blocking}` : "Gotowe do tworzenia klipów"}</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">{APP_NAME} działa na tym komputerze. Jeden klucz OpenRouter obsługuje transkrypcję i wybór klipów.</p>
                </div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {checks.map((check) => (
                <button
                  key={check.label}
                  type="button"
                  onClick={() => jump(check.section)}
                  className="glass-tile glass-tile-hover flex items-start gap-2.5 rounded-xl px-3 py-2 text-left"
                >
                  <StatusDot className="mt-1.5" tone={check.ok == null || check.optional && !check.ok ? 'idle' : check.ok ? 'success' : check.tone ?? 'warning'} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{check.label}</span>
                    <span className={cn('block truncate text-2xs', check.ok === false && !check.optional ? (check.tone === 'danger' ? 'text-danger' : 'text-warning') : 'text-ink-subtle')}>{check.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Section id="keys">
            <PanelHeader
              icon={<IconTile tone="accent"><KeyRound /></IconTile>}
              title="Klucze API"
              description="Szyfrowanie w systemowym pęku kluczy. Shortigo nie wymaga własnego konta ani serwera."
            />
            <div className="mt-4 space-y-2">
              <KeyRow>
                <ApiKeyInput
                  label="OpenRouter"
                  value={keys.drafts.openrouterApiKey}
                  configured={openrouterConfigured}
                  onChange={(v) => keys.setDraft('openrouterApiKey', v)}
                  onRemove={() => void keys.remove('openrouterApiKey')}
                  onBlur={() => void keys.persist()}
                  placeholder="sk-or-…"
                  description="Tworzy transkrypcję przez MAI Transcribe 2 i wybiera fragmenty na klipy."
                  getKeyUrl={PROVIDER_LINKS.openrouter}
                />
              </KeyRow>
              <p className="eyebrow px-1 pt-2">Opcjonalne</p>
              <KeyRow>
                <ApiKeyInput
                  label="Zernio (opcjonalne)"
                  value={keys.drafts.zernioApiKey}
                  configured={zernioConfigured}
                  onChange={(v) => keys.setDraft('zernioApiKey', v)}
                  onRemove={() => void keys.remove('zernioApiKey')}
                  onBlur={() => void keys.persist()}
                  placeholder="sk_…"
                  description="Łączy konta społecznościowe, aby publikować i planować klipy. Zarządzaj nimi w sekcji Konta."
                  getKeyUrl={PROVIDER_LINKS.zernio}
                />
              </KeyRow>
            </div>
          </Section>

          <Section id="vocabulary">
            <PanelHeader
              icon={<IconTile><BookA /></IconTile>}
              title="Własne słownictwo"
              description="Nazwy, produkty i specjalistyczne słowa, po jednym w wierszu. Używane w transkrypcji, napisach i opisach publikacji."
              action={vocabularyTerms > 0 && <Badge className="font-mono tabular">Hasła: {vocabularyTerms}</Badge>}
            />
            <VocabularyField value={customVocabulary} onCommit={(value) => commit({ customVocabulary: value })} />
          </Section>

          <Section id="output">
            <PanelHeader
              icon={<IconTile><FolderOpen /></IconTile>}
              title="Pliki wynikowe"
              description="Każde zadanie ma własny folder z klipami, transkrypcją i planem."
            />
            <OutputFolder value={outputDirectory} onCommit={(dir) => commit({ outputDirectory: dir })} />
          </Section>

          <Section id="system">
            <PanelHeader
              icon={<IconTile tone={toolsChecked && toolsMissing ? 'danger' : 'neutral'}><Cpu /></IconTile>}
              title="Sprawdzenie systemu"
              description="Narzędzia potrzebne do pobierania, transkrypcji i montażu filmów."
              action={
                <Button
                  size="sm"
                  onClick={checkTools}
                  disabled={checkingTools}
                  icon={<RefreshCw className={cn('h-3.5 w-3.5', checkingTools && 'animate-spin')} />}
                >
                  Sprawdź ponownie
                </Button>
              }
            />
            <ToolList rows={tools} checking={checkingTools} />
            {toolError && <Callout tone="danger" className="mt-3">{toolError}</Callout>}
            {!isPackaged && (
              <div className="mt-4 grid gap-4 border-t border-white/[0.06] pt-4">
                <DevPathField
                  label="Ścieżka do Pythona"
                  value={pythonPath}
                  placeholder="python3"
                  onCommit={(v) => commit({ pythonPath: v }, true)}
                />
              </div>
            )}
          </Section>

          <Section id="about" className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-4">
              <ShortigoLogo variant="icon" className="-m-1 h-12" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">{APP_NAME}</h2>
                  <Badge className="font-mono tabular">v{APP_VERSION}</Badge>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  Udostępniono na licencji {LICENSE_NAME} . Twórcy:{' '}
                  <button
                    onClick={() => getApi().shell.openPath(BRIDGEMIND_URL)}
                    className="text-ink underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-ink"
                  >
                    BridgeMind
                  </button>
                  .
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" icon={<Github className="h-3.5 w-3.5" />} onClick={() => getApi().shell.openPath(REPO_URL)}>
                  GitHub
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />}
                  onClick={() => getApi().shell.openPath(ISSUES_URL)}
                >
                  Zgłoś problem
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ScrollText className="h-3.5 w-3.5" />}
                  onClick={() => getApi().diagnostics.openLogFolder()}
                >
                  Pokaż dziennik
                </Button>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </Page>
  )
}

function Section({ id, className, children }: { id: SectionId; className?: string; children: ReactNode }): React.JSX.Element {
  return (
    <section id={`settings-${id}`} className="scroll-mt-14">
      <Panel className={className}>{children}</Panel>
    </section>
  )
}

/** The section nearest the top of the scroll area, for the side nav. */
function useActiveSection(ids: SectionId[]): SectionId {
  const [active, setActive] = useState<SectionId>(ids[0])
  const key = ids.join(',')
  useEffect(() => {
    const root = document.getElementById('page-scroll')
    if (!root) return
    const update = (): void => {
      const top = root.getBoundingClientRect().top + 72
      let current = ids[0]
      for (const id of ids) {
        const el = document.getElementById(`settings-${id}`)
        if (el && el.getBoundingClientRect().top <= top) current = id
      }
      // At the bottom, the last short section can't reach the top: select it anyway.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = ids[ids.length - 1]
      setActive(current)
    }
    update()
    root.addEventListener('scroll', update, { passive: true })
    return () => root.removeEventListener('scroll', update)
  }, [key])
  return active
}

function KeyRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="glass-tile rounded-2xl px-3 py-2.5">{children}</div>
}

function SaveIndicator({ saving, savedAt, error }: { saving: boolean; savedAt: number | null; error: string | null }): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!savedAt) return
    setVisible(true)
    const t = setTimeout(() => setVisible(false), 2200)
    return () => clearTimeout(t)
  }, [savedAt])

  if (error) return <Badge tone="danger">{error}</Badge>
  if (saving) {
    return (
      <Badge icon={<Loader2 className="h-3 w-3 animate-spin" />}>
        Zapisywanie…
      </Badge>
    )
  }
  return (
    <span
      className={cn('transition-opacity duration-300', visible ? 'opacity-100' : 'opacity-0')}
      aria-live="polite"
    >
      <Badge tone="success" icon={<Check className="h-3 w-3" strokeWidth={3} />}>
        Zapisano
      </Badge>
    </span>
  )
}

function OutputFolder({ value, onCommit }: { value: string; onCommit: (dir: string) => void }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)

  const choose = async (): Promise<void> => {
    try {
      const dir = await getApi().settings.selectOutputDir()
      if (dir) {
        setError(null)
        onCommit(dir)
      }
    } catch (err) {
      setError(errorMessage(err, "Nie udało się wybrać folderu wynikowego"))
    }
  }

  const open = async (): Promise<void> => {
    try {
      if (!(await getApi().shell.openPath(value))) setError("Nie udało się otworzyć folderu wynikowego")
      else setError(null)
    } catch (err) {
      setError(errorMessage(err, "Nie udało się otworzyć folderu wynikowego"))
    }
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <TextInput
          className="flex-1"
          mono
          value={value}
          readOnly
          title="Kliknij Zmień, aby wybrać folder"
          leading={<FolderOpen className="h-3.5 w-3.5" />}
          aria-label="Folder wynikowy"
        />
        <Button onClick={() => void choose()}>Zmień…</Button>
        <Button variant="ghost" onClick={() => void open()} disabled={!value}>
          Otwórz
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}

function VocabularyField({ value, onCommit }: { value: string; onCommit: (value: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="mt-4">
      <TextArea
        rows={4}
        value={draft}
        placeholder={'GPT 6 Sol\nOpus 5.5\nBridgeMind'}
        aria-label="Własne słownictwo"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
      />
      <p className="mt-2 px-1 text-xs text-ink-subtle">Do pięciu słów w jednej pozycji. Dotyczy nowych transkrypcji; opisy publikacji korzystają z tego od razu.</p>
    </div>
  )
}

function DevPathField({
  label,
  value,
  placeholder,
  onCommit
}: {
  label: string
  value: string
  placeholder: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Field label={label} hint="Tylko wersje deweloperskie">
      <TextInput
        mono
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== value && onCommit(draft.trim())}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </Field>
  )
}

interface ToolRow { name: string; ok: boolean | null; detail?: ReactNode; optional?: boolean }

function toolRows(status: ToolStatus | null): ToolRow[] {
  return [
    { name: 'Python', ok: status?.python ?? null, detail: status?.pythonPath },
    {
      name: "Biblioteki przetwarzania i inteligentne kadrowanie",
      ok: status?.pythonDeps ?? null,
      detail: status && !status.pythonDeps ? status.pythonError : "Obejmuje OpenCV i model inteligentnego kadrowania"
    },
    { name: 'FFmpeg', ok: status?.ffmpeg ?? null },
    {
      name: "Napisy FFmpeg",
      ok: status?.ffmpegCaptions ?? null,
      detail: "Wymagane dla napisów. FFmpeg musi zawierać filtr ass",
      optional: true
    },
    { name: 'FFprobe', ok: status?.ffprobe ?? null },
    { name: 'yt-dlp', ok: status?.ytdlp ?? null, detail: "Pobiera filmy z YouTube" },
    { name: "Silnik przetwarzania Shortigo", ok: status?.engine ?? null, detail: status?.enginePath },
    { name: "Moduł komunikacji", ok: status?.bridgeRunner ?? null, detail: status?.bridgePath }
  ]
}

function ToolList({ rows, checking }: { rows: ToolRow[]; checking: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const required = rows.filter((row) => !row.optional)
  const missing = required.filter((row) => row.ok === false).length
  const checked = rows.every((row) => row.ok != null)

  return (
    <div className="mt-4">
      {checked && (
        <div className="mb-3 flex items-center gap-2 px-1 text-xs">
          <StatusDot tone={missing > 0 ? 'danger' : 'success'} />
          <span className={cn('flex-1', missing > 0 ? 'text-danger' : 'text-ink-muted')}>
            {missing > 0 ? `Brakujące wymagane narzędzia: ${missing}` : `Wszystkie wymagane narzędzia są zainstalowane (${rows.filter((row) => row.ok).length})`}
          </span>
          {missing === 0 && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded}
              trailingIcon={<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Ukryj szczegóły" : "Pokaż szczegóły"}
            </Button>
          )}
        </div>
      )}
      {(!checked || missing > 0 || expanded) && <div className="glass-well divide-y divide-white/[0.05] overflow-hidden rounded-2xl animate-fade-in">
        {rows.map((row) => {
          const tone = row.ok == null ? 'idle' : row.ok ? 'success' : row.optional ? 'warning' : 'danger'
          return (
            <div key={row.name} className="flex items-center gap-3 px-3 py-2">
              <StatusDot tone={tone} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{row.name}</p>
                {row.detail && (
                  <p className="mt-0.5 break-words font-mono text-2xs text-ink-subtle" data-selectable>
                    {row.detail}
                  </p>
                )}
              </div>
              {row.ok == null ? (
                <span className="shrink-0 text-xs text-ink-faint">{checking ? 'Checking…' : "Nie sprawdzono"}</span>
              ) : (
                <Badge tone={row.ok ? 'neutral' : row.optional ? 'warning' : 'danger'} className="shrink-0">
                  {row.ok ? "Znaleziono" : row.optional ? "Niedostępne" : "Brak"}
                </Badge>
              )}
            </div>
          )
        })}
      </div>}
    </div>
  )
}
