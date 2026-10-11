import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, CalendarClock, Clapperboard, RefreshCw, RotateCcw, Send, X } from 'lucide-react'
import { cn, formatRelativeDate, localFileUrl } from '../lib/utils'
import { loadThumbnail } from '../lib/thumbnails'
import { usePostsStore } from '../store/use-posts-store'
import { scheduleError, scheduleWindow, type PostRecord } from '../../shared/zernio-posts'
import { PlatformIcon, platformName } from './PlatformIcon'
import { formatScheduled, targetBadge } from './PostDialog'
import { Panel, PanelHeader } from './ui/Panel'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { IconTile } from './ui/IconTile'
import { WELL } from './ui/Field'
import type { Page } from './Sidebar'

/** Statuses only change on Zernio's side; the main process decides which posts are worth a request. */
const POLL_MS = 30_000
const RECENT_LIMIT = 6

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function whenText(post: PostRecord): string {
  switch (post.status) {
    case 'scheduled':
      return post.scheduledFor ? `Zaplanowano na ${formatScheduled(post.scheduledFor, post.timezone)}` : "Zaplanowano"
    case 'publishing':
      return 'Publishing…'
    case 'published':
      return `Opublikowano ${formatRelativeDate(post.createdAt)}`
    case 'partial':
      return `Opublikowano częściowo ${formatRelativeDate(post.createdAt)}`
    case 'failed':
      return `Błąd ${formatRelativeDate(post.createdAt)}`
    case 'cancelled':
      return `Anulowano · utworzono ${formatRelativeDate(post.createdAt)}`
    case 'missing':
      return "Nie ma już w Twojej przestrzeni Zernio"
    default:
      return `Zapisano jako szkic w Zernio ${formatRelativeDate(post.createdAt)}`
  }
}

/** Posts made from Shortigo: scheduled, failed and recent, with cancel, retry and links. */
export function PostsPanel({ onNavigate }: { onNavigate?: (page: Page) => void }): React.JSX.Element {
  const { posts, loaded, refreshing, error, clearError, refresh } = usePostsStore()
  const [showAll, setShowAll] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // After App's scroll-to-top for the new page, which runs after this effect.
    const reveal = usePostsStore.getState().takeReveal() ? requestAnimationFrame(() => panel.current?.scrollIntoView({ block: 'start' })) : 0
    void usePostsStore.getState().load().then(() => usePostsStore.getState().refresh(false))
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void usePostsStore.getState().refresh(false)
    }, POLL_MS)
    const onFocus = (): void => void usePostsStore.getState().refresh(false)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelAnimationFrame(reveal)
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const groups = useMemo(() => {
    const scheduled = posts.filter((p) => p.status === 'scheduled').sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''))
    const attention = posts.filter((p) => p.status === 'failed' || p.status === 'partial' || p.status === 'missing')
    const recent = posts.filter((p) => !scheduled.includes(p) && !attention.includes(p))
    return { scheduled, attention, recent }
  }, [posts])
  const recent = showAll ? groups.recent : groups.recent.slice(0, RECENT_LIMIT)

  return (
    <div ref={panel} className="scroll-mt-16">
      <Panel padded={false} className="overflow-hidden">
        <PanelHeader
          className="p-4 pb-4"
          icon={<IconTile><Send /></IconTile>}
          title="Publikacje"
          description="Klipy publikowane lub planowane w Shortigo. Zernio publikuje je również po zamknięciu aplikacji."
          action={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Odśwież publikacje"
              title="Odśwież"
              onClick={() => void refresh(true)}
              disabled={refreshing}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />}
            />
          }
        />

        {error && (
          <Callout tone="danger" onDismiss={clearError} className="mx-4 mb-4">
            {error}
          </Callout>
        )}

        {!loaded ? (
          <p role="status" className="border-t border-white/[0.06] px-4 py-4 text-sm text-ink-muted">Wczytywanie publikacji…</p>
        ) : posts.length === 0 && error ? (
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-4">
            <p className="text-sm text-ink-muted">Historia publikacji jest teraz niedostępna.</p>
            <Button size="sm" onClick={() => void usePostsStore.getState().load()}>Spróbuj ponownie</Button>
          </div>
        ) : posts.length === 0 ? (
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-4">
            <p className="text-sm text-ink-muted">Brak publikacji. Otwórz zadanie w Bibliotece i wybierz Opublikuj przy klipie.</p>
            {onNavigate && (
              <Button size="sm" icon={<Clapperboard className="h-3.5 w-3.5" />} onClick={() => onNavigate('library')}>
                Otwórz bibliotekę
              </Button>
            )}
          </div>
        ) : (
          <>
            <PostGroup title="Zaplanowano" posts={groups.scheduled} />
            <PostGroup title="Wymaga uwagi" posts={groups.attention} />
            <PostGroup title="Ostatnie" posts={recent} />
            {groups.recent.length > RECENT_LIMIT && (
              <div className="border-t border-white/[0.06] px-3 py-3">
                <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Pokaż mniej" : `Pokaż wszystkie ${groups.recent.length}`}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  )
}

function PostGroup({ title, posts }: { title: string; posts: PostRecord[] }): React.JSX.Element | null {
  if (posts.length === 0) return null
  return (
    <section className="border-t border-white/[0.06]" aria-label={title}>
      <h3 className="eyebrow flex items-center gap-2 px-4 pb-1 pt-3">
        {title}
        <span className="rounded-full bg-white/[0.07] px-1.5 py-px font-mono text-[10px] tabular tracking-normal text-ink-muted">{posts.length}</span>
      </h3>
      <ul className="divide-y divide-white/[0.05]">
        {posts.map((post) => <PostRow key={post.id} post={post} />)}
      </ul>
    </section>
  )
}

function PostThumb({ clipPath }: { clipPath: string }): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    loadThumbnail(clipPath).then((path) => { if (!cancelled) setThumb(path) })
    return () => { cancelled = true }
  }, [clipPath])
  return thumb ? (
    <img
      src={localFileUrl(thumb)}
      alt=""
      draggable={false}
      className="h-14 w-14 shrink-0 rounded-xl object-cover shadow-[0_6px_16px_-8px_rgb(0_0_0/0.7)] ring-1 ring-white/[0.12]"
    />
  ) : (
    <span aria-hidden className="glass-tile flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-ink-subtle">
      <Clapperboard className="h-4 w-4" />
    </span>
  )
}

