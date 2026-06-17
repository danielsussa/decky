import * as pty from 'node-pty'
import os from 'os'
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { workspaceCardsDir } from '@decky/shared/node'
import { sessionHandoffSocketPath } from './handoff-paths'

// PTY multiplexer + lifecycle. Puro Node — sem Electron API. Eventos saem via callbacks
// registrados em setPtyManagerEvents (shim Electron registra-os apontando pra webContents.send;
// servidor remoto registra apontando pra ws.broadcast).

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

let cachedPath: string | null = null
// macOS GUI apps (launched from Finder/Dock) inherit the minimal launchd PATH —
// /usr/bin:/bin:/usr/sbin:/sbin — missing Homebrew/nvm/asdf dirs. Resolve the
// user's real login-shell PATH once and merge it in; fall back to prepending
// the common install dirs if the login shell can't be queried.
export function loginShellPath(): string {
  if (cachedPath) return cachedPath
  const shell = process.env.SHELL || '/bin/zsh'
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', join(os.homedir(), '.local', 'bin')]
  // CLIs instalados localmente pelo install pipeline do decky-server vão pra
  // ~/.decky-server/node_modules/.bin. Inclui no PATH pra spawnar mesmo quando o host
  // remoto não tem a tool global (e sem precisar de sudo pro install).
  const serverLocalBin = join(os.homedir(), '.decky-server', 'node_modules', '.bin')
  let resolved = ''
  try {
    resolved = execSync(`${shell} -lc 'echo $PATH'`, { encoding: 'utf-8', timeout: 3000 }).trim()
  } catch {
    // login shell unavailable — fall back to the common dirs below
  }
  const parts = new Set<string>()
  for (const p of resolved.split(':')) if (p) parts.add(p)
  for (const p of fallback) parts.add(p)
  for (const p of (process.env.PATH || '').split(':')) if (p) parts.add(p)
  parts.add(serverLocalBin)
  cachedPath = Array.from(parts).join(':')
  return cachedPath
}

/**
 * Resolve o bin a executar no HOST onde este pty-manager roda. O renderer (no client) pode ter
 * detectado um path absoluto no Mac e mandado isso como command[0]; num engine remoto esse path
 * não existe. Estratégia:
 *   - basename simples (sem '/') → deixa direto, execvp acha pelo PATH.
 *   - path absoluto que EXISTE → usa direto.
 *   - path absoluto que NÃO existe → cai pro basename (resolve pelo PATH).
 */
function resolveBinForHost(file: string): string {
  if (!isAbsolute(file)) return file
  if (existsSync(file)) return file
  return basename(file)
}

function binMissingHint(originalBin: string): string {
  const name = basename(originalBin)
  return (
    `\r\n\x1b[31m[decky] '${name}' não encontrado neste host.\x1b[0m\r\n` +
    `\x1b[2mInstale a tool ou reabra o "Connect to Server…" pra reinstalar o engine.\x1b[0m\r\n`
  )
}

const ptys = new Map<string, pty.IPty>()
// A pty that was killed but whose process may still be alive. create() awaits this
// before spawning a new pty with the same id, so we never have two on the same id at once.
const dying = new Map<string, Promise<void>>()
const dyingResolvers = new Map<string, () => void>()

export interface CreatePtyArgs {
  id: string
  cwd?: string
  cols: number
  rows: number
  shell?: string
  /** Custom command to spawn. If set, takes precedence over shell. command[0] = file, rest = args. */
  command?: string[]
}

export interface ClaudeInfo {
  /** claude é o processo em foreground do PTY agora? */
  running: boolean
  /** id da conversa do claude (basename do .jsonl) pra `claude --resume` no próximo boot. */
  sessionId?: string
}

export interface PtyManagerEvents {
  /** Stream de output do PTY pra client renderer/WS. */
  onData?(id: string, data: string): void
  /** PTY morreu. */
  onExit?(id: string, code: number): void
  /** Hook pra subir o handoff backend dessa sessão. */
  onHandoffStart?(id: string): void
  /** Hook pra derrubar o handoff backend (libera socket). */
  onHandoffStop?(id: string): void
  /**
   * O foreground process do PTY entrou/saiu do `claude`. Usado pra persistir "essa sessão tava com
   * claude" e qual conversa resumir no próximo boot. Local-only (engines remotos caem fora).
   */
  onClaude?(id: string, info: ClaudeInfo): void
}

