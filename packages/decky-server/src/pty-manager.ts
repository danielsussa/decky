import * as pty from 'node-pty'
import os from 'os'
import { execSync, execFile } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  unlinkSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { workspaceCardsDir } from '@decky/shared/node'
import { planShellSpawn } from './shell-adapters'
import {
  claudeSessionFile,
  isHeadlessClaudeSession,
  readFirstPrompt,
  readLatestAiTitle
} from './claude-sessions'

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
  /**
   * Linha de lançamento do claude já EXPANDIDA pelo shell (um alias como `myclaude` chega aqui como o
   * comando real, ex 'claude --model x') e SEM o `--session-id <uuid>` que o shim injeta. Capturada uma
   * vez por run, quando o claude sobe. Alimenta o "definir <cmd> como default do workspace" no renderer.
   */
  launchCmd?: string
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
const boundLogged = new Set<string>() // ids que já logaram [nobind] nesta run (1x por run, debug)

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

// Remove o `--session-id <uuid>` que o shim do claude injeta (ver shell-adapters.ts) — é por-conversa, não
// faz parte do "comando default" que o usuário quer relançar em abas novas.
function stripInjectedSid(cmd: string): string {
  return cmd.replace(/\s+--session-id\s+[0-9a-f-]{36}/i, '').trim()
}

// Captura a LINHA de lançamento do claude desta aba pra oferecer "definir como default do workspace".
// Pega o comando do líder do foreground group (o claude já está em foreground aqui) via `ps -o command=`:
// isso devolve o comando JÁ EXPANDIDO pelo shell (aliases viram o comando real), que é justamente a
// "expansão" que queremos persistir (preserva as flags). Tira só o --session-id que o shim injetou.
// Emitido uma vez por run (chamado quando o claude vira foreground), via onClaude sem mexer no sessionId.
function captureLaunchCmd(id: string, shellPid: number): void {
  execFile('ps', ['-o', 'tpgid=', '-p', String(shellPid)], (err, out) => {
    if (err) return
    const tpgid = Number(out.trim())
    if (!Number.isFinite(tpgid) || tpgid <= 0) return
    execFile('ps', ['-o', 'command=', '-p', String(tpgid)], (err2, out2) => {
      if (err2) return
      const launchCmd = stripInjectedSid(out2.trim())
      if (launchCmd) events.onClaude?.(id, { running: true, launchCmd })
    })
  })
}

let pollTimer: ReturnType<typeof setInterval> | null = null

// Encoding do dir de projeto do claude: `/` e `.` viram `-` (ex.
// /Users/x/dev/decky -> -Users-x-dev-decky). É o nome da pasta em ~/.claude/projects/.
function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