function PostRow({ post }: { post: PostRecord }): React.JSX.Element {
  const busy = usePostsStore((s) => s.busy[post.id])
  const { cancel, reschedule, retry, dismiss, open } = usePostsStore.getState()
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (editing === null) return
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [editing])

  useEffect(() => {
    if (post.status !== 'scheduled') {
      setEditing(null)
      setConfirming(false)
    }
  }, [post.status])

  const failedTargets = post.targets.filter((t) => t.error)
  const capacity = failedTargets.some((t) => t.platform === 'tiktok' && /capacity/i.test(t.error ?? ''))
  const uploadedAt = Date.parse(post.uploadedAt)
  const editingAt = editing ? new Date(editing).getTime() : NaN
  const editingProblem = editing ? scheduleError(editingAt, now, uploadedAt) : null

  const startEditing = (): void => {
    setConfirming(false)
    const currentNow = Date.now()
    setNow(currentNow)
    const current = post.scheduledFor ? Date.parse(post.scheduledFor) : currentNow + 60 * 60_000
    setEditing(toLocalInput(current))
  }

  const saveSchedule = async (): Promise<void> => {
    if (!editing || editingProblem) return
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    if (await reschedule(post.id, new Date(editingAt).toISOString(), timezone)) setEditing(null)
  }

  let actions: React.ReactNode
  if (post.status === 'scheduled') {
    actions = confirming ? (
      <>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={Boolean(busy)}>Zachowaj</Button>
        <Button size="sm" variant="danger" loading={busy === 'cancel'} onClick={() => void cancel(post.id).then(() => setConfirming(false))}>
          Anuluj publikację
        </Button>
      </>
    ) : (
      <>
        <Button size="sm" variant="ghost" icon={<CalendarClock className="h-3.5 w-3.5" />} onClick={startEditing} disabled={Boolean(busy) || editing !== null}>
          Zmień termin
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setConfirming(true) }} disabled={Boolean(busy)}>Anuluj</Button>
      </>
    )
  } else if (post.status === 'failed' || post.status === 'partial') {
    actions = (
      <>
        <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === 'retry'} disabled={Boolean(busy)} onClick={() => void retry(post.id)}>
          Ponów
        </Button>
        <Button size="sm" variant="ghost" iconOnly aria-label={`Usuń „${post.clipTitle}” z listy`} title="Usuń z listy" disabled={Boolean(busy)} onClick={() => void dismiss(post.id)} icon={<X className="h-3.5 w-3.5" />} />
      </>
    )
  } else if (post.status !== 'publishing') {
    actions = (
      <Button size="sm" variant="ghost" iconOnly aria-label={`Usuń „${post.clipTitle}” z listy`} title="Usuń z listy" disabled={Boolean(busy)} onClick={() => void dismiss(post.id)} icon={<X className="h-3.5 w-3.5" />} />
    )
  }

  return (
    <li className="px-4 py-3 transition-colors duration-150 hover:bg-white/[0.02]">
      <div className="flex items-start gap-3">
        <PostThumb clipPath={post.clipPath} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink" title={post.clipTitle}>{post.clipTitle || "Klip bez tytułu"}</p>
          <p className={cn('mt-1 text-xs', post.status === 'failed' || post.status === 'missing' ? 'text-danger' : post.status === 'scheduled' ? 'text-accent-hover' : 'text-ink-muted')}>
            {confirming ? <span className="text-ink">Anulować tę publikację? Zernio jej nie opublikuje.</span> : whenText(post)}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {post.targets.map((target, index) => {
              const badge = targetBadge(target, post.status)
              const chip = (
                <>
                  <PlatformIcon platform={target.platform} className="h-[18px] w-[18px] rounded-full [&_svg]:h-2.5 [&_svg]:w-2.5" />
                  <span className="max-w-[140px] truncate text-ink">{target.handle ?? platformName(target.platform)}</span>
                  <span className={cn(badge.tone === 'danger' ? 'text-danger' : badge.tone === 'accent' ? 'text-accent-hover' : 'text-ink-subtle')}>· {badge.label}</span>
                </>
              )
              const className = 'inline-flex h-[26px] items-center gap-1.5 rounded-full bg-white/[0.05] pl-1 pr-2.5 text-2xs text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.09),inset_0_1px_0_rgb(255_255_255/0.06)]'
              return target.url ? (
                <button
                  key={`${target.platform}:${target.accountId}`}
                  type="button"
                  onClick={() => open(post.id, index)}
                  title={`Otwórz w ${platformName(target.platform)}`}
                  aria-label={`Otwórz w ${platformName(target.platform)}, ${target.handle ?? 'account'}, ${badge.label}`}
                  className={cn(className, 'transition-[background,box-shadow,color] duration-150 hover:bg-white/[0.09] hover:text-ink hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16),inset_0_1px_0_rgb(255_255_255/0.08)]')}
                >
                  {chip}
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              ) : (
                <span key={`${target.platform}:${target.accountId}`} className={className}>{chip}</span>
              )
            })}
          </div>
          {failedTargets.map((target) => (
            <p key={`${target.platform}:${target.accountId}`} className="mt-2 text-xs text-danger" data-selectable>
              {platformName(target.platform)}: {target.error}
            </p>
          ))}
          {post.status === 'failed' && failedTargets.length === 0 && post.error && (
            <p className="mt-1.5 text-xs text-danger" data-selectable>{post.error}</p>
          )}
          {capacity && (
            <p className="mt-1 text-xs text-ink-subtle">Bezpośrednia publikacja w TikToku jest zajęta. Spróbuj za kilka godzin lub wybierz wysłanie do skrzynki TikToka.</p>
          )}

          {editing !== null && (
            <div className="glass-tile mt-3 rounded-2xl p-3 animate-fade-in">
              <div className="flex flex-wrap items-center gap-2">
                <CalendarClock aria-hidden className="h-4 w-4 text-ink-subtle" />
                <input
                  type="datetime-local"
                  value={editing}
                  min={toLocalInput(scheduleWindow(now, uploadedAt).min)}
                  max={toLocalInput(scheduleWindow(now, uploadedAt).max)}
                  onChange={(e) => setEditing(e.target.value)}
                  aria-label="Nowa data i godzina publikacji"
                  aria-invalid={Boolean(editingProblem)}
                  className={cn('h-[30px] rounded-full px-3 font-mono text-xs tabular text-ink [color-scheme:dark] focus:outline-none', WELL)}
                />
                <Button size="sm" variant="primary" loading={busy === 'reschedule'} disabled={Boolean(editingProblem)} onClick={() => void saveSchedule()}>
                  Zapisz
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy === 'reschedule'}>Anuluj</Button>
              </div>
              {editingProblem && <p role="alert" className="mt-2 text-xs text-danger">{editingProblem}</p>}
            </div>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
    </li>
  )
}
