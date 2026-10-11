import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Clock3, FolderOpen, ImageOff, Play, Send, TrendingUp } from 'lucide-react'
import { clipPublications, matchingClipPosts, type ClipPublication } from '../../shared/clip-publications'
import { isZernioPlatform, ZERNIO_PLATFORM_NAMES } from '../../shared/zernio'
import { usePostsStore } from '../store/use-posts-store'
import { cn, formatTimecode, isMac, localFileUrl } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { clipFilePath, loadThumbnail } from '../lib/thumbnails'
import type { ClipArtifact } from '../store/use-job-store'
import { Checkbox } from './ui/Checkbox'
import { Button } from './ui/Button'
import { Skeleton } from './ui/Skeleton'

// How the engine framed a vertical clip (its dominant layout).
const LAYOUT_LABELS: Record<string, string> = {
  talking_head: "Osoba mówiąca",
  two_shot: "Dwie osoby",
  screen_cam: "Ekran i kamera",
  screen: "Cały kadr",
  fit: "Cały kadr",
  center_crop: "Kadr centralny"
}

interface ClipCardProps {
  libraryActions?: ReactNode
  allowSelection?: boolean
  clip: ClipArtifact
  vertical: boolean
  topPick?: boolean
  selected: boolean
  selecting: boolean
  onToggleSelect: () => void
  /** Reports the thumbnail's aspect ratio so the grid can size to the output. */
  onAspect?: (ratio: number) => void
  /** Opens the post dialog for this clip. */
  onPost?: () => void
  onEditTimeline?: () => void
  onThumbnail?: () => void
  onEditTitle?: () => void
}

