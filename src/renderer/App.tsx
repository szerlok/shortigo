import { useEffect, useState } from 'react'
import { Layout } from './components/Layout'
import { NAV_ITEMS, SIDEBAR_SHORTCUT_KEY, type Page } from './components/Sidebar'
import { ClipPage } from './pages/ClipPage'
import { LibraryPage } from './pages/LibraryPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { JobsPage } from './pages/JobsPage'
import { SettingsPage } from './pages/SettingsPage'
import { AccountsPage } from './pages/AccountsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { UpdateModal } from './components/UpdateModal'
import { ShortigoLogo } from './components/brand/ShortigoLogo'
import { useSettingsStore } from './store/use-settings-store'
import { useJobStore } from './store/use-job-store'
import { usePostsStore } from './store/use-posts-store'
import { useSidebarStore } from './store/use-sidebar-store'
import { Button } from './components/ui/Button'
import { getApi } from './lib/ipc'

export default function App(): React.JSX.Element {
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [page, setPage] = useState<Page>('clip')

  const loadSettings = useSettingsStore((s) => s.load)
  const checkTools = useSettingsStore((s) => s.checkTools)
  const settingsLoaded = useSettingsStore((s) => s.loaded)

  useEffect(() => {
    const load = (): void => { void usePostsStore.getState().load().then(() => usePostsStore.getState().refresh(false)) }
    load()
    window.addEventListener('focus', load)
    const timer = setInterval(() => {
      const state = usePostsStore.getState()
      if (document.visibilityState === 'visible' && state.posts.some(p => p.status === 'publishing' || p.status === 'scheduled')) void state.refresh(false)
    }, 60_000)
    return () => { window.removeEventListener('focus', load); clearInterval(timer) }
  }, [])

  useEffect(() => {
    setLoadError(false)
    void loadSettings().then(() => checkTools()).catch(() => setLoadError(true))
  }, [loadSettings, checkTools, retry])

  // The main process owns the job list. Subscribe first, then load the list,
  // so a reload or reopened window picks up jobs that are still running.
  useEffect(() => {
    const api = getApi()
    const unsubscribe = api.job.onUpdate((job) => useJobStore.getState().upsert(job))
    void api.job.list().then((jobs) => useJobStore.getState().hydrate(jobs)).catch(() => {})
    return unsubscribe
  }, [])

  // ⌘1 Create, ⌘2 Library, ⌘3 History, ⌘4 Accounts, ⌘5 Automations, ⌘, Settings,
  // ⌘\ collapse or expand the sidebar (Ctrl on Windows/Linux).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === SIDEBAR_SHORTCUT_KEY) {
        e.preventDefault()
        useSidebarStore.getState().toggle()
        return
      }
      const item = NAV_ITEMS.find((n) => n.shortcut === e.key)
      if (item) {
        e.preventDefault()
        setPage(item.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Each page starts at the top.
  useEffect(() => {
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }, [page])

  return (
    <>
      {settingsLoaded ? (
        <Layout currentPage={page} onNavigate={setPage}>
          {page === 'clip' && <ClipPage onNavigate={setPage} />}
          {page === 'library' && <LibraryPage onNavigate={setPage} />}
          {page === 'favorites' && <FavoritesPage onNavigate={setPage} />}
          {page === 'jobs' && <JobsPage onNavigate={setPage} />}
          {page === 'accounts' && <AccountsPage onNavigate={setPage} />}
          {page === 'automations' && <AutomationsPage onNavigate={setPage} />}
          {page === 'settings' && <SettingsPage />}
        </Layout>
      ) : (
        <div className="app-backdrop drag flex h-screen items-center justify-center">
          {loadError ? (
            <div className="glass no-drag space-y-3 rounded-3xl px-5 py-5 text-center animate-pop-in">
              <p role="alert" className="text-sm text-danger">Nie udało się wczytać ustawień. Spróbuj ponownie.</p>
              <Button onClick={() => setRetry((value) => value + 1)}>Ponów</Button>
            </div>
          ) : <ShortigoLogo className="h-7 animate-pulse opacity-80" />}
        </div>
      )}
      <UpdateModal />
    </>
  )
}
