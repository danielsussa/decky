import * as pty from 'node-pty'
import os from 'os'
import { execSync, execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { workspaceCardsDir } from '@decky/shared/node'
import { claudeSessionFile, readLatestAiTitle } from './claude-sessions'

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
  /**
   * Conversa do claude que esta aba VAI resumir (autorun `claude --resume <id>`). Quando setado,
   * semeamos o tracker de captura com ela: a aba JÁ sabe sua conversa, então NÃO tenta capturar
   * nenhuma — é o que impede uma aba resumida de "roubar" a conversa nova de outra aba (swap).
   */
  claudeSessionId?: string
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
  /**
   * O foreground process do PTY entrou/saiu do `claude`. Usado pra persistir "essa sessão tava com
   * claude" e qual conversa resumir no próximo boot. Local-only (engines remotos caem fora).
   */
  onClaude?(id: string, info: ClaudeInfo): void
  /**
   * O aiTitle (título auto-gerado pelo claude) da conversa desta aba mudou — empurra pro título da
   * sessão (a aba). É a fonte ÚNICA de nome de sessão; ver syncAiTitle/readLatestAiTitle.
   */
  onTitle?(id: string, title: string): void
  /**
   * Um processo "interessante" (npm/vite/node/pytest…) entrou ou saiu de foreground nesta aba. O
   * `cmd` é a linha de comando do LÍDER do foreground group (ex 'npm run dev') — '' quando volta pro
   * prompt. Vira um sufixo no nome da aba: `toucan-happy (npm run dev)`. NÃO sobrescreve o título.
   */
  onRunning?(id: string, cmd: string): void
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
const lastTitleMtime = new Map<string, number>() // id -> mtime do .jsonl já lido (gate de re-parse)
const lastTitle = new Map<string, string>() // id -> último aiTitle empurrado (dedup de evento)
const claudeOn = new Set<string>() // ids cujo foreground é claude (suprime anotação de comando)
const lastRunning = new Map<string, string>() // id -> último cmd anotado na aba (dedup + clear)

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

// Comandos "interessantes" pra anotar no nome da aba (dev servers, build, runtimes, pkg managers,
// testes). Foreground não-shell fora desta lista (git, ls, vim, less, man, ssh…) NÃO polui a aba —
// é ruído de uso normal do terminal, não um processo de longa duração que valha rotular.
const RUN_ALLOW = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'tsx', 'ts-node', 'nodemon',
  'vite', 'next', 'webpack', 'rollup', 'esbuild', 'turbo', 'nx', 'parcel', 'remix', 'astro',
  'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'pytest',
  'python', 'python3', 'flask', 'uvicorn', 'gunicorn', 'celery',
  'ruby', 'rails', 'rake', 'go', 'cargo', 'rustc', 'make', 'gradle', 'mvn',
  'docker', 'docker-compose', 'kubectl', 'serve', 'http-server', 'electron'
])

// Encolhe a linha de comando do líder pra um rótulo curto: paths absolutos viram basename
// ('node /Users/x/p/server.js' -> 'node server.js'), e trunca em ~36 chars. 'npm run dev' já é curto.
function prettyRunCmd(command: string): string {
  const toks = command.trim().split(/\s+/).map((t) => (isAbsolute(t) ? basename(t) : t))
  const s = toks.join(' ')
  return s.length > 36 ? s.slice(0, 35) + '…' : s
}