export function ClipCard({
  clip,
  vertical,
  topPick,
  selected,
  selecting,
  onToggleSelect,
  onAspect,
  onPost,
  onThumbnail,
  onEditTitle,
  onEditTimeline,
  libraryActions,
  allowSelection = true
}: ClipCardProps): React.JSX.Element {
  const filePath = clipFilePath(clip.s3_url)
  const posts = usePostsStore(s => s.posts)
  const relatedPosts = useMemo(() => matchingClipPosts(posts, filePath, clip.library_key), [posts, filePath, clip.library_key])
  const [rememberedSends, setRememberedSends] = useState<{ key: string; sent: ClipPublication[] }>({ key: clip.library_key ?? filePath, sent: [] })
  const identity = clip.library_key ?? filePath
  const sent = useMemo(() => clipPublications([
    ...(clip.sent_to ?? []), ...(rememberedSends.key === identity ? rememberedSends.sent : [])
  ], relatedPosts), [clip.sent_to, rememberedSends, identity, relatedPosts])
  useEffect(() => {
    setRememberedSends(previous => previous.key === identity && JSON.stringify(previous.sent) === JSON.stringify(sent) ? previous : { key: identity, sent })
  }, [identity, sent])
  const platformName = (platform: string): string => isZernioPlatform(platform) ? ZERNIO_PLATFORM_NAMES[platform] : platform
  const sentPlatforms = [...new Set(sent.map(p => platformName(p.platform)))].join(', ')
  const pending = relatedPosts.filter(p => p.status === 'publishing' || p.status === 'scheduled')
  const pendingPlatforms = [...new Set(pending.flatMap(p => p.targets.filter(t => t.status !== 'failed' && t.status !== 'cancelled' && t.status !== 'published').map(t => platformName(t.platform))))].join(', ')
  const [thumb, setThumb] = useState<string | null | undefined>(undefined)
  const [aspect, setAspect] = useState<number | null>(null)
  const [hovering, setHovering] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const title = clip.summary || `Klip ${clip.clip_index + 1}`
  const timelineEdited = /\.edit-[0-9a-f-]{36}(?:\.base)?\.mp4$/i.test(filePath) ||
    /\.edit-[0-9a-f-]{36}\.base\.mp4$/i.test(clip.title_base_url ?? '')
  const score = (clip.virality_score * 10).toFixed(1)
  const clipVertical = aspect == null ? vertical : aspect < 1
  const layout = clipVertical && Object.prototype.hasOwnProperty.call(LAYOUT_LABELS, clip.layout_type)
    ? LAYOUT_LABELS[clip.layout_type]
    : undefined

  useEffect(() => {
    let cancelled = false
    setThumb(undefined)
    setAspect(null)
    setPreviewFailed(false)
    setActionError(null)
    const seek = clip.duration_ms > 0 ? (clip.duration_ms / 1000) * 0.5 : undefined
    if (clip.thumbnail_url) setThumb(clipFilePath(clip.thumbnail_url))
    else loadThumbnail(filePath, seek).then((path) => {
      if (!cancelled) setThumb(path)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, clip.duration_ms, clip.thumbnail_url])

  const openClip = async (): Promise<void> => {
    setActionError(null)
    try {
      if (!await getApi().shell.openPath(filePath)) setActionError("Plik klipu nie jest już dostępny.")
    } catch {
      setActionError("Nie udało się otworzyć klipu.")
    }
  }

  const showInFolder = async (): Promise<void> => {
    setActionError(null)
    try {
      if (!await getApi().shell.showItemInFolder(filePath)) setActionError("Plik klipu nie jest już dostępny.")
    } catch {
      setActionError("Nie udało się pokazać klipu w folderze.")
    }
  }

  return (
    <article
      className={cn(
        'glass group relative flex flex-col rounded-2xl p-1.5 transition-[transform,box-shadow] duration-300 ease-out',
        selected
          ? 'shadow-accent-ring'
          : 'hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_0_0_1px_rgb(255_255_255/0.08),0_24px_48px_-20px_rgb(0_0_0/0.75)]'
      )}
    >
      <div
        className={cn(
          'relative cursor-pointer overflow-hidden rounded-xl bg-black/40 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]',
          clipVertical ? 'aspect-[9/16]' : 'aspect-video'
        )}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onClick={selecting ? onToggleSelect : () => { void openClip() }}
      >
        {thumb ? (
          <img
            src={localFileUrl(thumb)}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            onLoad={(e) => {
              if (clip.thumbnail_url) return
              const ratio = e.currentTarget.naturalWidth / e.currentTarget.naturalHeight
              if (Number.isFinite(ratio) && ratio > 0) {
                setAspect(ratio)
                onAspect?.(ratio)
              }
            }}
            onError={() => setThumb(null)}
          />
        ) : thumb === null ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-subtle">
            <ImageOff className="h-6 w-6" />
            <span className="text-xs">Podgląd niedostępny</span>
          </div>
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
        {hovering && !previewFailed && (
          <video
            src={localFileUrl(filePath)}
            autoPlay
            muted
            loop
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setPreviewFailed(true)}
          />
        )}

        {allowSelection && <div
          className={cn(
            'absolute left-2.5 top-2.5 transition-opacity duration-200',
            selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <Checkbox variant="overlay" checked={selected} onChange={onToggleSelect} label={`Wybierz ${title}`} />
        </div>}
        <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
          {topPick && (
            <span className="inline-flex h-[22px] items-center rounded-full bg-accent px-2.5 text-2xs font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] backdrop-blur-md">
              Najlepszy
            </span>
          )}
          <span
            className="glass-chip inline-flex h-[22px] items-center gap-1 rounded-full px-2 font-mono text-2xs font-medium tabular text-white"
            title="Ocena potencjału"
          >
            <TrendingUp className="h-3 w-3 text-brand-gold" />
            {score}
          </span>
        </div>
        <span className="glass-chip absolute bottom-2.5 left-2.5 rounded-full px-2 py-0.5 font-mono text-2xs tabular text-white/95">
          {formatTimecode(clip.duration_ms)}
        </span>
        {!selecting && (
          <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="glass-chip flex h-12 w-12 scale-90 items-center justify-center rounded-full text-white transition-transform duration-300 ease-spring group-hover:scale-100">
              <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
            </span>
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col px-2 pb-1.5 pt-3">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink" title={title}>
          {title}
        </h3>
        {sent.length > 0 && <p className="mt-2 flex items-start gap-1.5 text-xs text-emerald-400"
          title={sent.map(p => `${platformName(p.platform)}${p.inbox ? ' (skrzynka)' : ''} · ${new Date(p.sentAt).toLocaleString('pl-PL')}`).join('\n')}>
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Wysłano · {sentPlatforms}</span>
        </p>}
        {pendingPlatforms && <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-300">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{pending.some(p => p.status === 'publishing' || !p.scheduledFor) ? 'W kolejce' : 'Zaplanowano'} · {pendingPlatforms}</span>
        </p>}
        <p className="mt-1.5 truncate text-2xs text-ink-subtle">
          {timelineEdited ? <span>Montaż · {formatTimecode(clip.duration_ms)}</span> : <><span className="font-mono tabular" title="Pozycja w filmie źródłowym">
            {formatTimecode(clip.start_time_ms)} – {formatTimecode(clip.end_time_ms)}
          </span>{layout && <span title="Sposób kadrowania klipu"> · {layout}</span>}</>}
        </p>
        <div className="mt-auto grid items-center gap-1 pt-3.5"
          style={{ gridTemplateColumns: `repeat(${2 + (onPost ? 1 : 0) + (libraryActions ? 2 : 0)}, minmax(0, 1fr))` }}>
          <Button size="sm" iconOnly className="w-full" aria-label={`Odtwórz „${title}”`} title="Odtwórz"
            icon={<Play className="h-3.5 w-3.5" fill="currentColor" />} onClick={() => { void openClip() }} />
          {libraryActions}
          {onPost && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              className="w-full"
              aria-label={`Opublikuj „${title}”`}
              title={sentPlatforms ? `Ten klip już wysłano: ${sentPlatforms}. Kliknij, aby otworzyć formularz ponownego wysłania.` : pendingPlatforms ? `Ten klip oczekuje na publikację: ${pendingPlatforms}` : 'Opublikuj w mediach społecznościowych'}
              onClick={onPost}
              icon={<Send className="h-3.5 w-3.5" />}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            className="w-full"
            aria-label={isMac ? "Pokaż w Finderze" : "Pokaż w folderze"}
            title={isMac ? "Pokaż w Finderze" : "Pokaż w folderze"}
            onClick={() => { void showInFolder() }}
            icon={<FolderOpen className="h-3.5 w-3.5" />}
          />
        </div>
        {onEditTimeline && <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={onEditTimeline}>Edytuj klip</Button>}
        {onThumbnail && <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={onThumbnail}>Miniaturka{clip.thumbnail_url ? ' · gotowa' : ''}</Button>}
        {onEditTitle && <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={onEditTitle}>Edytuj tytuł</Button>}
        {!clip.title_base_url && <p className="mt-2 text-2xs text-ink-subtle">Edycja tytułu wymaga zapisanej wersji filmu bez wypalonego tytułu.</p>}
        {actionError && <p role="alert" className="mt-2 text-xs text-danger">{actionError}</p>}
      </div>
    </article>
  )
}
