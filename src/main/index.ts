import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { buildMenu } from './menu'
import { registerPtyHandlers, killAllPtys } from './pty'
import {
  startPreviewServer,
  stopPreviewServer,
  getPreviewSource,
  getSessionTitles
} from './preview-server'
import { ensureDeckMcpRegistered } from './mcp-installer'
import { ensureDeckInstruction } from './claude-md-installer'
import { resolveClaudeBin } from './claude-bin'
import { registerStateHandlers } from './state-store'

let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'deck',
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
app.whenReady().then(() => {
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
  startPreviewServer(() => mainWindow)

  ipcMain.handle('preview:get-current', () => getPreviewSource())
  ipcMain.handle('claude:get-bin', () => resolveClaudeBin())
  ipcMain.handle('sessions:get-titles', () => getSessionTitles())
  ipcMain.handle('app:get-startup-cwd', () => process.cwd())

  const dkMcpPath = join(app.getAppPath(), 'bin', 'dk-mcp')
  void ensureDeckMcpRegistered(dkMcpPath).catch((err) => {
    console.warn('[mcp-installer] failed to register:', err)
  })
  void ensureDeckInstruction().catch((err) => {
    console.warn('[claude-md-installer] failed to write CLAUDE.md:', err)
  })

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
