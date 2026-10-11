import { BrowserWindow, Menu, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { APP_NAME, ISSUES_URL, REPO_URL } from '../shared/brand'
import { getLogFilePath } from './logger'

export function createMenu(mainWindow: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { label: `O ${APP_NAME}`, role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Usługi', role: 'services' as const },
              { type: 'separator' as const },
              { label: `Ukryj ${APP_NAME}`, role: 'hide' as const },
              { label: 'Ukryj pozostałe', role: 'hideOthers' as const },
              { label: 'Pokaż wszystkie', role: 'unhide' as const },
              { type: 'separator' as const },
              { label: `Zakończ ${APP_NAME}`, role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: "Plik",
      submenu: [isMac ? { label: 'Zamknij okno', role: 'close' as const } : { label: `Zakończ ${APP_NAME}`, role: 'quit' as const }]
    },
    {
      label: "Edytuj",
      submenu: [
        { label: 'Cofnij', role: 'undo' as const },
        { label: 'Ponów', role: 'redo' as const },
        { type: 'separator' as const },
        { label: 'Wytnij', role: 'cut' as const },
        { label: 'Kopiuj', role: 'copy' as const },
        { label: 'Wklej', role: 'paste' as const },
        { label: 'Zaznacz wszystko', role: 'selectAll' as const }
      ]
    },
    {
      label: "Pokaż",
      submenu: [
        { label: 'Odśwież', role: 'reload' as const },
        { label: 'Wymuś odświeżenie', role: 'forceReload' as const },
        { label: 'Narzędzia programisty', role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { label: 'Rozmiar rzeczywisty', role: 'resetZoom' as const },
        { label: 'Powiększ', role: 'zoomIn' as const },
        { label: 'Pomniejsz', role: 'zoomOut' as const },
        { type: 'separator' as const },
        { label: 'Pełny ekran', role: 'togglefullscreen' as const }
      ]
    },
    {
      label: "Pomoc",
      submenu: [
        ...(!is.dev
          ? [
              {
                label: "Sprawdź aktualizacje…",
                click: (): void => {
                  autoUpdater.checkForUpdates().catch(() => {})
                }
              },
              { type: 'separator' as const }
            ]
          : []),
        {
          label: `${APP_NAME} na GitHubie`,
          click: (): void => {
            shell.openExternal(REPO_URL)
          }
        },
        {
          label: "Zgłoś problem…",
          click: (): void => {
            shell.openExternal(ISSUES_URL)
          }
        },
        { type: 'separator' as const },
        {
          label: "Pokaż dziennik",
          click: (): void => {
            shell.showItemInFolder(getLogFilePath())
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const items: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [
          { label: 'Wytnij', role: 'cut', enabled: Boolean(params.selectionText) },
          { label: 'Kopiuj', role: 'copy', enabled: Boolean(params.selectionText) },
          { label: 'Wklej', role: 'paste' },
          { type: 'separator' },
          { label: 'Zaznacz wszystko', role: 'selectAll' }
        ]
      : [{ label: 'Kopiuj', role: 'copy' }]
    Menu.buildFromTemplate(items).popup({ window: mainWindow })
  })

  mainWindow.setTitle(APP_NAME)
}