// Resolve o comando em foreground via o LÍDER do foreground process group (tpgid) do tty da aba.
// Por que o líder e não o `term.process`: durante `npm run dev` o foreground flickera npm→node, mas
// o líder do grupo é estável ('npm run dev'); e durante um tool-call do claude o líder continua
// sendo o claude (a ferramenta herda o pgid dele), então isso NÃO rotula tool-calls como comando.
// Assíncrono (não trava o poll): emite onRunning quando o ps resolve. shellPid = term.pid.
function resolveRunningCmd(id: string, shellPid: number): void {
  const emit = (cmd: string): void => {
    if (lastRunning.get(id) === cmd) return
    lastRunning.set(id, cmd)
    events.onRunning?.(id, cmd)
  }
  // tpgid = pgid em foreground no tty de controle do shell; pgid = grupo do próprio shell. Iguais =
  // prompt (nada rodando) → limpa. tpgid<=0 = sem tty de controle → limpa.
  execFile('ps', ['-o', 'tpgid=,pgid=', '-p', String(shellPid)], (err, out) => {
    if (err) return
    const [tpgidStr, pgidStr] = out.trim().split(/\s+/)
    const tpgid = Number(tpgidStr)
    const pgid = Number(pgidStr)
    if (!Number.isFinite(tpgid) || tpgid <= 0 || tpgid === pgid) return emit('')
    // Líder do grupo: pid == pgid == tpgid. `ps -p <tpgid> -o command=` dá a linha que o usuário rodou.
    execFile('ps', ['-o', 'command=', '-p', String(tpgid)], (err2, out2) => {
      if (err2) return
      const command = out2.trim()
      if (!command) return emit('')
      const base0 = procBase(command.split(/\s+/)[0] ?? '')
      if (!RUN_ALLOW.has(base0)) return emit('') // comando fora da allowlist = sem rótulo
      emit(prettyRunCmd(command))
    })
  })
}

let pollTimer: ReturnType<typeof setInterval> | null = null

// Encoding do dir de projeto do claude: `/` e `.` viram `-` (ex.
// /Users/x/dev/decky -> -Users-x-dev-decky). É o nome da pasta em ~/.claude/projects/.
function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

// A conversa que o claude DESTA aba criou: o .jsonl em ~/.claude/projects/<slug>/ cujo BIRTHTIME é
// >= o instante em que o claude virou foreground (`sinceMs`, com folga de 3s). Um `claude` fresh
// cria um .jsonl quando o PRIMEIRO prompt é enviado — o que pode ser muitos segundos (ou minutos)
// após o launch (tempo de ler/digitar) — então NÃO há teto fixo de tempo; o limite SUPERIOR é
// `upperMs` = o instante em que a PRÓXIMA aba (mesmo cwd) lançou claude (conversa nascida depois
// disso é dela, não desta). `claude --resume X` e conversas de OUTRAS abas têm birthtime fora do
// intervalo → ficam de fora. Isso conserta o swap em que "mtime mais recente" pegava a conversa
// mais escrita (a da aba ativa). `exclude` = ids já reivindicados por outras abas vivas (dedup). O
// basename sem extensão é o session id que `claude --resume` aceita.
function resolveClaudeSessionByBirth(
  cwd: string,
  sinceMs: number,
  exclude?: Set<string>,
  upperMs = Infinity
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
      // JANELA: a conversa DESTA aba nasce em [claudeStartAt-3s, upperMs). O limite inferior (-3s,
      // folga de clock) descarta conversas anteriores ao launch (--resume, abas antigas). O superior
      // (`upperMs`) é o launch da próxima aba do cwd, ou Infinity se ela é a última a ter subido
      // claude — daí espera o .jsonl nascer por quanto tempo for (1º prompt demorado), sem orfanar.
      if (born < sinceMs - 3000 || born >= upperMs) continue
      // Dentro da janela, pega o nascido MAIS PRÓXIMO do claudeStartAt (= a conversa DESTA aba). Pegar
      // "o mais novo" deixava uma aba roubar o .jsonl de OUTRA aba que iniciou claude poucos s depois.
      if (!best || Math.abs(born - sinceMs) < Math.abs(best.born - sinceMs)) best = { id: sid, born }
    }
    return best?.id ?? null
  } catch {
    return null // dir não existe (claude nunca rodou neste cwd) etc.
  }
}