// session id do claude = UUID v4 (basename do .jsonl OU nome da pasta `<sid>/`). Usado pra não
// confundir a pasta `memory/` (e outras) com uma sessão ao varrer o dir do projeto.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Vínculo DETERMINÍSTICO aba↔conversa: a função `claude` do shim (ver shell-adapters.ts) gera um uuid,
// força `claude --session-id <uuid>` e ANUNCIA o id escrevendo $DECKY_CLAUDE_SID_DIR/<DECKY_SESSION_ID>
// (= o id desta aba). O server lê esse arquivo e vincula na hora, sem adivinhar por birthtime/nome de
// processo (que já causou vários casos de "sessão sem nome"). A heurística de birthtime fica só como
// fallback (claude lançado fora do shim — bash, claude chamado por path absoluto, build antigo).
function claudeSidDir(): string {
  return join(os.homedir(), '.decky', 'claude-sid')
}
// Lê e CONSOME (apaga) o sid anunciado por esta aba. Consumir evita que um anúncio de uma run
// anterior re-vincule errado uma run nova que (por algum motivo) não anunciou.
function readAnnouncedSid(id: string): string | null {
  const file = join(claudeSidDir(), id)
  try {
    const sid = readFileSync(file, 'utf8').trim()
    try {
      unlinkSync(file)
    } catch {
      /* já sumiu — ok */
    }
    return SESSION_ID_RE.test(sid) ? sid : null
  } catch {
    return null // nada anunciado
  }
}
function clearAnnouncedSid(id: string): void {
  try {
    unlinkSync(join(claudeSidDir(), id))
  } catch {
    /* não existe — ok */
  }
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
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // Uma sessão é `<sid>.jsonl` (transcript principal) OU, no claude-code 2.x, uma PASTA `<sid>/`
      // (criada de cara quando o 1º turno dispara subagents; o .jsonl principal só flusha no fim do
      // turno). Sem reconhecer a pasta, uma sessão agent-first ficava órfã até o flush — às vezes
      // minutos. Pega o sid das duas formas; o birthtime é o do arquivo/pasta.
      let sid: string | null = null
      if (e.isFile() && e.name.endsWith('.jsonl')) sid = e.name.slice(0, -'.jsonl'.length)
      else if (e.isDirectory() && SESSION_ID_RE.test(e.name)) sid = e.name
      if (!sid || exclude?.has(sid)) continue
      let born = 0
      try {
        born = statSync(join(dir, e.name)).birthtimeMs
      } catch {
        continue
      }
      // JANELA: a conversa DESTA aba nasce em [claudeStartAt-3s, upperMs). O limite inferior (-3s,
      // folga de clock) descarta conversas anteriores ao launch (--resume, abas antigas). O superior
      // (`upperMs`) é o launch da próxima aba do cwd, ou Infinity se ela é a última a ter subido
      // claude — daí espera o .jsonl nascer por quanto tempo for (1º prompt demorado), sem orfanar.
      if (born < sinceMs - 3000 || born >= upperMs) continue
      // Conversa headless (claude -p / Agent SDK de um loop): NÃO é a conversa que ESTA aba
      // interativa criou — um loop pode parir dezenas no mesmo cwd dentro da janela de birthtime.
      // Sem isto, a aba bindava numa spawn que nunca recebe aiTitle e ficava eternamente no
      // placeholder. Só checável no .jsonl (pasta-só não tem head legível → não exclui). Checado só
      // após a janela pra não ler head de arquivos fora do intervalo a cada poll.
      if (e.isFile() && isHeadlessClaudeSession(join(dir, e.name))) continue
      // Dentro da janela, pega o nascido MAIS PRÓXIMO do claudeStartAt (= a conversa DESTA aba). Pegar
      // "o mais novo" deixava uma aba roubar o .jsonl de OUTRA aba que iniciou claude poucos s depois.
      if (!best || Math.abs(born - sinceMs) < Math.abs(best.born - sinceMs)) best = { id: sid, born }
    }
    return best?.id ?? null
  } catch {
    return null // dir não existe (claude nunca rodou neste cwd) etc.
  }
}

// Existe transcript da conversa <sid> no disco? Arquivo `<sid>.jsonl` OU pasta `<sid>/` (claude-code
// 2.x). Usado pra detectar "ghost bind": um sid vinculado que NUNCA virou conversa real (a conversa
// da aba divergiu por /clear ou um --session-id que não pegou) → o título jamais sincronizaria.
function claudeSessionExistsOnDisk(cwd: string, sid: string): boolean {
  const dir = join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd))
  try {
    if (statSync(join(dir, `${sid}.jsonl`)).isFile()) return true
  } catch {
    /* sem .jsonl */
  }
  try {
    if (statSync(join(dir, sid)).isDirectory()) return true
  } catch {
    /* sem pasta */
  }
  return false
}

