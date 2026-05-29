import { ipcMain, BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import os from 'os'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeTranscript } from './transcript-repair'
import { workspaceCardsDir } from './paths'

// claude stores each session at ~/.claude/projects/<cwd-with-slashes-as-dashes>/<uuid>.jsonl.
// `--session-id <uuid>` CREATES a session and errors ("already in use") if it exists;
// to continue an existing one you must use `--resume <uuid>`. So when the session file
// already exists, rewrite --session-id → --resume.
function claudeSessionExists(cwd: string, uuid: string): boolean {
  const encoded = cwd.replace(/\//g, '-')
  return existsSync(join(os.homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`))
}

function sessionUuidFromArgv(argv: string[]): string | null {
  const i = argv.indexOf('--session-id')
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null
}

function resolveClaudeArgv(argv: string[], cwd: string): string[] {
  const i = argv.indexOf('--session-id')
  if (i === -1 || !argv[i + 1]) return argv
  const uuid = argv[i + 1]
  if (!claudeSessionExists(cwd, uuid)) return argv
  // Heal any poisoned thinking blocks before resuming (see transcript-repair.ts).
  try {
    const removed = sanitizeTranscript(cwd, uuid)
    if (removed)
      console.log(
        `[transcript-repair] healed ${removed} entr${removed === 1 ? 'y' : 'ies'} in ${uuid}`
      )
  } catch (err) {
    console.warn('[transcript-repair] failed:', err)
  }
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

// Auto-recovery for the claude-code "thinking blocks cannot be modified" 400 (a known
// upstream bug that freezes the whole thread). When we see it in a session's output we
// kill + resume that session: the resume reruns sanitizeTranscript, which strips the
// poisoned thinking block so the thread un-freezes.
const recovering = new Set<string>()
const spawnArgs = new Map<string, CreatePtyArgs>()
const recoverHistory = new Map<string, { firstAt: number; count: number }>()
const RECOVER_WINDOW_MS = 120_000
const MAX_RECOVERIES = 2

// Distinctive phrase from the API error, matched after stripping ANSI + collapsing
// whitespace so terminal formatting / line wraps don't defeat it.
const THINKING_ERR = /blocks in the latest assistant message cannot be modified/i
// eslint-disable-next-line no-control-regex -- intentionally stripping ANSI/control bytes
const ANSI_CONTROL = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x09\x0b-\x1f]/g
function normalizeForMatch(s: string): string {
  return s.replace(ANSI_CONTROL, ' ').replace(/\s+/g, ' ')
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

let cachedPath: string | null = null
// macOS GUI apps (launched from Finder/Dock) inherit the minimal launchd PATH —
// /usr/bin:/bin:/usr/sbin:/sbin — missing Homebrew/nvm/asdf dirs. The claude we
// spawn then can't find `node`/`npx`, which silently breaks (a) the MCP servers
// claude spawns with `command:"node"` (tools never register) and (b) any
// `node`/`npx tsx` the agent runs via Bash (e.g. bin/handoff). Resolve the
// user's real login-shell PATH once and merge it in; fall back to prepending
// the common install dirs if the login shell can't be queried.
function loginShellPath(): string {
  if (cachedPath) return cachedPath
  const shell = process.env.SHELL || '/bin/zsh'
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', join(os.homedir(), '.local', 'bin')]
  let resolved = ''
  try {
    resolved = execSync(`${shell} -lc 'echo $PATH'`, { encoding: 'utf-8', timeout: 3000 }).trim()
  } catch {
    // login shell unavailable — fall back to the common dirs below
  }
  // Order: login-shell PATH first (user's preferred toolchain wins), then the
  // fallback dirs, then whatever the GUI process already had. Set dedups.
  const parts = new Set<string>()
  for (const p of resolved.split(':')) if (p) parts.add(p)
  for (const p of fallback) parts.add(p)
  for (const p of (process.env.PATH || '').split(':')) if (p) parts.add(p)
  cachedPath = Array.from(parts).join(':')
  return cachedPath
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
  function sendToTerminal(id: string, data: string): void {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data })
  }

  function notify(id: string, msg: string): void {
    sendToTerminal(id, `\r\n\x1b[2m[decky] ${msg}\x1b[0m\r\n`)
  }

  // Graceful kill that lets a racing create() await the real exit (releases the session
  // lock). SIGTERM first so claude can flush its transcript; SIGKILL only if it ignores us.
  function killGraceful(id: string, term: pty.IPty): void {
    if (!dying.has(id)) {
      dying.set(id, new Promise<void>((resolve) => dyingResolvers.set(id, resolve)))
    }
    let exited = false
    dying.get(id)?.then(() => {
      exited = true
    })
    setTimeout(() => settleDying(id), 3000)
    try {
      term.kill('SIGTERM')
      setTimeout(() => {
        if (exited) return
        try {
          term.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, 1500)
    } catch {
      settleDying(id)
    }
  }

  function triggerRecovery(id: string): void {
    if (recovering.has(id)) return
    // Only resume sessions we know how to (a claude --session-id), and only if the
    // transcript exists for the repair to act on.
    const args = spawnArgs.get(id)
    const uuid = args?.command ? sessionUuidFromArgv(args.command.slice(1)) : null
    if (!args || !uuid || !claudeSessionExists(args.cwd ?? os.homedir(), uuid)) return

    const now = Date.now()
    const h = recoverHistory.get(id)
    if (h && now - h.firstAt < RECOVER_WINDOW_MS) {
      if (h.count >= MAX_RECOVERIES) {
        notify(
          id,
          'bug de thinking-block reincidente — reinicie a sessão manualmente (o repair não resolveu)'
        )
        return
      }
      h.count++
    } else {
      recoverHistory.set(id, { firstAt: now, count: 1 })
    }

    recovering.add(id)
    notify(id, 'bug de thinking-block detectado — auto-recuperando a sessão (kill + resume)…')
    const term = ptys.get(id)
    if (!term) {
      recovering.delete(id)
      return
    }
    // onExit respawns when it sees recovering.has(id).
    ptys.delete(id)
    killGraceful(id, term)
  }

  function spawnPty(args: CreatePtyArgs): void {
    spawnArgs.set(args.id, args)
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
        // GUI launch gives us launchd's minimal PATH; restore the user's real
        // PATH so claude (and the MCP servers + node/npx it spawns) find node.
        PATH: loginShellPath(),
        DECKY_SESSION_ID: args.id,
        DECKY_URL: process.env.DECKY_URL || 'http://127.0.0.1:6790',
        // Where this workspace's shared card .md files live, so the bot can Glob/Read them.
        DECKY_CARDS_DIR: workspaceCardsDir(args.cwd ?? os.homedir())
      }
    })

    ptys.set(args.id, term)

    let conflictChecked = false
    let earlyBuf = ''
    let errBuf = ''
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
      // Watch the stream for the thinking-block 400 (rolling, ANSI-tolerant buffer).
      if (!recovering.has(args.id)) {
        errBuf = normalizeForMatch(errBuf + data).slice(-4000)
        if (THINKING_ERR.test(errBuf)) {
          errBuf = ''
          triggerRecovery(args.id)
        }
      }
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      win.webContents.send('pty:data', { id: args.id, data })
    })

    term.onExit(({ exitCode }) => {
      ptys.delete(args.id)
      if (recovering.has(args.id)) {
        // Recovery exit: don't surface it as a process exit; resume the session instead.
        recovering.delete(args.id)
        settleDying(args.id)
        const a = spawnArgs.get(args.id)
        if (a) {
          notify(args.id, 'retomando sessão…')
          spawnPty(a)
        }
        return
      }
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('pty:exit', { id: args.id, code: exitCode })
      }
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
    // A user-initiated kill cancels any pending auto-recovery for this id.
    recovering.delete(args.id)
    killGraceful(args.id, term)
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
      term.kill('SIGTERM') // graceful so claude can flush before deck exits
    } catch {
      // already dead
    }
  }
  ptys.clear()
}
