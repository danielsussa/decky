import { diag, installCrashLogging } from './diag'
installCrashLogging()
import { app, shell, BrowserWindow, ipcMain, Menu, Notification, dialog } from 'electron'
import { join } from 'path'
import { existsSync, statSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildMenu } from './menu'
import { registerPtyHandlers, killAllPtys } from './pty'
import {
  startPreviewServer,
  stopPreviewServer,
  getPreviewSources,
  getSessionTitles,
  rehydratePreviews
} from './preview-server'
import { registerWorkspaceHandlers } from './workspace-store'
import { registerCardsHandlers } from './cards-store'
import { startDeckyHandoffBackend } from './handoff-backend'
import { registerCardMirrorHandlers } from './card-mirror'
import { registerWidgetBridge } from './widget-bridge'
import { migrateGlobalState } from './migrate'
import { registerFileWatchHandlers } from './file-watcher'
import { ensureDeckMcpRegistered } from './mcp-installer'
import { ensureDeckInstruction } from './claude-md-installer'
import { ensureDeckyHooks } from './hooks-installer'
import { resolveClaudeBin, readAiTitle } from './claude-bin'
import { initCliPaths } from './cli-paths'
import { registerStateHandlers } from './state-store'
import { registerCliHandlers } from './cli-handlers'
import { registerDevRebuildHandlers } from './dev-rebuild'
import { registerGitHandlers } from './git-stats'
import { registerAssetScheme, setupAssetProtocol } from './asset-protocol'
import { setupWebSession, attachWebContentsPopupRouter } from './web-session'
import { setupWebViews } from './web-views'

// Privileged scheme registration must happen before app is ready.
registerAssetScheme()

let mainWindow: BrowserWindow | null = null

// DECKY_DEV runs a fully isolated dev instance alongside the installed app: its own name +
// userData (→ separate single-instance lock, so both run), paired with DECKY_STATE_DIR /
// DECKY_PREVIEW_PORT / DECKY_URL from the `dev` script. Must run BEFORE the lock below,
// since requestSingleInstanceLock keys off userData.
if (process.env.DECKY_DEV) {
  app.setName('decky-dev')
  app.setPath('userData', join(app.getPath('appData'), 'decky-dev'))
}

// Single instance is the design: a relaunch (e.g. `decky ~/proj`) routes the folder
// into the running window as a workspace instead of spawning a second process.
function firstDirArg(argv: string[], fallbackCwd: string): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i]
    if (a.startsWith('-')) continue
    try {
      if (existsSync(a) && statSync(a).isDirectory()) return a
    } catch {
      // not a path
    }
  }
  return existsSync(fallbackCwd) ? fallbackCwd : null
}

function routeFolderToWindow(dir: string | null): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  if (dir) mainWindow.webContents.send('session:add', { cwd: dir, kind: 'claude' })
}

