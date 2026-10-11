import { ThumbnailDialog } from '../components/ThumbnailDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Search, Star } from 'lucide-react'
import type { FavoriteClip } from '../../shared/clip-library'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { clipFilePath } from '../lib/thumbnails'
import { ClipCard } from '../components/ClipCard'
import { ClipLibraryActions } from '../components/ClipLibraryActions'
import { TitleEditor } from '../components/TitleEditor'
import { ClipTimelineEditor } from '../components/ClipTimelineEditor'
import { PostDialog, type PostableClip } from '../components/PostDialog'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { EmptyState } from '../components/ui/EmptyState'
import { Button } from '../components/ui/Button'
import { TextInput } from '../components/ui/Field'
import { Callout } from '../components/ui/Callout'
import type { Page as AppPage } from '../components/Sidebar'

export function FavoritesPage({ onNavigate }: { onNavigate: (page: AppPage) => void }): React.JSX.Element {
  const [entries, setEntries] = useState<FavoriteClip[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [posting, setPosting] = useState<PostableClip[] | null>(null)
  const [editing, setEditing] = useState<{ entry: FavoriteClip; kind: 'title' | 'thumbnail' | 'timeline' } | null>(null)
  const request = useRef(0)
  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true); setError(null)
    try {
      const result = await getApi().clips.listFavorites()
      if (id === request.current) setEntries(result)
    } catch (e) {
      if (id === request.current) { setError(errorMessage(e, 'Nie udało się wczytać ulubionych')); setEntries(previous => previous ?? []) }
    } finally { if (id === request.current) setLoading(false) }
  }, [])
  useEffect(() => { void load(); return () => { request.current++ } }, [load])
  const search = query.trim().toLocaleLowerCase('pl')
  const visible = (entries ?? []).filter(e => `${e.sourceTitle} ${e.clip.summary ?? ''}`.toLocaleLowerCase('pl').includes(search))
  const saved = (): void => { setEditing(null); void load() }
  return <Page width="wide">
    <PageHeader eyebrow="Studio" title="Ulubione" description="Klipy oznaczone gwiazdką w Bibliotece."
      actions={<Button disabled={loading} icon={<RefreshCw className="h-4 w-4" />} onClick={() => { void load() }}>Odśwież</Button>} />
    {error && <Callout tone="danger" className="mt-4" onDismiss={() => setError(null)}>{error}</Callout>}
    {entries === null ? <p role="status" className="mt-5 text-ink-muted">Wczytuję ulubione…</p>
      : entries.length === 0 ? <EmptyState className="mt-5" icon={<Star />} title="Brak ulubionych klipów"
        description="Otwórz film w Bibliotece i kliknij gwiazdkę obok odtwarzania wybranego klipu."
        action={<Button onClick={() => onNavigate('library')}>Otwórz bibliotekę</Button>} />
        : <>
          <TextInput className="mt-5 max-w-sm" aria-label="Szukaj ulubionych" placeholder="Szukaj klipu lub filmu źródłowego"
            value={query} onChange={e => setQuery(e.target.value)} leading={<Search className="h-4 w-4" />} />
          <p className="mt-3 text-xs text-ink-muted">Klipy: {visible.length}</p>
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            {visible.map(entry => <div key={`${entry.directory}:${entry.clip.clip_index}`} className="flex min-w-0 flex-col gap-2">
              <p className="truncate text-xs text-ink-muted" title={entry.sourceTitle}>{entry.sourceTitle}</p>
              <ClipCard clip={entry.clip} vertical={entry.vertical} selected={false} selecting={false} allowSelection={false} onToggleSelect={() => {}}
                onPost={() => setPosting([{
                  path: clipFilePath(entry.clip.s3_url),
                  libraryKey: entry.clip.library_key,
                  sentTo: entry.clip.sent_to,
                  title: entry.clip.summary || `Klip ${entry.clip.clip_index + 1}`,
                  tags: entry.clip.tags,
                  durationMs: entry.clip.duration_ms
                }])}
                onThumbnail={() => setEditing({ entry, kind: 'thumbnail' })}
                onEditTitle={entry.clip.title_base_url && entry.clip.title_edit ? () => setEditing({ entry, kind: 'title' }) : undefined}
                onEditTimeline={() => setEditing({ entry, kind: 'timeline' })}
                libraryActions={<ClipLibraryActions directory={entry.directory} clip={entry.clip} onSaved={saved} />} />
            </div>)}
          </div>
          {visible.length === 0 && <p className="mt-4 text-sm text-ink-muted">Brak klipów pasujących do wyszukiwania.</p>}
        </>}
    {editing?.kind === 'thumbnail' && <ThumbnailDialog directory={editing.entry.directory} clip={editing.entry.clip} onClose={() => setEditing(null)} onSaved={() => { void load() }} />}
    {editing?.kind === 'title' && <TitleEditor directory={editing.entry.directory} clip={editing.entry.clip} onClose={() => setEditing(null)} onSaved={saved} />}
    {editing?.kind === 'timeline' && <ClipTimelineEditor directory={editing.entry.directory} clip={editing.entry.clip} onClose={() => setEditing(null)} onSaved={saved} />}
    {posting && <PostDialog clips={posting} onClose={() => setPosting(null)} onNavigate={onNavigate} />}
  </Page>
}
