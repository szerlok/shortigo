import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Clock3, FileVideo2, Globe2, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2, Workflow, X } from 'lucide-react'
import { AUTOMATION_PLATFORMS, type Automation, type AutomationContent, type AutomationContentStatus, type AutomationUpdate } from '../../shared/automations'
import { isPostableAccount, isValidProfileName } from '../../shared/zernio'
import { PlatformIcon, platformName } from '../components/PlatformIcon'
import { Badge, StatusDot } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { Dialog, DialogFooter } from '../components/ui/Dialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Field, Select, TextArea, TextInput } from '../components/ui/Field'
import { IconTile } from '../components/ui/IconTile'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { Segmented } from '../components/ui/Segmented'
import { SettingRow } from '../components/ui/SettingRow'
import { Skeleton } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { useAccountsStore } from '../store/use-accounts-store'
import { useSettingsStore } from '../store/use-settings-store'
import { usePostsStore } from '../store/use-posts-store'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatRelativeDate } from '../lib/utils'
import type { Page as PageName } from '../components/Sidebar'

function draftFor(automation: Automation): AutomationUpdate {
  return { name: automation.name, enabled: automation.enabled, profileId: automation.profileId, metadataMode: automation.metadataMode, accounts: automation.accounts, times: automation.times, timezone: automation.timezone, youtubeVisibility: automation.youtubeVisibility, youtubeMadeForKids: automation.youtubeMadeForKids }
}

const SELECTED_STORAGE_KEY = 'bridgeclip.automations.selectedId'

function rememberSelection(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(SELECTED_STORAGE_KEY, id)
    else sessionStorage.removeItem(SELECTED_STORAGE_KEY)
  } catch { /* Optional convenience only. */ }
}

/** What the backend requires before an automation can be switched on. */
function missingSetup(value: Pick<AutomationUpdate, 'profileId' | 'accounts' | 'times'>): boolean {
  return !value.profileId || value.accounts.length === 0 || value.times.length === 0
}

function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** The next daily slot in the automation's own time zone. */
function nextRunLabel(times: readonly string[], timezone: string): string | null {
  if (times.length === 0) return null
  let current: string
  try {
    current = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now())
  } catch { return null }
  const sorted = [...times].sort()
  const next = sorted.find((time) => time > current)
  return next ? `Dzisiaj ${formatTime(next)}` : `Jutro ${formatTime(sorted[0])}`
}

function timeZones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  return supported.includes(current) ? supported : [current, ...supported]
}

const CONTENT_STATUS: Record<AutomationContentStatus, { label: string; tone: 'idle' | 'accent' | 'success' | 'warning' }> = {
  queued: { label: "W kolejce", tone: 'idle' },
  posting: { label: "Publikowanie", tone: 'accent' },
  posted: { label: "Wysłano", tone: 'success' },
  needs_review: { label: "Do sprawdzenia", tone: 'warning' }
}

type ContentFilter = 'all' | 'queued' | 'posted' | 'needs_review'

interface ConfirmRequest {
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => void
}