diag('requesting single-instance lock')
const gotLock = app.requestSingleInstanceLock()
diag(`gotLock=${gotLock}`)
if (!gotLock) {
  // Another instance already holds the lock — the running one will get our argv via
  // 'second-instance' and route the folder into its window, so we exit. Log it: this is the
  // ONE startup path that quits before any other output, so a silent exit here is what makes
  // a stale/zombie holder look like "decky opens and does nothing". Never let it be silent.
  console.error('[decky] another instance already holds the single-instance lock — exiting.')
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    routeFolderToWindow(firstDirArg(argv, workingDirectory))
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'decky',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e2330',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Route link clicks from anywhere in the renderer (markdown card, terminal weblinks, etc.)
  // into our internal web card instead of the OS browser. setWindowOpenHandler covers
  // window.open + target="_blank"; will-navigate covers plain <a href> clicks (without it
  // they'd navigate the WHOLE decky window away from the app shell). Non-http schemes and
  // explicit "open external" affordances still go through shell.openExternal via the
  // 'app:open-external' IPC.
  const routeToInternal = (url: string): void => {
    if (!/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => {})
      return
    }
    mainWindow?.webContents.send('app:open-url', url)
  }
  mainWindow.webContents.setWindowOpenHandler((details) => {
    routeToInternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Same-origin navigation = app shell itself (HMR, dev reload, file:// reload). Let it through.
    try {
      const current = mainWindow?.webContents.getURL() ?? ''
      if (current && new URL(url).origin === new URL(current).origin) return
    } catch {
      return
    }
    e.preventDefault()
    routeToInternal(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  diag('whenReady fired')
  // Migrate pre-rename data (~/.deck → ~/.decky) BEFORE the renderer reads any state.
  await migrateGlobalState()
  diag('migrateGlobalState done')

  // Hydrate custom CLI paths before any cli:list call can race the renderer mount.
  await initCliPaths()
  diag('initCliPaths done')

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  Menu.setApplicationMenu(buildMenu(() => mainWindow))

  registerPtyHandlers(() => mainWindow)
  registerStateHandlers()
  registerCliHandlers()
  registerWorkspaceHandlers()
  registerCardsHandlers()
  registerCardMirrorHandlers(() => mainWindow)
  registerWidgetBridge(() => mainWindow)
  registerFileWatchHandlers(() => mainWindow)
  registerDevRebuildHandlers(() => mainWindow)
  registerGitHandlers()
  setupAssetProtocol()
  // Global default UA: strip the Electron/app token so any web surface that falls back to it
  // (a popup in the instant before the deckweb partition UA applies) still reads as plain Chrome.
  // The per-partition setUserAgent in setupWebSession is the main path; this is the safety net.
  app.userAgentFallback = app.userAgentFallback
    .replace(`Electron/${process.versions.electron}`, '')
    .replace(`${app.getName()}/${app.getVersion()}`, '')
    .replace(/\s+/g, ' ')
    .trim()
  setupWebSession(() => mainWindow)
  attachWebContentsPopupRouter(() => mainWindow)
  setupWebViews(() => mainWindow)
  diag('handlers registered, starting preview server')
  startPreviewServer(() => mainWindow)
  // Backend do handoff: socket falando o protocolo contra o card web focado, pro sdk/adapters/MCP
  // do handoff dirigirem o mesmo card logado que o usuário vê. Opt-OUT via DECKY_NO_HANDOFF=1.
  if (!process.env.DECKY_NO_HANDOFF) startDeckyHandoffBackend()

  ipcMain.handle('dialog:pick-folder', async () => {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Adicionar pasta de trabalho'
    }
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:pick-file', async (_e, title?: string) => {
    const opts: Electron.OpenDialogOptions = {
      // showHiddenFiles so users can navigate into ~/.local/bin etc.
      properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
      title: title ?? 'Escolher executável'
    }
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // Native desktop notification for "sessão terminou de processar". Renderer fires this when a
  // session transitions from working → idle and the user isn't looking (different session OR
  // window unfocused). Clicking the notification brings the app forward and tells the renderer
  // which session to switch to.
  ipcMain.handle(
    'notify:show',
    (_e, payload: { id: string; title: string; body?: string }) => {
      const supported = Notification.isSupported()
      console.log('[notify] handler called', { supported, payload })
      if (!supported) return
      const n = new Notification({
        title: payload.title,
        body: payload.body ?? '',
        silent: false
      })
      n.on('show', () => console.log('[notify] shown', payload.id))
      n.on('failed', (_evt, err) => console.error('[notify] failed', err))
      n.on('click', () => {
        console.log('[notify] clicked', payload.id)
        const win = mainWindow
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        if (process.platform === 'darwin') app.focus({ steal: true })
        win.webContents.send('notify:focus-session', { id: payload.id })
      })
      n.show()
    }
  )

  ipcMain.handle('preview:get-all', () => getPreviewSources())
  ipcMain.handle('preview:rehydrate', (_e, byCard, workspace?: string) =>
    rehydratePreviews(byCard, workspace)
  )
  ipcMain.handle('claude:get-bin', () => resolveClaudeBin())
  ipcMain.handle('claude:ai-title', (_e, cwd: string, uuid: string) => readAiTitle(cwd, uuid))
  ipcMain.handle('sessions:get-titles', () => getSessionTitles())
  ipcMain.handle('app:get-startup-cwd', () => process.cwd())
  // Explicit "open in the OS browser" affordance — used by the external-link button on the
  // web card, since every other window.open in the renderer now routes to an internal card.
  ipcMain.handle('app:open-external', (_e, url: string) => shell.openExternal(url))

  // Packaged: getAppPath() is .../app.asar, but claude spawns dk-mcp with a plain
  // `node` (no asar support), so point at the unpacked copy (see asarUnpack bin/**).
  const appBase = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
  const dkMcpPath = join(appBase, 'bin', 'dky-mcp')
  void ensureDeckMcpRegistered(dkMcpPath).catch((err) => {
    console.warn('[mcp-installer] failed to register:', err)
  })
  void ensureDeckInstruction().catch((err) => {
    console.warn('[claude-md-installer] failed to write CLAUDE.md:', err)
  })
  void ensureDeckyHooks().catch((err) => {
    console.warn('[hooks-installer] failed to write settings.json:', err)
  })

  // Packaged macOS apps use build/icon.icns; in dev the dock falls back to the
  // default Electron icon unless we set it explicitly.
  if (process.platform === 'darwin') app.dock?.setIcon(icon)

  diag('creating window')
  createWindow()
  diag('createWindow returned')

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  diag('whenReady handler completed')
}).catch((err) => {
  diag(`whenReady REJECTED: ${err?.stack || err}`)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Block the actual exit until the renderer flushes the current workspace state — otherwise
// the debounced save (400ms) drops the tail and a just-created session is lost on quit.
let didFlush = false
app.on('before-quit', (e) => {
  if (didFlush) return // second pass (after flush) — let the quit proceed
  didFlush = true
  killAllPtys()
  stopPreviewServer()
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  e.preventDefault()
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    ipcMain.removeListener('app:flush-done', finish)
    app.quit() // re-quit; didFlush is now true so this pass falls through
  }
  ipcMain.once('app:flush-done', finish)
  win.webContents.send('app:flush')
  setTimeout(finish, 1500) // safety: never hang quit if the renderer can't ack
})

process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