// Sync contínuo aiTitle → título da aba. Roda no poll pra cada aba com conversa do claude já
// resolvida (sidById). Gated por mtime do .jsonl (não re-parseia a cada 1.5s) e por valor (não
// re-emite o mesmo título). O aiTitle só aparece após alguns turnos — até lá readLatestAiTitle dá
// null e a aba mantém o placeholder aleatório.
function syncAiTitle(id: string, cwd: string, claudeSessionId: string): void {
  const file = claudeSessionFile(cwd, claudeSessionId)
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return
  }
  if (lastTitleMtime.get(id) === mtimeMs) return
  lastTitleMtime.set(id, mtimeMs)
  const title = readLatestAiTitle(file)
  if (!title || lastTitle.get(id) === title) return
  lastTitle.set(id, title)
  events.onTitle?.(id, title)
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
      // CLAUDE acabou de virar foreground vindo do shell → marca o instante, pra capturar a conversa
      // que ELE cria (.jsonl nascido depois daqui), não a mais escrita de outra aba. CRÍTICO: exige
      // looksLikeClaude(base). Sem esse gate, QUALQUER comando (npm run dev, node, vite…) que vira
      // foreground marcava claudeStartAt e deixava a aba "caçando" conversa (bloco abaixo) por todo o
      // tempo que o comando rodasse; ao FECHAR outra sessão do mesmo cwd, a conversa liberada do
      // `claimed` caía na janela de birthtime e a aba roubava o título (e o claudeSessionId) dela.
      if (!isShellProc(base) && isShellProc(procBase(prev)) && looksLikeClaude(base)) {
        claudeStartAt.set(id, Date.now())
      }
      // claude em foreground (nome 'claude' ou a versão X.Y.Z) → flip imediato (responsivo p/ a
      // animação de borda).
      if (looksLikeClaude(base)) {
        claudeOn.add(id)
        events.onClaude?.(id, { running: true })
      }
      // Claude → SHELL = realmente voltou pro prompt → running:false + solta o vínculo da conversa.
      // CRÍTICO: exige isShellProc(base). Sem isso, um tool call do claude (foreground vira 'node'/
      // 'git'/… por um instante) era lido como "claude saiu", limpava o sidById e o bloco abaixo
      // RE-VINCULAVA a aba à conversa mais nova do cwd — quando havia OUTRA sessão aberta, a aba
      // roubava o título (e o claudeSessionId de --resume) dela. Tool calls (não-shell) agora não
      // mexem no vínculo; ele só solta no retorno ao shell. O claudeSessionId persiste sticky no
      // renderer, então o resume do próximo boot NÃO depende deste flag instantâneo.
      else if (looksLikeClaude(procBase(prev)) && isShellProc(base)) {
        claudeOn.delete(id)
        events.onClaude?.(id, { running: false })
        sidById.delete(id) // a próxima invocação de claude nesta aba re-resolve a conversa
        claudeStartAt.delete(id)
        lastTitleMtime.delete(id) // próxima conversa (.jsonl novo) re-sincroniza do zero
        lastTitle.delete(id)
      }

      // Anotação do comando em foreground (sufixo da aba). Enquanto o claude é o foreground ele já
      // tem a borda animada — não rotulamos (e os tool-calls dele não viram "comando rodando"). Fora
      // do claude, reavalia a cada troca de foreground: resolveRunningCmd emite '' no prompt/ruído.
      if (claudeOn.has(id)) {
        if (lastRunning.get(id)) {
          lastRunning.set(id, '')
          events.onRunning?.(id, '')
        }
      } else {
        resolveRunningCmd(id, term.pid)
      }
    }

    // Captura a conversa que ESTA aba criou, por BIRTHTIME, enquanto ela estiver SEM vínculo e com
    // claude em foreground. NÃO há mais janela de 7s: o .jsonl nasce no 1º prompt (pode demorar), e
    // o give-up orfanava pra sempre toda sessão cujo 1º prompt vinha depois disso ("sem nome"). O
    // anti-swap agora é o `upperMs`: o launch da PRÓXIMA aba do mesmo cwd que subiu claude depois
    // desta — conversa nascida após esse instante é dela. Abas resumidas (`claude --resume X`) não
    // criam .jsonl novo → resolve dá null (sem roubo). Um não-shell que não é claude idem.
    const since = claudeStartAt.get(id) ?? 0
    // claudeOn.has(id) (não só `!isShellProc(base)`): só caça conversa enquanto o CLAUDE é o
    // foreground desta aba. claudeOn persiste durante tool-calls (foreground flicka p/ node/git sem
    // soltar o vínculo) e some no retorno ao shell — então captura de 1º prompt demorado e tool-calls
    // seguem funcionando, mas um `npm run dev`/`node` solto nunca entra em modo de captura.
    if (!sidById.has(id) && since > 0 && claudeOn.has(id)) {
      // claimed = sids já vinculados a QUALQUER outra aba viva (inclui as semeadas via --resume, que
      // têm sidById mas talvez não claudeStartAt) — varre sidById pra não deixar buraco.
      const claimed = new Set<string>()
      for (const [otherId, sid] of sidById) if (otherId !== id) claimed.add(sid)
      // upperMs = launch da próxima aba SEM vínculo no mesmo cwd que subiu claude depois de nós.
      let upperMs = Infinity
      for (const [otherId, otherStart] of claudeStartAt) {
        if (otherId === id || sidById.has(otherId)) continue
        if ((cwdById.get(otherId) ?? os.homedir()) === cwd && otherStart > since && otherStart < upperMs) {
          upperMs = otherStart
        }
      }
      const sessionId = resolveClaudeSessionByBirth(cwd, since, claimed, upperMs)
      if (sessionId) {
        sidById.set(id, sessionId)
        events.onClaude?.(id, { running: true, sessionId })
      }
    }

    // aiTitle → título da aba (contínuo). Só pra abas cuja conversa do claude já foi resolvida.
    const claudeSid = sidById.get(id)
    if (claudeSid) syncAiTitle(id, cwd, claudeSid)
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
  claudeStartAt.delete(args.id)
  claudeOn.delete(args.id)
  lastRunning.delete(args.id)
  // SEED: se a aba vai resumir uma conversa conhecida, semeia o tracker com ela → a aba não tenta
  // capturar nenhuma conversa (já sabe a sua) e não rouba a de outra aba. Limpo no exit do claude
  // (volta pro shell), então um claude NOVO depois (re-associação) volta a capturar normalmente.
  if (args.claudeSessionId) sidById.set(args.id, args.claudeSessionId)
  else sidById.delete(args.id)
  startProcPolling()

  term.onData((data) => {
    events.onData?.(args.id, data)
  })

  term.onExit(({ exitCode }) => {
    ptys.delete(args.id)
    cwdById.delete(args.id)
    lastProc.delete(args.id)
    sidById.delete(args.id)
    claudeStartAt.delete(args.id)
    claudeOn.delete(args.id)
    lastRunning.delete(args.id)
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
  killGraceful(id, term)
}

export function resizePty(id: string, cols: number, rows: number): void {
  try {
    ptys.get(id)?.resize(cols, rows)
  } catch {
    // pty may have exited between resize observation and dispatch
  }
}

// Mata TODOS os ptys e ESPERA cada onExit antes de resolver. Isso é o que evita o SIGABRT no quit:
// o node-pty entrega data/exit por uma ThreadSafeFunction numa thread de leitura; se o env Node
// começa o teardown (node::Environment::CleanupHandles) com um callback ainda pendente, o CallJS
// dispara Napi::Error::ThrowAsJavaScriptException num env já morto → std::terminate → abort (o
// diálogo "decky quit unexpectedly"). SIGKILL força EOF imediato no fd do pty; ao chegar o onExit a
// TSFN já drenou e foi liberada, então é seguro sair. Timeout curto pra nunca travar o quit.
export function killAllPtys(): Promise<void> {
  const waits: Promise<void>[] = []
  for (const [, term] of ptys) {
    waits.push(
      new Promise<void>((resolve) => {
        let settled = false
        const done = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          term.onExit(() => done())
        } catch {
          // sem onExit (já morto) — resolve no kill/timeout abaixo
        }
        try {
          term.kill('SIGKILL')
        } catch {
          done() // já morto
        }
        setTimeout(done, 800) // não trava o quit se o EOF nunca vier
      })
    )
  }
  ptys.clear()
  return Promise.all(waits).then(() => undefined)
}