let events: PtyManagerEvents = {}

export function setPtyManagerEvents(e: PtyManagerEvents): void {
  events = e
}

function settleDying(id: string): void {
  const resolve = dyingResolvers.get(id)
  if (resolve) {
    dyingResolvers.delete(id)
    dying.delete(id)
    resolve()
  }
}

// Graceful kill que deixa um create() concorrente esperar a saída real. SIGTERM
// primeiro pra o processo flushar; SIGKILL só se ignorar.
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

// Foreground-process tracking. node-pty.process reflete o processo em foreground do tty (ex.
// "zsh" no prompt, "claude" enquanto o claude roda, "sleep" durante um sleep). Pollamos pra
// detectar quando o `claude` é o foreground e capturar a conversa que ele abriu — assim o próximo
// boot pode `claude --resume <id>` na MESMA sessão (cada terminal tem a sua).
const lastProc = new Map<string, string>() // id -> último foreground process visto
const sidById = new Map<string, string>() // id -> claudeSessionId já emitido p/ a invocação atual
const claudeStartAt = new Map<string, number>() // id -> instante em que algo (claude) virou foreground
const cwdById = new Map<string, string>() // id -> cwd (pra achar o .jsonl do claude)

// Basename do processo: tira o `-` de login-shell e qualquer path ("/usr/bin/node" -> "node").
function procBase(p: string): string {
  return p ? (p.replace(/^-/, '').split('/').pop() ?? p) : ''
}

const SHELL_NAMES = new Set([
  'zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login'
])
function isShellProc(base: string): boolean {
  return base === '' || SHELL_NAMES.has(base)
}

// O claude-code reporta seu process title como a VERSÃO (ex '2.1.179') — e é ISSO que o node-pty
// lê em `term.process` no macOS (não 'claude', nem 'node', que é só o `ps -o comm`). Então um nome
// de processo no formato semver (ou o literal 'claude') = claude rodando em foreground. Agnóstico
// a versão: qualquer release reporta X.Y.Z.
function looksLikeClaude(base: string): boolean {
  return base === 'claude' || /^\d+\.\d+\.\d+/.test(base)
}
let pollTimer: ReturnType<typeof setInterval> | null = null

// Encoding do dir de projeto do claude: `/` e `.` viram `-` (ex.
// /Users/x/dev/decky -> -Users-x-dev-decky). É o nome da pasta em ~/.claude/projects/.
function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

// A conversa que o claude DESTA aba criou: o .jsonl em ~/.claude/projects/<slug>/ cujo BIRTHTIME é
// >= o instante em que o claude virou foreground (`sinceMs`, com folga de 3s). Um `claude` fresh
// cria um .jsonl AGORA; já `claude --resume X` e as conversas de OUTRAS abas têm birthtime ANTIGO →
// ficam de fora. Isso conserta o swap em que "mtime mais recente" pegava a conversa que estava sendo
// MAIS escrita (a da aba ativa) em vez da desta aba. `exclude` = ids já reivindicados por outras abas
// vivas (dedup). O basename sem extensão é o session id que `claude --resume` aceita.
function resolveClaudeSessionByBirth(
  cwd: string,
  sinceMs: number,
  exclude?: Set<string>
): string | null {
  try {
    const dir = join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd))
    let best: { id: string; born: number } | null = null
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const sid = f.slice(0, -'.jsonl'.length)
      if (exclude?.has(sid)) continue
      let born = 0
      try {
        born = statSync(join(dir, f)).birthtimeMs
      } catch {
        continue
      }
      if (born + 3000 < sinceMs) continue // criado ANTES deste claude → não é desta aba
      if (!best || born > best.born) best = { id: sid, born }
    }
    return best?.id ?? null
  } catch {
    return null // dir não existe (claude nunca rodou neste cwd) etc.
  }
}

