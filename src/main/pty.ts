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
  /** Custom command to spawn. If set, takes precedence over shell. command[0] = file, rest = args. */
  command?: string[]
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:create', (_e, args: CreatePtyArgs) => {
    if (ptys.has(args.id)) return

    const file = args.command?.[0] ?? args.shell ?? defaultShell()
    const argv = args.command ? args.command.slice(1) : []

    const term = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd ?? os.homedir(),
      env: {
        ...(process.env as { [key: string]: string }),
        DECK_SESSION_ID: args.id,
        DECK_URL: process.env.DECK_URL || 'http://127.0.0.1:6790'
      }
    })

    ptys.set(args.id, term)

    // Watch the first ~2 KB for a "Session ID … is already in use" error from `claude --session-id`.
    // If we see it, signal renderer to regen the UUID and remount.
    let conflictChecked = false
    let earlyBuf = ''
    term.onData((data) => {
      if (!conflictChecked) {
        earlyBuf += data
        if (earlyBuf.includes('is already in use')) {
          conflictChecked = true
          const win = getWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('session:uuid-conflict', { id: args.id })
          }
        } else if (earlyBuf.length > 2048) {
          conflictChecked = true
          earlyBuf = ''
        }
      }
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

  ipcMain.on('pty:kill', (_e, args: { id: string }) => {
    ptys.get(args.id)?.kill()
    ptys.delete(args.id)
  })

  ipcMain.on('pty:resize', (_e, args: { id: string; cols: number; rows: number }) => {
    try {
      ptys.get(args.id)?.resize(args.cols, args.rows)
    } catch {
      // pty may have exited between resize observation and dispatch
    }
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
