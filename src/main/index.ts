import { app, shell, BrowserWindow, ipcMain, Menu, dialog } from 'electron'
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
import { migrateGlobalState } from './migrate'
import { registerFileWatchHandlers } from './file-watcher'
import { ensureDeckMcpRegistered } from './mcp-installer'
import { ensureDeckInstruction } from './claude-md-installer'
import { resolveClaudeBin, readAiTitle } from './claude-bin'
import { registerStateHandlers } from './state-store'

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

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
  // Migrate pre-rename data (~/.deck → ~/.decky) BEFORE the renderer reads any state.
  await migrateGlobalState()

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
  registerWorkspaceHandlers()
  registerCardsHandlers()
  registerFileWatchHandlers(() => mainWindow)
  startPreviewServer(() => mainWindow)

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

  ipcMain.handle('preview:get-all', () => getPreviewSources())
  ipcMain.handle('preview:rehydrate', (_e, byCard) => rehydratePreviews(byCard))
  ipcMain.handle('claude:get-bin', () => resolveClaudeBin())
  ipcMain.handle('claude:ai-title', (_e, cwd: string, uuid: string) => readAiTitle(cwd, uuid))
  ipcMain.handle('sessions:get-titles', () => getSessionTitles())
  ipcMain.handle('app:get-startup-cwd', () => process.cwd())

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

  // Packaged macOS apps use build/icon.icns; in dev the dock falls back to the
  // default Electron icon unless we set it explicitly.
  if (process.platform === 'darwin') app.dock?.setIcon(icon)

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  killAllPtys()
  stopPreviewServer()
})

process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