export function AutomationsPage({ onNavigate }: { onNavigate: (page: PageName) => void }): React.JSX.Element {
  const configured = useSettingsStore((state) => state.zernioConfigured)
  const writingConfigured = useSettingsStore((state) => state.openrouterConfigured)
  const { accounts, profiles, hydrate, load: loadAccounts, loading: accountsLoading, setProfile, createProfile } = useAccountsStore()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SELECTED_STORAGE_KEY) } catch { return null }
  })
  const initialSelectionDone = useRef(false)
  const [draft, setDraft] = useState<AutomationUpdate | null>(null)
  const [creating, setCreating] = useState(false)
  const [newProfileOpen, setNewProfileOpen] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [newTime, setNewTime] = useState('09:00')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; title: string; caption: string } | null>(null)
  const [filter, setFilter] = useState<ContentFilter>('all')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const selected = automations.find((automation) => automation.id === selectedId) ?? null
  const aiKeysMissing = !writingConfigured

  useEffect(() => {
    if (!configured) return
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const result = await getApi().automations.list()
        if (active) {
          setAutomations(result); setLoaded(true)
          if (!initialSelectionDone.current) {
            initialSelectionDone.current = true
            const initial = result.find((item) => item.id === selectedId) ?? result[0]
            setSelectedId(initial?.id ?? null)
            setDraft(initial ? draftFor(initial) : null)
            rememberSelection(initial?.id ?? null)
          }
        }
      } catch (cause) {
        if (active) { setError(errorMessage(cause, "Nie udało się wczytać automatyzacji.")); setLoaded(true) }
      }
    }
    void refresh()
    void hydrate().then(() => loadAccounts()).catch(() => {})
    const timer = setInterval(() => void refresh(), 5_000)
    return () => { active = false; clearInterval(timer) }
  }, [configured, hydrate, loadAccounts])

  const connected = useMemo(() => accounts.filter((account) => account.profileId === draft?.profileId &&
    AUTOMATION_PLATFORMS.some((platform) => platform === account.platform)
  ), [accounts, draft?.profileId])

  const dirty = Boolean(selected && draft && JSON.stringify(draft) !== JSON.stringify(draftFor(selected)))

  const select = (automation: Automation | null): void => {
    setSelectedId(automation?.id ?? null)
    rememberSelection(automation?.id ?? null)
    setDraft(automation ? draftFor(automation) : null)
    setEditing(null); setFilter('all'); setNewProfileOpen(false)
  }

  const mutate = async (action: string, request: () => Promise<Automation[]>, success?: string): Promise<Automation[] | null> => {
    setBusy(action); setError(null); setNotice(null)
    try {
      const result = await request()
      setAutomations(result)
      if (success) setNotice(success)
      return result
    } catch (cause) {
      setError(errorMessage(cause, "Nie udało się zaktualizować automatyzacji."))
      return null
    } finally { setBusy(null) }
  }

  const create = async (name: string): Promise<boolean> => {
    const result = await mutate('create', () => getApi().automations.create(name))
    if (!result) return false
    select(result[0]); setCreating(false)
    return true
  }

  const save = async (): Promise<void> => {
    if (!selected || !draft) return
    const result = await mutate('save', () => getApi().automations.update(selected.id, draft), "Zapisano zmiany.")
    const updated = result?.find((automation) => automation.id === selected.id)
    if (updated) setDraft(draftFor(updated))
  }

  /** Saves only the on/off state, so other unsaved edits stay in the draft. */
  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (!selected) return
    const result = await mutate('toggle', () => getApi().automations.update(selected.id, { ...draftFor(selected), enabled }), enabled ? `${selected.name} jest włączona.` : `${selected.name} jest wstrzymana.`)
    if (result) setDraft((current) => current && { ...current, enabled })
  }

  const runNow = async (): Promise<void> => {
    if (!selected) return
    const nextClip = selected.content.find((item) => item.status === 'queued')
    if (!nextClip) return
    const result = await mutate('run', () => getApi().automations.run(selected.id))
    const updated = result?.find((automation) => automation.id === selected.id)
    if (!updated) return
    if (updated.lastError) setError(updated.lastError)
    else if (updated.content.find((item) => item.id === nextClip.id)?.status === 'queued') setError("Ta automatyzacja już działa. Spróbuj po jej zakończeniu.")
    else setNotice("Zadanie zakończone. Sprawdź wynik w banku treści.")
  }

  const remove = (): void => {
    if (!selected) return
    setConfirm({
      title: `Usuń ${selected.name}?`,
      body: "Harmonogram i wszystkie klipy w banku treści zostaną usunięte. Wysłane publikacje pozostaną na kontach.",
      confirmLabel: "Usuń automatyzację",
      onConfirm: async () => {
        const result = await mutate('delete', () => getApi().automations.delete(selected.id))
        if (result) select(result[0] ?? null)
      }
    })
  }

  const addProfile = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selected || !draft || !isValidProfileName(newProfileName)) return
    setBusy('profile'); setError(null); setNotice(null)
    try {
      const profile = await createProfile(newProfileName)
      const updatedDraft = { ...draft, profileId: profile.id, accounts: [], enabled: false }
      const result = await getApi().automations.update(selected.id, updatedDraft)
      setAutomations(result)
      setDraft(updatedDraft)
      setNewProfileName(''); setNewProfileOpen(false)
      setNotice(`Profil „${profile.name}” został utworzony. Połącz z nim konta, a potem wybierz je tutaj.`)
    } catch (cause) {
      setError(errorMessage(cause, "Nie udało się utworzyć profilu Zernio."))
    } finally { setBusy(null) }
  }

  const connectAccount = async (): Promise<void> => {
    if (!selected || !draft?.profileId) return
    const result = await mutate('save', () => getApi().automations.update(selected.id, draft))
    if (!result) return
    setProfile(draft.profileId)
    onNavigate('accounts')
  }

  const saveContent = async (item: AutomationContent, returnToQueue = false): Promise<void> => {
    if (!selected || !editing || editing.id !== item.id) return
    const result = await mutate('content', () => getApi().automations.updateContent(selected.id, item.id, {
      title: editing.title, caption: editing.caption, returnToQueue
    }), returnToQueue ? "Klip wrócił do kolejki." : "Zapisano szczegóły klipu.")
    if (result) setEditing(null)
  }

  const requestReturnToQueue = (item: AutomationContent): void => setConfirm({
    title: "Przywrócić klip do kolejki?",
    body: "Najpierw sprawdź Zernio. Przywróć klip tylko wtedy, gdy nie został opublikowany na żadnym wybranym koncie, aby uniknąć duplikatu.",
    confirmLabel: "Przywróć do kolejki",
    onConfirm: () => void saveContent(item, true)
  })

  const removeContent = (item: AutomationContent): void => {
    if (!selected) return
    setConfirm({
      title: "Usunąć ten klip?",
      body: <>“{item.title}” zostanie usunięty z tego banku treści.</>,
      confirmLabel: "Usuń klip",
      onConfirm: () => void mutate('remove', () => getApi().automations.removeContent(selected.id, item.id))
    })
  }

  const addTime = (): void => {
    if (!draft || !newTime || draft.times.includes(newTime) || draft.times.length >= 24) return
    setDraft({ ...draft, times: [...draft.times, newTime].sort() })
  }

  if (!configured) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Przestrzeń robocza" title="Automatyzacje" description="Publikuj kolejne klipy z banku treści codziennie o wybranych godzinach." />
        <EmptyState
          className="mt-6"
          icon={<Workflow />}
          title="Najpierw połącz Zernio"
          description="Automatyzacje publikują przez Zernio. Dodaj klucz API i połącz konta docelowe."
          action={<Button variant="primary" onClick={() => onNavigate('accounts')}>Otwórz konta</Button>}
        />
      </Page>
    )
  }

  const queued = selected?.content.filter((item) => item.status === 'queued') ?? []
  const counts: Record<ContentFilter, number> = {
    all: selected?.content.length ?? 0,
    queued: queued.length,
    posted: selected?.content.filter((item) => item.status === 'posted').length ?? 0,
    needs_review: selected?.content.filter((item) => item.status === 'needs_review').length ?? 0
  }
  const visibleContent = selected?.content.filter((item) => filter === 'all' || item.status === filter ||
    (filter === 'queued' && item.status === 'posting')) ?? []
  const savedReady = selected ? !missingSetup(selected) && !(selected.metadataMode === 'ai' && aiKeysMissing) : false
  const profileName = profiles.find((profile) => profile.id === selected?.profileId)?.name

  return (
    <Page width="default">
      <PageHeader
        eyebrow="Przestrzeń robocza"
        title="Automatyzacje"
        description="Publikuj kolejne klipy z banku treści codziennie o wybranych godzinach."
        actions={automations.length > 0 && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)} disabled={creating}>Nowa automatyzacja</Button>}
      />
      <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-subtle">
        <Clock3 className="h-3.5 w-3.5 shrink-0" />
        Shortigo musi być otwarty o zaplanowanej porze. Po uśpieniu lub ponownym otwarciu zadanie może ruszyć do pięciu minut później.
      </p>

      {(error || notice) && (
        <div className="mt-4 space-y-2">
          {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
          {notice && <Callout tone="success" onDismiss={() => setNotice(null)}>{notice}</Callout>}
        </div>
      )}

      {!loaded && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
          <div className="space-y-2">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-[58px] rounded-2xl" />)}</div>
          <div className="space-y-4"><Skeleton className="h-[148px] rounded-3xl" /><Skeleton className="h-[240px] rounded-3xl" /></div>
        </div>
      )}

      {loaded && automations.length === 0 && (
        <EmptyState
          className="mt-6"
          icon={<Workflow />}
          title="Utwórz pierwszą automatyzację"
          description="Wybierz profil Zernio i konta, dodaj klipy do banku treści oraz ustaw godziny publikacji."
          action={<CreateForm busy={busy === 'create'} onCreate={create} className="w-[320px] max-w-full" />}
        />
      )}

      {loaded && automations.length > 0 && (
        <div className="mt-5 grid items-start gap-4 lg:grid-cols-[248px_minmax(0,1fr)]">
          <nav aria-label="Automatyzacje" className="space-y-1.5 lg:sticky lg:top-12">
            {creating && (
              <div className="glass-tile rounded-2xl p-2">
                <CreateForm busy={busy === 'create'} onCreate={create} onCancel={() => setCreating(false)} autoFocus />
              </div>
            )}
            {automations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                selected={automation.id === selectedId}
                onSelect={() => select(automation)}
              />
            ))}
          </nav>

          {selected && draft && (
            <div className="min-w-0 space-y-4">
              <Panel>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <IconTile size="lg" tone={selected.enabled ? 'accent' : 'neutral'}><Workflow /></IconTile>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-lg font-semibold text-ink">{selected.name}</h2>
                        <AutomationBadge automation={selected} />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        {profileName ?? "Brak profilu"} · konta: {selected.accounts.length} · {selected.timezone}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className={cn('flex items-center gap-2 text-sm text-ink-muted', !selected.enabled && !savedReady && 'opacity-60')} title={!selected.enabled && !savedReady ? "Dokończ konfigurację i zapisz przed włączeniem" : undefined}>
                      {selected.enabled ? "Włączone" : "Wyłączone"}
                      <Switch
                        checked={selected.enabled}
                        disabled={Boolean(busy) || (!selected.enabled && !savedReady)}
                        onChange={(value) => void setEnabled(value)}
                        label="Automatyzacja włączona"
                      />
                    </label>
                    <Button
                      variant="secondary"
                      icon={<Play className="h-3.5 w-3.5" />}
                      loading={busy === 'run'}
                      disabled={Boolean(busy) || queued.length === 0}
                      title={queued.length === 0 ? "Najpierw dodaj klip do banku treści" : "Opublikuj następny klip z kolejki teraz"}
                      onClick={() => void runNow()}
                    >Uruchom teraz</Button>
                    <Button variant="ghost" iconOnly aria-label={`Usuń ${selected.name}`} title="Usuń automatyzację" icon={<Trash2 className="h-4 w-4" />} disabled={Boolean(busy)} onClick={remove} />
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="W kolejce" value={String(counts.queued)} hint={counts.queued === 1 ? 'clip' : 'clips'} />
                  <Stat label="Wysłano" value={String(counts.posted)} hint={counts.needs_review ? `${counts.needs_review} do sprawdzenia` : undefined} hintTone={counts.needs_review ? 'warning' : undefined} />
                  <Stat label="Następne zadanie" value={selected.enabled ? nextRunLabel(selected.times, selected.timezone) ?? '—' : "Wstrzymano"} />
                  <Stat label="Ostatnie zadanie" value={selected.lastRunAt ? formatRelativeDate(selected.lastRunAt) : "Nigdy"} />
                </dl>

                {selected.lastError && <Callout tone="danger" title="Ostatnie zadanie nie powiodło się" className="mt-3">{selected.lastError}</Callout>}
              </Panel>

              {!selected.enabled && (
                <SetupChecklist
                  steps={[
                    { label: "Wybierz profil", done: Boolean(draft.profileId) },
                    { label: "Wybierz konto", done: draft.accounts.length > 0 },
                    { label: "Dodaj godzinę publikacji", done: draft.times.length > 0 },
                    { label: "Dodaj klipy", done: counts.queued > 0 },
                    ...(draft.metadataMode === 'ai' ? [{ label: "Dodaj klucz OpenRouter", done: !aiKeysMissing, action: () => onNavigate('settings') }] : [])
                  ]}
                />
              )}

              <div className="grid items-start gap-4 xl:grid-cols-2">
                <Panel>
                  <PanelHeader
                    icon={<IconTile><Globe2 /></IconTile>}
                    title="Gdzie publikować"
                    description="Jeden profil Zernio. Każde zadanie publikuje na wszystkich zaznaczonych kontach."
                    action={<Button size="sm" variant="ghost" iconOnly aria-label="Odśwież konta" title="Odśwież konta" loading={accountsLoading} onClick={() => void loadAccounts()} icon={<RefreshCw className="h-3.5 w-3.5" />} />}
                  />
                  <Field
                    className="mt-4"
                    label="Profil Zernio"
                    htmlFor="automation-profile"
                    aside={!newProfileOpen && <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setNewProfileOpen(true)}>Nowy profil</button>}
                  >
                    <Select id="automation-profile" value={draft.profileId ?? ''} onChange={(event) => setDraft({ ...draft, profileId: event.target.value || null, accounts: [], enabled: false })}>
                      <option value="">Wybierz profil</option>
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.isOverLimit ? " · ponad limit" : ''}</option>)}
                    </Select>
                  </Field>
                  {newProfileOpen && (
                    <form onSubmit={(event) => void addProfile(event)} className="mt-2 flex gap-2">
                      <TextInput className="flex-1" autoFocus aria-label="Nazwa nowego profilu" placeholder="Nazwa nowego profilu" value={newProfileName} maxLength={80} onChange={(event) => setNewProfileName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setNewProfileOpen(false) }} />
                      <Button type="submit" loading={busy === 'profile'} disabled={!isValidProfileName(newProfileName) || Boolean(busy)}>Utwórz</Button>
                      <Button type="button" variant="ghost" iconOnly aria-label="Anuluj" icon={<X className="h-4 w-4" />} onClick={() => setNewProfileOpen(false)} />
                    </form>
                  )}

                  {draft.profileId && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-ink">Konta</p>
                        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} disabled={Boolean(busy)} onClick={() => void connectAccount()}>Połącz</Button>
                      </div>
                      {connected.length === 0 ? (
                        <p className="mt-2 rounded-xl glass-well px-3 py-3 text-xs text-ink-muted">Ten profil nie ma obsługiwanych kont. Połącz Instagram, YouTube, X, Facebook, LinkedIn lub Threads.</p>
                      ) : (
                        <div className="mt-2 grid gap-1.5">
                          {connected.map((account) => {
                            const available = isPostableAccount(account)
                            const checked = draft.accounts.some((item) => item.accountId === account.id)
                            const handle = account.username ? `@${account.username}` : account.displayName || "Połączone konto"
                            return (
                              <button
                                key={account.id}
                                type="button"
                                role="checkbox"
                                aria-checked={checked}
                                disabled={!available}
                                onClick={() => setDraft({ ...draft, accounts: checked ? draft.accounts.filter((item) => item.accountId !== account.id) : [...draft.accounts, { accountId: account.id, platform: account.platform as AutomationUpdate['accounts'][number]['platform'] }] })}
                                className={cn('glass-tile flex items-center gap-3 rounded-xl p-2 pr-3 text-left transition-colors', available && 'glass-tile-hover', checked && 'glass-selected', !available && 'cursor-not-allowed opacity-60')}
                              >
                                <PlatformIcon platform={account.platform} className="h-8 w-8 rounded-lg" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-sm font-medium text-ink">{handle}</span>
                                  <span className="block text-2xs text-ink-subtle">{available ? platformName(account.platform) : `${platformName(account.platform)} · połącz ponownie w sekcji Konta`}</span>
                                </span>
                                <span aria-hidden className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px]', checked ? 'bg-accent text-accent-ink' : 'bg-black/25 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]')}>
                                  {checked && <Check className="h-3 w-3" strokeWidth={3} />}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                      {accounts.some((account) => account.profileId === draft.profileId && account.platform === 'tiktok') && (
                        <p className="mt-2 text-2xs text-ink-subtle">TikTok wymaga ustawień i zgody dla każdej publikacji. Publikuj tam ręcznie z karty klipu.</p>
                      )}
                    </div>
                  )}
                </Panel>

                <Panel>
                  <PanelHeader icon={<IconTile><Clock3 /></IconTile>} title="Kiedy publikować" description="Codziennie o każdej ustawionej godzinie publikowany jest jeden klip z kolejki." />
                  <div className="mt-4">
                    <p className="text-sm font-medium text-ink">Godziny codziennej publikacji</p>
                    {draft.times.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {draft.times.map((time) => (
                          <li key={time} className="glass-tile inline-flex h-8 items-center gap-1 rounded-full pl-3 pr-1 font-mono text-xs tabular text-ink">
                            {formatTime(time)}
                            <button type="button" aria-label={`Usuń ${formatTime(time)}`} className="flex h-6 w-6 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-white/[0.08] hover:text-ink" onClick={() => setDraft({ ...draft, times: draft.times.filter((item) => item !== time) })}>
                              <X className="h-3 w-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="mt-2 text-xs text-ink-muted">Nie dodano godzin.</p>}
                    <div className="mt-2 flex gap-2">
                      <TextInput type="time" aria-label="Nowa godzina publikacji" mono className="w-[132px] [color-scheme:dark]" value={newTime} onChange={(event) => setNewTime(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addTime() }} />
                      <Button icon={<Plus className="h-3.5 w-3.5" />} onClick={addTime} disabled={!newTime || draft.times.includes(newTime) || draft.times.length >= 24}>Dodaj godzinę</Button>
                    </div>
                  </div>
                  <Field className="mt-4" label="Strefa czasowa" htmlFor="automation-timezone">
                    <Select id="automation-timezone" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
                      {timeZones(draft.timezone).map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
                    </Select>
                  </Field>
                </Panel>
              </div>

              <Panel>
                <PanelHeader icon={<IconTile><Sparkles /></IconTile>} title="Szczegóły publikacji" description="Nazwa i opis klipu używane przy publikacji." />
                <div className="mt-4 space-y-2">
                  <Field label="Nazwa automatyzacji" htmlFor="automation-name">
                    <TextInput id="automation-name" value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                  </Field>
                  <SettingRow
                    className="mt-3"
                    title="Twórz opisy z AI"
                    description="Po włączeniu OpenRouter tworzy transkrypcję i opis każdego klipu. Opisy publikują się automatycznie, bez zatwierdzania. AI może się mylić; wyłącz tę opcję, aby używać własnych opisów."
                    control={<Switch checked={draft.metadataMode === 'ai'} onChange={(on) => setDraft({ ...draft, metadataMode: on ? 'ai' : 'manual' })} label="Twórz opisy z AI" />}
                  />
                  {draft.metadataMode === 'ai' && aiKeysMissing && (
                    <Callout tone="warning" action={<Button size="sm" onClick={() => onNavigate('settings')}>Otwórz ustawienia</Button>}>
                      Dodaj klucz OpenRouter przed włączeniem tej automatyzacji.
                    </Callout>
                  )}
                  {draft.accounts.some((account) => account.platform === 'youtube') && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <SettingRow
                        title="Widoczność w YouTube"
                        control={<Segmented size="sm" label="Widoczność w YouTube" value={draft.youtubeVisibility} onChange={(value) => setDraft({ ...draft, youtubeVisibility: value })} options={[{ value: 'public', label: "Publiczny" }, { value: 'unlisted', label: "Niepubliczny" }, { value: 'private', label: "Prywatny" }]} />}
                      />
                      <SettingRow
                        title="Dla dzieci"
                        control={<Switch checked={draft.youtubeMadeForKids} onChange={(value) => setDraft({ ...draft, youtubeMadeForKids: value })} label="Dla dzieci" />}
                      />
                    </div>
                  )}
                </div>
              </Panel>

              <Panel>
                <PanelHeader
                  icon={<IconTile><FileVideo2 /></IconTile>}
                  title="Bank treści"
                  description="Najstarszy klip z kolejki publikuje się pierwszy. Opublikowane klipy pozostają w banku."
                  action={<Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'upload'} onClick={() => void mutate('upload', () => getApi().automations.addContent(selected.id), "Dodano klipy do banku.")} disabled={Boolean(busy)}>Dodaj klipy</Button>}
                />
                {selected.content.length > 0 && (
                  <Segmented
                    className="mt-4"
                    size="sm"
                    label="Filtruj klipy"
                    value={filter}
                    onChange={setFilter}
                    options={[
                      { value: 'all', label: `Wszystkie ${counts.all}` },
                      { value: 'queued', label: `W kolejce ${counts.queued}` },
                      { value: 'posted', label: `Wysłano ${counts.posted}` },
                      ...(counts.needs_review ? [{ value: 'needs_review' as const, label: `Do sprawdzenia ${counts.needs_review}` }] : [])
                    ]}
                  />
                )}
                <ul className="mt-3 space-y-1.5">
                  {selected.content.length === 0 && (
                    <li className="glass-well rounded-xl px-4 py-6 text-center">
                      <p className="text-sm text-ink">Brak klipów</p>
                      <p className="mt-1 text-xs text-ink-muted">Dodaj pliki MP4, MOV, M4V lub WebM albo prześlij klipy z Biblioteki.</p>
                    </li>
                  )}
                  {selected.content.length > 0 && visibleContent.length === 0 && <li className="py-4 text-center text-xs text-ink-muted">Brak klipów pasujących do filtra.</li>}
                  {visibleContent.map((item) => (
                    <ContentRow
                      key={item.id}
                      item={item}
                      nextUp={item.id === queued[0]?.id}
                      editing={editing?.id === item.id ? editing : null}
                      busy={Boolean(busy)}
                      onEdit={() => setEditing(editing?.id === item.id ? null : { id: item.id, title: item.title, caption: item.caption })}
                      onChange={setEditing}
                      onSave={() => void saveContent(item)}
                      onReturnToQueue={() => requestReturnToQueue(item)}
                      onRemove={() => removeContent(item)}
                      onCheckPosts={() => { usePostsStore.getState().requestReveal(); onNavigate('accounts') }}
                    />
                  ))}
                </ul>
              </Panel>

              {dirty && (
                <div className="glass-thick sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-full py-2 pl-5 pr-2 animate-fade-in" role="region" aria-label="Niezapisane zmiany">
                  <p className="flex items-center gap-2 text-sm text-ink"><StatusDot tone="warning" />Niezapisane zmiany</p>
                  <div className="flex gap-2">
                    <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDraft(draftFor(selected))}>Odrzuć</Button>
                    <Button variant="primary" loading={busy === 'save'} disabled={Boolean(busy)} onClick={() => void save()}>Zapisz zmiany</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
    </Page>
  )
}

function automationState(automation: Automation): { label: string; tone: 'success' | 'warning' | 'danger' | 'idle' } {
  if (automation.enabled && automation.lastError) return { label: "Błędy", tone: 'danger' }
  if (automation.enabled) return { label: "Włączone", tone: 'success' }
  if (missingSetup(automation)) return { label: "Wymaga konfiguracji", tone: 'warning' }
  return { label: "Wstrzymano", tone: 'idle' }
}

function AutomationBadge({ automation }: { automation: Automation }): React.JSX.Element {
  const state = automationState(automation)
  return <Badge tone={state.tone === 'idle' ? 'neutral' : state.tone}>{state.label}</Badge>
}

function AutomationRow({ automation, selected, onSelect }: { automation: Automation; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const state = automationState(automation)
  const queued = automation.content.filter((item) => item.status === 'queued').length
  const next = automation.enabled ? nextRunLabel(automation.times, automation.timezone) : null
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn('glass-tile glass-tile-hover flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left', selected && 'glass-selected')}
    >
      <StatusDot tone={state.tone} pulse={state.tone === 'success'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{automation.name}</span>
        <span className="mt-0.5 block truncate text-2xs text-ink-subtle">
          {state.label} · {queued} w kolejce{next ? ` · ${next}` : ''}
        </span>
      </span>
    </button>
  )
}

function CreateForm({ busy, onCreate, onCancel, autoFocus, className }: {
  busy: boolean
  onCreate: (name: string) => Promise<boolean>
  onCancel?: () => void
  autoFocus?: boolean
  className?: string
}): React.JSX.Element {
  const [name, setName] = useState('')
  return (
    <form
      className={cn('flex gap-1.5', className)}
      onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onCreate(name).then((ok) => { if (ok) setName('') }) }}
    >
      <TextInput className="flex-1" autoFocus={autoFocus} aria-label="Nazwa automatyzacji" placeholder="Nazwa automatyzacji" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onCancel?.() }} />
      <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || busy}>Utwórz</Button>
      {onCancel && <Button type="button" variant="ghost" iconOnly aria-label="Anuluj" icon={<X className="h-4 w-4" />} onClick={onCancel} />}
    </form>
  )
}

