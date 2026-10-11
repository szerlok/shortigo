import { useRef, useState } from 'react'
import { Star, Trash2 } from 'lucide-react'
import type { ClipArtifact, JobOutput } from '../../shared/job-output'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { Button } from './ui/Button'

export function ClipLibraryActions({ directory, clip, onSaved }: {
  directory: string; clip: ClipArtifact; onSaved: (output: JobOutput) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const act = async (remove: boolean): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      const output = remove ? await getApi().clips.delete(directory, clip.clip_index)
        : await getApi().clips.setFavorite(directory, clip.clip_index, !clip.is_favorite)
      if (output) onSaved(output)
    } catch (e) {
      const message = errorMessage(e, 'Nie udało się zapisać zmiany')
      setError(message.includes('No handler registered')
        ? 'Zakończ aplikację przez ⌘Q i uruchom ponownie, aby wczytać nową wersję.' : message)
    } finally { pending.current = false; setBusy(false) }
  }
  return <>
    <Button size="sm" variant="ghost" iconOnly className="w-full" disabled={busy} aria-pressed={!!clip.is_favorite}
      aria-label={clip.is_favorite ? 'Usuń z ulubionych' : 'Dodaj do ulubionych'}
      title={clip.is_favorite ? 'Usuń z ulubionych' : 'Dodaj do ulubionych'}
      icon={<Star className={clip.is_favorite ? 'h-3.5 w-3.5 fill-brand-gold text-brand-gold' : 'h-3.5 w-3.5'} />}
      onClick={() => { void act(false) }} />
    <Button size="sm" variant="ghost" iconOnly className="w-full" disabled={busy} aria-label="Usuń klip" title="Usuń klip"
      icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { void act(true) }} />
    {error && <p role="alert" className="order-last col-span-full text-xs text-danger">{error}</p>}
  </>
}
