import { Menu, dialog, BrowserWindow, app, type MenuItemConstructorOptions } from 'electron'
import { getDevInfo } from './dev-rebuild'
import { getBuildInfo } from '@decky/shared'

export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin'
  const devInfo = getDevInfo()
  const build = getBuildInfo()

  const sendToRenderer = (channel: string, payload?: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const openFolderAction = async (): Promise<void> => {
    const win = getWindow()
    if (!win) return
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open Folder as Workspace',
      buttonLabel: 'Open in decky'
    })
    if (!result.canceled && result.filePaths[0]) {
      win.webContents.send('session:add', { cwd: result.filePaths[0], kind: 'claude' })
    }
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),

    {
      label: 'File',
      submenu: [
        {
          // Accelerator on the native menu (not the renderer's keydown) so the OS intercepts
          // the chord BEFORE handing input to any focused webContents — works over a PDF
          // viewer, terminal, web card, etc. The renderer's capture-phase keydown is now
          // unreachable for this chord on focused web cards/PDFs, which is the point.
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('menu:new-session')
        },
        { type: 'separator' },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void openFolderAction()
          }
        },
        {
          // Add server (SSH remote). Mesmo padrão do VS Code Remote-SSH — vive ao lado do
          // Open Folder. Cmd+Shift+O espelha Cmd+O (mesma família de "abrir lugar pra trabalhar").
          label: 'Connect to Server…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendToRenderer('menu:add-server')
        },
        { type: 'separator' },
        {
          label: 'Close Session',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendToRenderer('menu:close-tab')
        },
        ...(!isMac
          ? ([{ type: 'separator' }, { role: 'quit' }] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find in Cards…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendToRenderer('menu:toggle-find')
        }
      ]
    },

    {
      label: 'Go',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendToRenderer('menu:toggle-palette')
        }
      ]
    },

    {
      label: 'Settings',
      submenu: [
        {
          label: 'CLIs de IA…',
          click: () => sendToRenderer('menu:open-cli-settings')
        }
      ]
    },

    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(devInfo.enabled
          ? ([
              { type: 'separator' },
              {
                // Append the running build sha so a glance answers "this app is at HEAD or behind?".
                label: `Rebuild & relaunch  (${build.sha})`,
                accelerator: devInfo.accel,
                click: () => sendToRenderer('menu:dev-rebuild')
              }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },

    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}