function Stat({ label, value, hint, hintTone }: { label: string; value: string; hint?: string; hintTone?: 'warning' }): React.JSX.Element {
  return (
    <div className="glass-tile rounded-xl px-3 py-2">
      <dt className="text-2xs text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular text-ink">
        {value}{hint && <span className={cn('ml-1.5 text-2xs font-normal', hintTone === 'warning' ? 'text-warning' : 'text-ink-subtle')}>{hint}</span>}
      </dd>
    </div>
  )
}

function SetupChecklist({ steps }: { steps: { label: string; done: boolean; action?: () => void }[] }): React.JSX.Element | null {
  const remaining = steps.filter((step) => !step.done).length
  if (remaining === 0) return null
  return (
    <div className="glass rounded-3xl p-4 xl:p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Dokończ konfigurację</p>
        <p className="text-xs text-ink-subtle">{steps.length - remaining} z {steps.length} gotowe</p>
      </div>
      <ol className="mt-3 flex flex-wrap gap-1.5">
        {steps.map((step) => {
          const content = <>
            <span className={cn('flex h-4 w-4 items-center justify-center rounded-full', step.done ? 'bg-success/20 text-success' : 'shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]')}>
              {step.done && <Check className="h-2.5 w-2.5" strokeWidth={3.5} />}
            </span>
            {step.label}
          </>
          const className = cn('inline-flex h-7 items-center gap-2 rounded-full pl-1.5 pr-3 text-xs', step.done ? 'text-ink-subtle line-through decoration-ink-faint' : 'glass-tile text-ink')
          return <li key={step.label}>
            {step.action && !step.done
              ? <button type="button" className={cn(className, 'glass-tile-hover')} onClick={step.action}>{content}</button>
              : <span className={className}>{content}</span>}
          </li>
        })}
      </ol>
    </div>
  )
}