function pollProcesses(): void {
  for (const [id, term] of ptys) {
    let proc = ''
    try {
      proc = term.process
    } catch {
      continue
    }
    const prev = lastProc.get(id) ?? ''
    const base = procBase(proc)
    const cwd = cwdById.get(id) ?? os.homedir()

    if (proc !== prev) {
      lastProc.set(id, proc)
      // Algo (potencial claude) acabou de virar foreground vindo do shell → marca o instante, pra
      // capturar a conversa que ELE cria (.jsonl nascido depois daqui), não a mais escrita de outra aba.
      if (!isShellProc(base) && isShellProc(procBase(prev))) claudeStartAt.set(id, Date.now())
      // claude em foreground (nome 'claude' ou a versão X.Y.Z) → flip imediato (responsivo p/ a
      // animação de borda).
      if (looksLikeClaude(base)) events.onClaude?.(id, { running: true })
      // Voltou pro prompt do shell depois do claude → running:false. O claudeSessionId persiste
      // sticky no renderer, então o resume do próximo boot NÃO depende deste flag instantâneo.
      else if (looksLikeClaude(procBase(prev))) {
        events.onClaude?.(id, { running: false })
        sidById.delete(id) // a próxima invocação de claude nesta aba re-resolve a conversa
        claudeStartAt.delete(id)
      }
    }

    // Captura a conversa desta invocação (uma vez — fica sticky no renderer; basta UMA vez p/ o
    // boot seguinte fazer `claude --resume <id>`). Re-tenta a cada poll porque o claude demora um
    // instante até criar o .jsonl.
    if (!sidById.has(id)) {
      // Conversas já reivindicadas por OUTRAS abas vivas — nenhuma aba captura a mesma (dedup).
      const claimed = new Set<string>()
      for (const [otherId, sid] of sidById) if (otherId !== id) claimed.add(sid)
      // Captura por BIRTHTIME desde que o claude virou foreground (claudeStartAt): pega a conversa
      // que ESTA aba criou, não a mais ESCRITA (que pode ser de outra aba ativa no mesmo cwd — era
      // a causa do swap). Vale p/ qualquer não-shell em foreground ('claude'/semver e 'node', que é
      // como o claude-code aparece às vezes); um não-shell que NÃO é claude não cria .jsonl novo →
      // resolve dá null (sem falso-positivo). Abas resumidas (`claude --resume X`) não criam .jsonl
      // novo, mas já têm o sid pinado no renderer, então não dependem desta captura.
      const since = claudeStartAt.get(id) ?? 0
      const sessionId = !isShellProc(base) ? resolveClaudeSessionByBirth(cwd, since, claimed) : null
      if (sessionId) {
        sidById.set(id, sessionId)
        events.onClaude?.(id, { running: true, sessionId })
      }
    }
  }
}

function startProcPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(pollProcesses, 1500)
  // Não segura o event loop vivo só por causa do poll.
  pollTimer.unref?.()
}

// Histórico de shell ISOLADO por aba: cada pty ganha seu próprio HISTFILE (persistente, keyed pelo
// session id), pra Ctrl-R / seta-pra-cima não vazarem comandos entre terminais. zsh é o caso
// chato: o /etc/zshrc força HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history no startup, sobrescrevendo
// qualquer HISTFILE do env. Por isso usamos um ZDOTDIR "shim" (carrega a config real do usuário e
// SÓ no fim fixa o HISTFILE da aba). Pra outros shells (bash) o HISTFILE do env basta.
let zshShimDir: string | null = null
function ensureZshShim(): string {
  if (zshShimDir) return zshShimDir
  const dir = join(os.homedir(), '.decky', 'zsh')
  mkdirSync(dir, { recursive: true })
  // .zshenv mantém o ZDOTDIR=shim ativo até o estágio do .zshrc; só carrega o real do usuário.
  writeFileSync(join(dir, '.zshenv'), '[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n')
  // .zshrc devolve ZDOTDIR pro $HOME (config real e subshells veem o normal), carrega o .zshrc do
  // usuário e por ÚLTIMO isola o histórico desta aba (vence até se o real setasse HISTFILE).
  writeFileSync(
    join(dir, '.zshrc'),
    'ZDOTDIR="$HOME"\n' +
      '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n' +
      '[ -n "$DECKY_HISTFILE" ] && HISTFILE="$DECKY_HISTFILE"\n'
  )
  // Defensivo (o spawn é non-login, mas caso mude): login shells carregam os reais.
  writeFileSync(join(dir, '.zprofile'), '[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n')
  writeFileSync(join(dir, '.zlogin'), '[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n')
  zshShimDir = dir
  return dir
}

// Env extra que isola o histórico desta aba. HISTFILE persistente keyed pelo session id (sobrevive
// a restarts da MESMA aba). Pra zsh, injeta também o ZDOTDIR shim.
function historyEnv(sessionId: string, shellFile: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const histDir = join(os.homedir(), '.decky', 'histories')
    mkdirSync(histDir, { recursive: true })
    const histfile = join(histDir, sessionId)
    env.HISTFILE = histfile
    env.DECKY_HISTFILE = histfile
    if (basename(shellFile).includes('zsh')) env.ZDOTDIR = ensureZshShim()
  } catch {
    // se algo falhar, segue sem isolamento (melhor que derrubar o spawn)
  }
  return env
}

