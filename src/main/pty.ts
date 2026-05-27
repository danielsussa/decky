import { ipcMain, BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import os from 'os'

const ptys = new Map<string, pty.IPty>()

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export interface CreatePtyArgs {
  id: string
  cwd?: string
  cols: number
  rows: number
  shell?: string
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:create', (_e, args: CreatePtyArgs) => {
    if (ptys.has(args.id)) return

    const term = pty.spawn(args.shell ?? defaultShell(), [], {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd ?? os.homedir(),
      env: process.env as { [key: string]: string }
    })

    ptys.set(args.id, term)

    term.onData((data) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send('pty:data', { id: args.id, data })
    })

    term.onExit(({ exitCode }) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', { id: args.id, code: exitCode })
      }
      ptys.delete(args.id)
    })
  })

  ipcMain.on('pty:write', (_e, args: { id: string; data: string }) => {
    ptys.get(args.id)?.write(args.data)
  })

  ipcMain.on('pty:resize', (_e, args: { id: string; cols: number; rows: number }) => {
    try {
      ptys.get(args.id)?.resize(args.cols, args.rows)
    } catch {
      // pty may have exited between resize observation and dispatch
    }
  })

  ipcMain.on('pty:kill', (_e, args: { id: string }) => {
    ptys.get(args.id)?.kill()
    ptys.delete(args.id)
  })
}

export function killAllPtys(): void {
  for (const term of ptys.values()) {
    try {
      term.kill()
    } catch {
      // already dead
    }
  }
  ptys.clear()
}
