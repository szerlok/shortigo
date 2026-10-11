import { useCallback, useRef, useState } from 'react'
import { useSetupState } from '../store/use-settings-store'
import { useDraftStore } from '../store/use-draft-store'
import { useJobStore } from '../store/use-job-store'
import { errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import type { ClipJobRequest } from '../../shared/jobs'
import { JobForm } from '../components/JobForm'
import { SetupCard } from '../components/SetupCard'
import { PageHeader } from '../components/ui/PageHeader'
import { Page } from '../components/ui/Page'
import { Callout } from '../components/ui/Callout'
import type { Page as PageId } from '../components/Sidebar'

/**
 * Create: the setup card (until the OpenRouter key exists) and the clipping wizard. Runs go
 * to the main process's queue and are followed on the Jobs page, so this page
 * is always ready for the next video.
 */
export function ClipPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const setup = useSetupState()
  const startingRef = useRef(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const handleSubmit = useCallback(async (config: ClipJobRequest) => {
    if (startingRef.current) return
    startingRef.current = true
    setStarting(true)
    setStartError(null)
    try {
      const result = await getApi().job.start(config)
      if (result.error) setStartError(result.error)
      else if (result.jobId) useDraftStore.getState().markStarted({ jobId: result.jobId, source: config.videoUrl, queued: Boolean(result.queued) })
    } catch (err) {
      setStartError(errorMessage(err, "Nie udało się uruchomić zadania. Spróbuj ponownie."))
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [])

  const viewJob = useCallback((jobId: string) => {
    useJobStore.getState().focusJob(jobId)
    onNavigate('jobs')
  }, [onNavigate])

  const blockedReason =
    setup.missingKeys.length > 0
      ? `Dodaj klucz API ${setup.missingKeys.join(' i ')} powyżej, aby rozpocząć.`
      : setup.toolsOk === false
        ? "Uzupełnij brakujące narzędzia w Ustawieniach, aby rozpocząć."
        : !setup.ready ? "Sprawdzanie wymaganych narzędzi…" : undefined

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Studio"
        title="Utwórz klipy"
        description="Wybierz długi film i ustawienia. Shortigo znajdzie najlepsze fragmenty i przygotuje klipy z napisami."
      />

      <SetupCard className="mt-4" onOpenSettings={() => onNavigate('settings')} />

      {startError && (
        <Callout tone="danger" className="mt-3" onDismiss={() => setStartError(null)}>
          <span className="whitespace-pre-line">{startError}</span>
        </Callout>
      )}

      <JobForm className="mt-4" onSubmit={handleSubmit} onViewJob={viewJob} blockedReason={blockedReason} submitting={starting} />
    </Page>
  )
}
