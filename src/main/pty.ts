import { ipcMain, BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import os from 'os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// claude stores each session at ~/.claude/projects/<cwd-with-slashes-as-dashes>/<uuid>.jsonl.
// `--session-id <uuid>` CREATES a session and errors ("already in use") if it exists;
// to continue an existing one you must use `--resume <uuid>`. So when the session file
// already exists, rewrite --session-id → --resume.
function claudeSessionExists(cwd: string, uuid: string): boolean {
  const encoded = cwd.replace(/\//g, '-')
  return existsSync(join(os.homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`))
}

function resolveClaudeArgv(argv: string[], cwd: string): string[] {
  const i = argv.indexOf('--session-id')
  if (i === -1 || !argv[i + 1]) return argv
  const uuid = argv[i + 1]
  if (!claudeSessionExists(cwd, uuid)) return argv
  const out = [...argv]
  out[i] = '--resume'
  return out
}

const ptys = new Map<string, pty.IPty>()
// A pty that was killed but whose process may still be alive (holding e.g. a claude
// --session-id lock). create() awaits this before spawning a new pty with the same id,
// so we never have two claudes on the same session id at once.
const dying = new Map<string, Promise<void>>()
const dyingResolvers = new Map<string, () => void>()

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

function settleDying(id: string): void {
  const resolve = dyingResolvers.get(id)
  if (resolve) {
    dyingResolvers.delete(id)
    dying.delete(id)
    resolve()
  }
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
  function spawnPty(args: CreatePtyArgs): void {
    const file = args.command?.[0] ?? args.shell ?? defaultShell()
    const rawArgv = args.command ? args.command.slice(1) : []
    const argv = resolveClaudeArgv(rawArgv, args.cwd ?? os.homedir())

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
      settleDying(args.id) // unblock any create() waiting on this id to die
    })
  }

  ipcMain.handle('pty:create', async (_e, args: CreatePtyArgs) => {
    if (ptys.has(args.id)) return
    // Wait for a previous instance with the same id to fully exit (releases session lock).
    const d = dying.get(args.id)
    if (d) await d
    if (ptys.has(args.id)) return
    spawnPty(args)
  })

  ipcMain.on('pty:write', (_e, args: { id: string; data: string }) => {
    ptys.get(args.id)?.write(args.data)
  })

  ipcMain.on('pty:kill', (_e, args: { id: string }) => {
    const term = ptys.get(args.id)
    if (!term) return
    ptys.delete(args.id)
    // Register a "dying" promise BEFORE killing so a racing create() awaits the real exit.
    if (!dying.has(args.id)) {
      dying.set(
        args.id,
        new Promise<void>((resolve) => dyingResolvers.set(args.id, resolve))
      )
    }
    // Safety: don't block forever if onExit never fires.
    setTimeout(() => settleDying(args.id), 3000)
    try {
      term.kill()
    } catch {
      settleDying(args.id)
    }
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