// Log de diagnóstico do pipeline de título/vínculo, em ~/.decky/title-debug.log. SEMPRE ligado, mas
// minúsculo (só transições: claude em foreground, bind, resultado do título, emit). Existe porque o
// console do processo main se PERDE quando o decky é aberto pelo Finder (stdout sem terminal) — sem
// um arquivo não dá pra diagnosticar "aba sem título" numa máquina remota. Trunca em 128KB. Nunca
// derruba o poll: qualquer erro de I/O é engolido.
let titleLogPath: string | null = null
function titleLog(msg: string): void {
  try {
    if (!titleLogPath) {
      const dir = join(os.homedir(), '.decky')
      mkdirSync(dir, { recursive: true })
      titleLogPath = join(dir, 'title-debug.log')
    }
    try {
      if (statSync(titleLogPath).size > 131072) writeFileSync(titleLogPath, '')
    } catch {
      /* ainda não existe */
    }
    appendFileSync(titleLogPath, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* log nunca pode quebrar o poll */
  }
}

// Amostra crua do começo do .jsonl (1ª linha não-meta) — pro caso de aiTitle E firstPrompt darem
// null: preciso ver o SCHEMA do transcript daquela versão do claude pra ajustar o parser.
function titleHeadSample(file: string): string {
  try {
    const fd = openSync(file, 'r')
    const buf = Buffer.alloc(1200)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    return buf.toString('utf8', 0, n).replace(/\s+/g, ' ').slice(0, 600)
  } catch {
    return '(ilegível)'
  }
}

// Sync contínuo do título da aba a partir do .jsonl da conversa. Roda no poll pra cada aba com
// conversa do claude já resolvida (sidById). Gated por mtime do .jsonl (não re-parseia a cada 1.5s)
// e por valor (não re-emite o mesmo título).
// Prioridade: aiTitle (auto-gerado pelo claude) → primeiro prompt do usuário (fallback). O aiTitle
// só aparece após alguns turnos (e em versões antigas do claude — ex. 2.1.80 — NUNCA aparece); até
// lá usamos o 1º prompt, o MESMO que o picker "sessões anteriores" já mostra. Assim a aba nunca fica
// presa no placeholder aleatório, e quando o aiTitle chega ele sobrescreve o fallback.
function syncAiTitle(id: string, cwd: string, claudeSessionId: string): void {
  const file = claudeSessionFile(cwd, claudeSessionId)
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    titleLog(`[title] id=${id} sid=${claudeSessionId} SEM .jsonl no disco (${file})`)
    return
  }
  if (lastTitleMtime.get(id) === mtimeMs) return
  lastTitleMtime.set(id, mtimeMs)
  const ai = readLatestAiTitle(file)
  const fp = readFirstPrompt(file)
  const title = ai ?? fp
  titleLog(
    `[title] id=${id} sid=${claudeSessionId} aiTitle=${ai ? JSON.stringify(ai) : 'null'} firstPrompt=${fp ? JSON.stringify(fp) : 'null'}`
  )
  if (!ai && !fp) titleLog(`[title-null-head] id=${id} ${titleHeadSample(file)}`)
  if (!title || lastTitle.get(id) === title) return
  lastTitle.set(id, title)
  events.onTitle?.(id, title)
  titleLog(`[emit] id=${id} title=${JSON.stringify(title)}`)
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
      // CLAUDE acabou de virar foreground → marca o instante (âncora do birthtime), pra capturar a
      // conversa que ELE cria (.jsonl nascido depois daqui), não a mais escrita de outra aba. Marca
      // na PRIMEIRA aparição do claude (claudeOn ainda false) — vale tanto shell→claude direto QUANTO
      // shell→node→claude: o claude sobe como 'node' por um instante antes de setar o process title
      // pra versão (X.Y.Z), e exigir prev=shell PERDIA esse caso (node→claude tem prev='node' ≠ shell)
      // → claudeStartAt nunca era setado → sessão órfã, sem título. Tool-calls (claude→node→claude)
      // NÃO re-marcam (claudeOn já true, então a âncora não anda pra frente e a captura do 1º prompt
      // demorado segue válida). npm/node/vite soltos não entram (não passam em looksLikeClaude).
      if (looksLikeClaude(base) && !claudeOn.has(id)) {
        claudeStartAt.set(id, Date.now())
        // 1ª aparição do claude nesta run (tool-calls não re-disparam: claudeOn já fica true) → captura
        // a linha de lançamento pro "definir como default". term.pid = pid do shell desta aba.
        captureLaunchCmd(id, term.pid)
      }
      // claude em foreground (nome 'claude' ou a versão X.Y.Z) → flip imediato (responsivo p/ a
      // animação de borda).
      if (looksLikeClaude(base)) {
        if (!claudeOn.has(id)) titleLog(`[claude-fg] id=${id} proc=${JSON.stringify(proc)}`)
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
        boundLogged.delete(id) // próxima run re-loga [nobind] se voltar a não vincular
        clearAnnouncedSid(id) // descarta anúncio não-consumido desta run (evita re-vínculo stale)
        titleLog(`[unbind] id=${id} claude saiu pro shell`)
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

    // VÍNCULO aba↔conversa. Só enquanto o claude é o foreground desta aba (claudeOn — persiste em
    // tool-calls, some no retorno ao shell). Ordem: (1) anúncio determinístico do shim, (2) reconcile
    // de GHOST bind, (3) fallback por birthtime.
    if (claudeOn.has(id)) {
      const since = claudeStartAt.get(id) ?? 0

      // (1) DETERMINÍSTICO: a função `claude` do shim forçou --session-id e anunciou em
      // $DECKY_CLAUDE_SID_DIR/<id>. Consome e vincula na hora — sem adivinhar, sem esperar o .jsonl
      // nascer. Só quando ainda não há vínculo (anúncio de uma run nova, após voltar ao shell que
      // limpou o sid). Consumir o arquivo evita re-vincular stale depois.
      if (!sidById.has(id)) {
        const announced = readAnnouncedSid(id)
        if (announced) {
          titleLog(`[bind] id=${id} via=announce sid=${announced}`)
          sidById.set(id, announced)
          events.onClaude?.(id, { running: true, sessionId: announced })
        }
      }

      // claimed = sids já vinculados a QUALQUER outra aba viva (inclui semeados via --resume, que têm
      // sidById mas talvez não claudeStartAt). upperMs = launch da próxima aba SEM vínculo no mesmo cwd
      // que subiu claude depois de nós (conversa nascida após isso é dela — anti-swap).
      const claimed = new Set<string>()
      for (const [otherId, sid] of sidById) if (otherId !== id) claimed.add(sid)
      let upperMs = Infinity
      for (const [otherId, otherStart] of claudeStartAt) {
        if (otherId === id || sidById.has(otherId)) continue
        if ((cwdById.get(otherId) ?? os.homedir()) === cwd && otherStart > since && otherStart < upperMs) {
          upperMs = otherStart
        }
      }

      // (2) GHOST BIND: o sid vinculado NÃO tem transcript no disco embora o claude rode. Acontece
      // quando a conversa REAL da aba divergiu do sid fixado — /clear (gera um sid novo sem voltar ao
      // shell, então o vínculo nunca soltou) ou um --session-id que não virou transcript. Re-resolve
      // pra conversa de verdade sendo escrita no cwd. resolveByBirth só devolve sid que EXISTE no
      // disco, então um sid recém-anunciado cujo .jsonl ainda não nasceu NÃO acha candidato → não é
      // solto à toa. Sem isso, uma aba com /clear ficava presa a um sid morto, sem título, pra sempre.
      const bound = sidById.get(id)
      if (bound && since > 0 && !claudeSessionExistsOnDisk(cwd, bound)) {
        const real = resolveClaudeSessionByBirth(cwd, since, claimed, upperMs)
        if (real && real !== bound) {
          titleLog(`[bind] id=${id} via=ghost sid=${real} (era ${bound})`)
          sidById.set(id, real)
          lastTitleMtime.delete(id) // re-sincroniza o título do zero pra conversa nova
          lastTitle.delete(id)
          events.onClaude?.(id, { running: true, sessionId: real })
        }
      }

      // (3) FALLBACK por BIRTHTIME: claude fora do shim (bash, path absoluto, build antigo) → sem
      // anúncio. Captura a conversa que ESTA aba criou pelo birthtime do .jsonl/pasta. NÃO há janela de
      // 7s: o .jsonl nasce no 1º prompt (pode demorar) e o give-up orfanava sessões. claudeStartAt fica
      // ancorado na 1ª aparição do claude; o upperMs faz o anti-swap. `claude --resume X` não cria
      // .jsonl novo → resolve dá null (sem roubo).
      if (!sidById.has(id) && since > 0) {
        const sessionId = resolveClaudeSessionByBirth(cwd, since, claimed, upperMs)
        if (sessionId) {
          titleLog(`[bind] id=${id} via=birth sid=${sessionId}`)
          sidById.set(id, sessionId)
          events.onClaude?.(id, { running: true, sessionId })
        } else if (!boundLogged.has(id)) {
          // claude em foreground mas NENHUM caminho vinculou ainda (sem anúncio do shim e sem .jsonl
          // novo na janela de birthtime). Logo 1x por run — é o sintoma "aba presa sem título".
          boundLogged.add(id)
          const announceFile = join(claudeSidDir(), id)
          titleLog(
            `[nobind] id=${id} since=${since} announceFile=${existsSync(announceFile)} cwd=${cwd}`
          )
        }
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

// O process.env do decky.app pode estar CONTAMINADO: se o app foi iniciado de dentro de uma sessão
// claude (ex.: o "⟳ Rebuild" relança o app a partir de um claude), ele herda CLAUDECODE /
// CLAUDE_CODE_* / AI_AGENT. Se essas vars vazarem pro PTY, o `claude` rodado na aba se enxerga como
// uma SUB-SESSÃO filha (CLAUDE_CODE_CHILD_SESSION=1) → o claude-code NÃO persiste o transcript em
// ~/.claude/projects/<slug>/<sid>.jsonl → sem .jsonl → sem aiTitle → a aba fica eternamente no
// placeholder. Sessões abertas fora do decky (Terminal limpo) não têm isso e funcionam — era a
// diferença. Cada PTY tem que ser um shell de TOPO, limpo. Removemos a família de vars do claude.
function cleanParentEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (k === 'CLAUDECODE' || k === 'AI_AGENT' || k.startsWith('CLAUDE_CODE')) continue
    out[k] = v
  }
  return out
}

function spawnPty(args: CreatePtyArgs): void {
  const requestedFile = args.command?.[0] ?? args.shell ?? defaultShell()
  // O renderer pode ter mandado um path absoluto resolvido no host LOCAL (Mac); num engine
  // remoto esse path não existe. Refaz o resolve aqui, no host onde realmente vamos spawnar.
  const file = resolveBinForHost(requestedFile)
  // Comando custom (ex.: `claude --resume`) NÃO é um shell interativo → sem adapter (login/shim).
  // Shell puro → o adapter resolve argv (login+interativo) + env (HISTFILE isolado, ZDOTDIR shim).
  const plan = args.command ? null : planShellSpawn(file, args.id)
  const argv = args.command ? args.command.slice(1) : (plan?.args ?? [])

  let term: pty.IPty
  try {
    term = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd: args.cwd ?? os.homedir(),
      env: {
        ...cleanParentEnv(),
        // GUI launch gives us launchd's minimal PATH; restore the user's real
        // PATH so spawned tools (e.g. claude rodando manual, node, npx) sejam achados.
        // DECKY_BIN_DIR (setado pelo main) vai NA FRENTE — é o que torna o `decky` disponível
        // só dentro das sessões do decky (não está no PATH global do sistema).
        PATH: process.env.DECKY_BIN_DIR
          ? `${process.env.DECKY_BIN_DIR}:${loginShellPath()}`
          : loginShellPath(),
        DECKY_SESSION_ID: args.id,
        // Onde a função `claude` do shim anuncia o session id forçado (vínculo determinístico).
        DECKY_CLAUDE_SID_DIR: claudeSidDir(),
        DECKY_URL: process.env.DECKY_URL || 'http://127.0.0.1:6790',
        // Where this workspace's shared card files live, so tools can Glob/Read them.
        DECKY_CARDS_DIR: workspaceCardsDir(args.cwd ?? os.homedir()),
        // Histórico isolado por aba + shim do shell (ZDOTDIR no zsh) — ver shell-adapters.ts.
        ...(plan?.env ?? {})
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
    boundLogged.delete(args.id)
    clearAnnouncedSid(args.id)
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