function spawnPty(args: CreatePtyArgs): void {
  const requestedFile = args.command?.[0] ?? args.shell ?? defaultShell()
  // O renderer pode ter mandado um path absoluto resolvido no host LOCAL (Mac); num engine
  // remoto esse path não existe. Refaz o resolve aqui, no host onde realmente vamos spawnar.
  const file = resolveBinForHost(requestedFile)
  const argv = args.command ? args.command.slice(1) : []

  let term: pty.IPty
  try {
    term = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd ?? os.homedir(),
      env: {
        ...(process.env as { [key: string]: string }),
        // GUI launch gives us launchd's minimal PATH; restore the user's real
        // PATH so spawned tools (e.g. claude rodando manual, node, npx) sejam achados.
        // DECKY_BIN_DIR (setado pelo main) vai NA FRENTE — é o que torna o `decky` disponível
        // só dentro das sessões do decky (não está no PATH global do sistema).
        PATH: process.env.DECKY_BIN_DIR
          ? `${process.env.DECKY_BIN_DIR}:${loginShellPath()}`
          : loginShellPath(),
        DECKY_SESSION_ID: args.id,
        DECKY_URL: process.env.DECKY_URL || 'http://127.0.0.1:6790',
        // Where this workspace's shared card files live, so tools can Glob/Read them.
        DECKY_CARDS_DIR: workspaceCardsDir(args.cwd ?? os.homedir()),
        // Socket DESTA sessão pro handoff CLI/SDK/MCP. O backend só dirige cards da própria
        // sessão — sem isso, qualquer cliente caía no socket global e mexia em card de
        // outra sessão/workspace. Bound pelo callback onHandoffStart abaixo.
        HANDOFF_SOCKET: sessionHandoffSocketPath(args.id),
        // Histórico de shell isolado por aba (HISTFILE próprio + ZDOTDIR shim no zsh).
        ...historyEnv(args.id, file)
      }
    })
  } catch (err) {
    // node-pty pode jogar throw síncrono quando o bin não existe no PATH.
    console.warn(`[pty] spawn '${file}' failed:`, err)
    events.onData?.(args.id, binMissingHint(requestedFile))
    events.onExit?.(args.id, 127)
    return
  }

  ptys.set(args.id, term)
  cwdById.set(args.id, args.cwd ?? os.homedir())
  lastProc.delete(args.id)
  sidById.delete(args.id)
  claudeStartAt.delete(args.id)
  startProcPolling()
  // Sobe o backend handoff scoped na sessão. Idempotente.
  events.onHandoffStart?.(args.id)

  term.onData((data) => {
    events.onData?.(args.id, data)
  })

  term.onExit(({ exitCode }) => {
    ptys.delete(args.id)
    cwdById.delete(args.id)
    lastProc.delete(args.id)
    sidById.delete(args.id)
    claudeStartAt.delete(args.id)
    // Derruba o backend handoff dessa sessão (libera socket).
    events.onHandoffStop?.(args.id)
    events.onExit?.(args.id, exitCode)
    settleDying(args.id) // unblock any create() waiting on this id to die
  })
}

export async function createPty(args: CreatePtyArgs): Promise<void> {
  if (ptys.has(args.id)) return
  // Wait for a previous instance with the same id to fully exit.
  const d = dying.get(args.id)
  if (d) await d
  if (ptys.has(args.id)) return
  spawnPty(args)
}

export function writePty(id: string, data: string): void {
  ptys.get(id)?.write(data)
}

export function killPty(id: string): void {
  const term = ptys.get(id)
  if (!term) return
  ptys.delete(id)
  // Derruba backend handoff junto.
  events.onHandoffStop?.(id)
  killGraceful(id, term)
}

export function resizePty(id: string, cols: number, rows: number): void {
  try {
    ptys.get(id)?.resize(cols, rows)
  } catch {
    // pty may have exited between resize observation and dispatch
  }
}

export function killAllPtys(): void {
  for (const term of ptys.values()) {
    try {
      term.kill('SIGTERM')
    } catch {
      // already dead
    }
  }
  ptys.clear()
}