function ContentRow({ item, nextUp, editing, busy, onEdit, onChange, onSave, onReturnToQueue, onRemove, onCheckPosts }: {
  item: AutomationContent
  nextUp: boolean
  editing: { id: string; title: string; caption: string } | null
  busy: boolean
  onEdit: () => void
  onChange: (value: { id: string; title: string; caption: string }) => void
  onSave: () => void
  onReturnToQueue: () => void
  onRemove: () => void
  onCheckPosts: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const status = CONTENT_STATUS[item.status]
  const hasDetails = Boolean(item.generatedMetadata || item.transcript)
  return (
    <li className={cn('glass-tile rounded-2xl p-2', (editing || open) && 'bg-white/[0.06]')}>
      <div className="flex items-center gap-3">
        <IconTile size="lg" tone={item.status === 'needs_review' ? 'warning' : 'neutral'}><FileVideo2 /></IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-ink">{item.title}</p>
            {nextUp && <Badge tone="accent">Następny</Badge>}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-ink-subtle">
            <StatusDot tone={status.tone} pulse={item.status === 'posting'} className="h-1.5 w-1.5 [&>span]:h-1.5 [&>span]:w-1.5" />
            <span className={cn(item.status === 'needs_review' ? 'text-warning' : 'text-ink-muted')}>{status.label}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{item.postedAt ? `Opublikowano ${formatRelativeDate(item.postedAt)}` : `Dodano ${formatRelativeDate(item.addedAt)}`}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {hasDetails && <Button size="sm" variant="ghost" aria-expanded={open} trailingIcon={<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />} onClick={() => setOpen(!open)}>Szczegóły AI</Button>}
          <Button size="sm" variant="ghost" iconOnly aria-label={editing ? "Zamknij edytor" : `Edytuj ${item.title}`} title="Edytuj tytuł i opis" icon={editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />} onClick={onEdit} />
          <Button size="sm" variant="ghost" iconOnly aria-label={`Usuń ${item.title}`} title="Usuń z banku" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={busy} onClick={onRemove} />
        </div>
      </div>

      {item.error && (
        <Callout tone={item.status === 'needs_review' ? 'warning' : 'danger'} className="mt-2" action={item.status === 'needs_review' && <Button size="sm" onClick={onCheckPosts}>Sprawdź publikacje</Button>}>
          {item.error}
        </Callout>
      )}
      {!item.error && item.status === 'needs_review' && (
        <Callout tone="warning" className="mt-2" action={<Button size="sm" onClick={onCheckPosts}>Sprawdź publikacje</Button>}>Przed ponowieniem sprawdź, czy klip został już opublikowany.</Callout>
      )}

      {open && hasDetails && (
        <div className="mt-2 space-y-1.5 px-1 pb-1">
          {item.generatedMetadata?.map((post) => (
            <div key={post.platform} className="glass-well rounded-xl p-3 text-xs text-ink-muted">
              <p className="flex items-center gap-2 font-medium text-ink"><PlatformIcon platform={post.platform} variant="glyph" />{platformName(post.platform)}{post.title ? ` · ${post.title}` : ''}</p>
              <p className="mt-1.5 whitespace-pre-wrap leading-relaxed" data-selectable>{post.caption}</p>
              {(post.tags.length > 0 || post.categoryId || post.topicTag) && (
                <p className="mt-1.5 text-2xs text-ink-subtle">
                  {[post.tags.length > 0 && `Tagi: ${post.tags.join(', ')}`, post.categoryId && `Kategoria ${post.categoryId}`, post.topicTag && `Temat: ${post.topicTag}`].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          ))}
          {item.transcript && (
            <details className="glass-well rounded-xl p-3 text-xs text-ink-muted">
              <summary className="cursor-pointer font-medium text-ink">Transkrypcja</summary>
              <p className="mt-1.5 whitespace-pre-wrap leading-relaxed" data-selectable>{item.transcript}</p>
            </details>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-2 space-y-3 px-1 pb-1">
          <Field label="Tytuł">
            <TextInput value={editing.title} maxLength={500} onChange={(event) => onChange({ ...editing, title: event.target.value })} />
          </Field>
          <Field label="Opis">
            <TextArea className="min-h-[86px]" value={editing.caption} onChange={(event) => onChange({ ...editing, caption: event.target.value })} />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            {item.status === 'needs_review' && !item.postId && <Button size="sm" variant="secondary" onClick={onReturnToQueue} disabled={busy}>Przywróć do kolejki</Button>}
            <Button size="sm" variant="primary" onClick={onSave} disabled={busy}>Zapisz klip</Button>
          </div>
        </div>
      )}
    </li>
  )
}

function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus() }
  }, [onClose])
  return (
    <Dialog role="alertdialog" aria-labelledby={titleId} onBackdropMouseDown={onClose} panelClassName="max-w-[420px]">
      <div className="px-5 pb-5 pt-5">
        <h2 id={titleId} className="text-base font-semibold text-ink">{request.title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{request.body}</p>
      </div>
      <DialogFooter>
        <Button ref={cancelRef} onClick={onClose}>Anuluj</Button>
        <Button variant="danger" onClick={() => { onClose(); request.onConfirm() }}>{request.confirmLabel}</Button>
      </DialogFooter>
    </Dialog>
  )
}
