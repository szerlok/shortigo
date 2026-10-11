import { useRef, useState } from 'react'
import { Trash2, FolderPen } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { useJobStore } from '../store/use-job-store'
import { Button } from './ui/Button'

export function RunFolderActions({ directory, canRename = false, onChanged }: {
  directory: string; canRename?: boolean; onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const act = async (remove: boolean): Promise<void> => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      if (remove) {
        const result = await getApi().history.deleteRun(directory)
        if (!result.deleted) return
        if (result.jobId) useJobStore.getState().remove(result.jobId)
      } else await getApi().history.renameFolder(directory)
      onChanged()
    } catch (e) {
      const message = errorMessage(e, 'Nie udało się zmienić folderu zadania')
      setError(message.includes('No handler registered')
        ? 'Aplikacja działa jeszcze w poprzedniej wersji. Zakończ Shortigo całkowicie (na Macu: ⌘Q), a następnie uruchom ponownie.'
        : message)
    }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="flex flex-wrap items-center gap-1">
    {canRename && <Button size="sm" variant="ghost" disabled={busy} icon={<FolderPen className="h-3.5 w-3.5" />} title="Nazwij folder na dysku według tytułu filmu" onClick={() => { void act(false) }}>Nazwij folder</Button>}
    <Button size="sm" variant="ghost" disabled={busy} icon={<Trash2 className="h-3.5 w-3.5" />} title="Usuń zadanie wraz z całym folderem na dysku" onClick={() => { void act(true) }}>Usuń z dysku</Button>
    {error && <p role="alert" className="w-full text-xs text-danger">{error}</p>}
  </div>
}
