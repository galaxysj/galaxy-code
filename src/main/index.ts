import { app, BrowserWindow, Menu, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'
import type { UiEvent } from '@shared/types'
import { manager } from './agent/manager'
import { disposeAllAcp } from './engines/acp'
import { disposeAllCodex } from './engines/codex'
import { registerIpc } from './ipc'
import { bridge } from './services/bridge'
import { browser } from './services/browser'
import { mcp } from './services/mcp'
import { store } from './store'
import { killBackgroundProcesses } from './tools/shell'
import { terminals } from './services/terminal'
import { hydrateShellPath } from './util'

app.setName('Galaxy Code')

let mainWindow: BrowserWindow | null = null
const windows = new Map<number, BrowserWindow>()
let emitUi: (event: UiEvent) => void = () => {}
let trackWindow: (window: BrowserWindow) => void = () => {}

function currentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && windows.has(focused.id)) return focused
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return [...windows.values()].find((win) => !win.isDestroyed()) ?? null
}

function dispatchMenu(action: Extract<UiEvent, { type: 'menu' }>['action']): void {
  if (!currentWindow()) createWindow()
  emitUi({ type: 'menu', action })
}

const isDev = !!process.env.ELECTRON_RENDERER_URL
const iconPath = join(__dirname, '../../resources/icon.png')

function backgroundColor(): string {
  const theme = store.settings.theme
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? '#141414' : '#f7f7f6'
}

// Mica is supported starting with Windows 11 build 22000.
const sidebarMaterial = process.platform === 'darwin' ? 'blur'
  : process.platform === 'win32' && Number(release().split('.')[2]) >= 22000 ? 'mica' : 'none'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Galaxy Code',
    backgroundColor: sidebarMaterial === 'none' ? backgroundColor() : '#00000000',
    ...(sidebarMaterial === 'blur' ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const } : {}),
    ...(sidebarMaterial === 'mica' ? { backgroundMaterial: 'mica' as const } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 17 },
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      additionalArguments: [`--galaxy-sidebar-material=${sidebarMaterial}`],
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  windows.set(win.id, win)
  mainWindow = win
  browser.attach(win)
  trackWindow(win)

  win.once('ready-to-show', () => win.show())
  win.on('focus', () => { mainWindow = win })
  win.on('closed', () => {
    windows.delete(win.id)
    if (mainWindow === win) mainWindow = [...windows.values()].find((entry) => !entry.isDestroyed()) ?? null
  })

  // The app shell never navigates; links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Galaxy Code',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => dispatchMenu('settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: createWindow },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: createWindow },
        ...(isMac ? [] : [{ label: 'Settings', accelerator: 'Ctrl+,', click: () => dispatchMenu('settings') } as MenuItemConstructorOptions]),
        { type: 'separator' },
        { role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Open Files', accelerator: 'CmdOrCtrl+B', click: () => dispatchMenu('open-files') },
        { label: 'Open Browser', accelerator: 'CmdOrCtrl+Shift+B', click: () => dispatchMenu('open-browser') },
        { label: 'Open Terminal', accelerator: 'CmdOrCtrl+J', click: () => dispatchMenu('open-terminal') },
        { label: 'Toggle Sidebar', click: () => dispatchMenu('toggle-sidebar') },
        { label: 'Toggle Side Panel', accelerator: 'CmdOrCtrl+Alt+B', click: () => dispatchMenu('toggle-panel') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'reload' } as MenuItemConstructorOptions, { role: 'toggleDevTools' } as MenuItemConstructorOptions] : [])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Two instances would write the same chat and settings files.
  console.error('\nGalaxy Code is already running, so this instance is exiting. Quit the other one first (including a packaged build).\n')
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = currentWindow()
    if (!win) { createWindow(); return }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  void app.whenReady().then(async () => {
    await hydrateShellPath()
    store.init()
    if (process.platform === 'darwin' && isDev) app.dock?.setIcon(nativeImage.createFromPath(iconPath))

    const ipc = registerIpc(currentWindow, () => [...windows.values()], createWindow)
    emitUi = ipc.emitUi
    trackWindow = ipc.trackWindow
    buildMenu()
    createWindow()
    void mcp.sync()

    app.on('activate', () => {
      if (windows.size === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    manager.stopAll()
    store.flushSync()
    killBackgroundProcesses()
    terminals.closeAll()
    disposeAllCodex()
    disposeAllAcp()
    bridge.shutdown()
    void mcp.shutdown()
  })
}
