import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { app } from 'electron'
import { Client, type ConnectConfig } from 'ssh2'
import type { DeckyWsServer } from '@decky/server'

// SSH bridge no main process — expõe ssh:exec / ssh:install-decky-server via WS pro renderer.
// Fica no main (não no @decky/server) porque a UX de "Add server" só faz sentido a partir do
// Electron client; o decky-server standalone NUNCA precisa fazer SSH.
//
// Auth precedence (igual o ssh CLI):
//   1. Identity explícito (path do arquivo da chave privada)
//   2. SSH config (~/.ssh/config) — TODO: ainda não parseado
//   3. Chaves comuns: ~/.ssh/id_ed25519, id_rsa, id_ecdsa
//   4. ssh-agent — TODO: integração com SSH_AUTH_SOCK

const COMMON_KEY_PATHS = ['.ssh/id_ed25519', '.ssh/id_rsa', '.ssh/id_ecdsa']

function expandHome(p: string): string {
  if (p.startsWith('~/')) return `${homedir()}/${p.slice(2)}`
  if (p === '~') return homedir()
  return p
}

function tryReadKey(path: string): Buffer | null {
  try {
    return readFileSync(expandHome(path))
  } catch {
    return null
  }
}

function resolvePrivateKey(identityPath?: string): Buffer | null {
  if (identityPath && identityPath.trim()) {
    const key = tryReadKey(identityPath.trim())
    if (!key) throw new Error(`identity file not found or unreadable: ${identityPath}`)
    return key
  }
  for (const p of COMMON_KEY_PATHS) {
    const key = tryReadKey(`${homedir()}/${p}`)
    if (key) return key
  }
  return null
}

interface ParsedHost {
  user?: string
  host: string
  port: number
}

function parseHost(raw: string): ParsedHost {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('host required')
  let user: string | undefined
  let rest = trimmed
  const atIdx = rest.indexOf('@')
  if (atIdx >= 0) {
    user = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
  }
  let port = 22
  const colonIdx = rest.lastIndexOf(':')
  if (colonIdx >= 0 && !rest.includes('::')) {
    const portStr = rest.slice(colonIdx + 1)
    const n = Number(portStr)
    if (Number.isFinite(n) && n > 0 && n < 65536) {
      port = n
      rest = rest.slice(0, colonIdx)
    }
  }
  return { user, host: rest, port }
}

function buildConfig(host: string, identity: string | undefined, timeoutMs: number): ConnectConfig {
  const parsed = parseHost(host)
  const privateKey = resolvePrivateKey(identity)
  const config: ConnectConfig = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.user || process.env.USER || 'root',
    readyTimeout: timeoutMs
  }
  if (privateKey) config.privateKey = privateKey
  return config
}

const DEFAULT_TIMEOUT_MS = 10_000

// ── ssh:exec — comando único, conexão own-and-die ──────────────────────────

export interface SshExecResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
}

interface SshExecArgs {
  host: string
  command: string
  identity?: string
  /** Default 10s. Comandos longos (npm install) usam timeouts maiores. */
  timeoutMs?: number
}

export async function sshExec(args: SshExecArgs): Promise<SshExecResult> {
  let config: ConnectConfig
  try {
    config = buildConfig(args.host, args.identity, args.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch (err) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', error: (err as Error).message }
  }

  return new Promise<SshExecResult>((resolve) => {
    const client = new Client()
    let settled = false
    const settle = (r: SshExecResult): void => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // ignore
      }
      resolve(r)
    }

    const timer = setTimeout(() => {
      settle({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: `timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      })
    }, (args.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5_000)

    client.on('ready', () => {
      client.exec(args.command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          settle({ ok: false, exitCode: null, stdout: '', stderr: '', error: err.message })
          return
        }
        let stdout = ''
        let stderr = ''
        stream
          .on('close', (code: number | null) => {
            clearTimeout(timer)
            settle({ ok: code === 0, exitCode: code ?? null, stdout, stderr })
          })
          .on('data', (data: Buffer) => {
            stdout += data.toString('utf-8')
          })
          .stderr.on('data', (data: Buffer) => {
            stderr += data.toString('utf-8')
          })
      })
    })

    client.on('error', (err) => {
      clearTimeout(timer)
      settle({ ok: false, exitCode: null, stdout: '', stderr: '', error: err.message })
    })

    try {
      client.connect(config)
    } catch (err) {
      clearTimeout(timer)
      settle({ ok: false, exitCode: null, stdout: '', stderr: '', error: (err as Error).message })
    }
  })
}

// ── ssh-session helpers — conexão reusada entre vários comandos ────────────

interface SshSession {
  client: Client
  end: () => void
}

function sshConnect(host: string, identity: string | undefined): Promise<SshSession> {
  const config = buildConfig(host, identity, 15_000)
  return new Promise<SshSession>((resolve, reject) => {
    const client = new Client()
    let resolved = false
    client.on('ready', () => {
      resolved = true
      resolve({
        client,
        end() {
          try {
            client.end()
          } catch {
            // ignore
          }
        }
      })
    })
    client.on('error', (err) => {
      if (resolved) return
      reject(err)
    })
    try {
      client.connect(config)
    } catch (err) {
      reject(err)
    }
  })
}

function execOn(
  client: Client,
  cmd: string,
  timeoutMs = 30_000
): Promise<SshExecResult> {
  return new Promise<SshExecResult>((resolve) => {
    let settled = false
    const settle = (r: SshExecResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const timer = setTimeout(() => {
      settle({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: `timed out after ${timeoutMs}ms`
      })
    }, timeoutMs)
    client.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer)
        settle({ ok: false, exitCode: null, stdout: '', stderr: '', error: err.message })
        return
      }
      let stdout = ''
      let stderr = ''
      stream
        .on('close', (code: number | null) => {
          clearTimeout(timer)
          settle({ ok: code === 0, exitCode: code ?? null, stdout, stderr })
        })
        .on('data', (data: Buffer) => {
          stdout += data.toString('utf-8')
        })
        .stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8')
        })
    })
  })
}

function putOn(
  client: Client,
  localPath: string,
  remotePath: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    client.sftp((err, sftp) => {
      if (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      sftp.fastPut(localPath, remotePath, (putErr) => {
        if (putErr) {
          resolve({ ok: false, error: putErr.message })
          return
        }
        resolve({ ok: true })
      })
    })
  })
}

// ── Install pipeline — orquestra steps + emite progress ────────────────────

function findServerBundlePath(): string {
  // app.getAppPath() em dev aponta pro repo root; em packaged aponta pra Resources/app.
  // Em ambos os casos packages/decky-server/dist/decky-server.js DEVE existir (em packaged só
  // se electron-builder inclua — TODO no .yml). Tentamos alguns paths plausíveis e damos
  // erro guiado se não acharmos.
  const appPath = app.getAppPath()
  const candidates = [
    join(appPath, 'packages/decky-server/dist/decky-server.js'),
    join(appPath, '..', 'packages/decky-server/dist/decky-server.js'),
    join(appPath, '..', '..', 'packages/decky-server/dist/decky-server.js')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    'decky-server bundle not found locally. Run `npm run build --workspace @decky/server` first.'
  )
}

function rootPackageJsonVersions(): Record<string, string> {
  // package.json do projeto — versões das deps a serem espelhadas no remote.
  const appPath = app.getAppPath()
  const candidates = [
    join(appPath, 'package.json'),
    join(appPath, '..', 'package.json'),
    join(appPath, '..', '..', 'package.json')
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const pkg = JSON.parse(readFileSync(c, 'utf-8')) as { dependencies?: Record<string, string> }
        return pkg.dependencies ?? {}
      } catch {
        // try next
      }
    }
  }
  return {}
}

function buildRemotePackageJson(): string {
  // Top-level deps que o bundle do decky-server precisa em runtime. As transitivas (bindings,
  // file-uri-to-path, asn1, bcrypt-pbkdf, tweetnacl) virão automaticamente.
  // @anthropic-ai/claude-code: o CLI que o pty spawna pra sessões 'claude'. Sem ele, o
  // execvp falha "No such file or directory" e o usuário vê só uma mensagem críptica.
  // Instalado local em ~/.decky-server/node_modules/.bin/claude → sem sudo, sem PATH global.
  const wanted = ['better-sqlite3', 'node-pty', 'marked', 'ws', '@anthropic-ai/claude-code']
  const versions = rootPackageJsonVersions()
  const deps: Record<string, string> = {}
  for (const name of wanted) {
    // claude-code só existe no npm — não está no root package.json. Usa 'latest' como default.
    deps[name] = versions[name] ?? 'latest'
  }
  const pkg = {
    name: 'decky-server-install',
    version: '0.0.1',
    private: true,
    dependencies: deps
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

export interface InstallStep {
  id: string
  state: 'pending' | 'running' | 'ok' | 'error'
  detail?: string
}

export type InstallProgressEvent =
  | { kind: 'step'; step: InstallStep }
  | { kind: 'log'; line: string }
  | { kind: 'done'; ok: boolean; error?: string }

const INSTALL_STEPS = [
  'node-check',
  'mkdir',
  'upload-bundle',
  'write-package',
  'npm-install'
] as const

export interface InstallDeckyServerArgs {
  host: string
  identity?: string
}

interface InstallContext {
  host: string
  identity?: string
  emit: (e: InstallProgressEvent) => void
}

async function doInstall(ctx: InstallContext): Promise<{ ok: boolean; error?: string }> {
  const emitStep = (id: string, state: InstallStep['state'], detail?: string): void =>
    ctx.emit({ kind: 'step', step: { id, state, detail } })
  const emitLog = (line: string): void => ctx.emit({ kind: 'log', line })

  // Sinaliza todos os steps como pending no começo pra UI mostrar a lista completa.
  for (const id of INSTALL_STEPS) emitStep(id, 'pending')

  let bundlePath: string
  let packageJsonContents: string
  try {
    bundlePath = findServerBundlePath()
    packageJsonContents = buildRemotePackageJson()
  } catch (err) {
    const msg = (err as Error).message
    emitLog(msg)
    return { ok: false, error: msg }
  }

  let session: SshSession
  try {
    session = await sshConnect(ctx.host, ctx.identity)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  try {
    // STEP 1 — check Node
    emitStep('node-check', 'running')
    const node = await execOn(session.client, 'which node && node --version', 6_000)
    if (!node.ok) {
      const msg =
        node.stderr.trim() ||
        node.error ||
        'Node.js não encontrado no host. Instale antes (apt install nodejs ou nodesource.com).'
      emitStep('node-check', 'error', msg)
      return { ok: false, error: msg }
    }
    const nodeLine = node.stdout.trim().split('\n').pop() ?? ''
    emitStep('node-check', 'ok', nodeLine)
    emitLog(node.stdout.trim())

    // STEP 2 — mkdir
    emitStep('mkdir', 'running')
    const mk = await execOn(
      session.client,
      'bash -c "mkdir -p $HOME/.decky-server/dist && echo OK"',
      6_000
    )
    if (!mk.ok || !mk.stdout.includes('OK')) {
      const msg = mk.stderr.trim() || mk.error || 'mkdir failed'
      emitStep('mkdir', 'error', msg)
      return { ok: false, error: msg }
    }
    emitStep('mkdir', 'ok')

    // STEP 3 — upload bundle via SFTP
    emitStep('upload-bundle', 'running', `${bundlePath.split('/').pop()}`)
    // Descobre o $HOME absoluto pra usar no SFTP (não expande ~).
    const home = await execOn(session.client, 'echo $HOME', 3_000)
    const homeDir = home.stdout.trim()
    if (!home.ok || !homeDir) {
      emitStep('upload-bundle', 'error', '$HOME resolution failed')
      return { ok: false, error: 'could not resolve $HOME on remote' }
    }
    const remoteBundlePath = `${homeDir}/.decky-server/dist/decky-server.js`
    const up = await putOn(session.client, bundlePath, remoteBundlePath)
    if (!up.ok) {
      emitStep('upload-bundle', 'error', up.error)
      return { ok: false, error: up.error ?? 'upload failed' }
    }
    emitStep('upload-bundle', 'ok')

    // STEP 4 — write package.json via cat heredoc
    emitStep('write-package', 'running')
    const escaped = packageJsonContents.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
    const writeCmd = `bash -c 'cat > "$HOME/.decky-server/package.json" <<"EOF"\n${escaped}EOF\n'`
    const w = await execOn(session.client, writeCmd, 6_000)
    if (!w.ok) {
      const msg = w.stderr.trim() || w.error || 'write package.json failed'
      emitStep('write-package', 'error', msg)
      return { ok: false, error: msg }
    }
    emitStep('write-package', 'ok')

    // STEP 5 — npm install (LENTO no RP4; pode demorar minutos)
    emitStep('npm-install', 'running', 'npm install --omit=dev')
    const npmCmd =
      'cd "$HOME/.decky-server" && npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1'
    const ni = await execOn(session.client, npmCmd, 5 * 60_000)
    if (!ni.ok) {
      const msg = ni.stdout.trim().split('\n').slice(-3).join('\n') || ni.error || 'npm install failed'
      emitLog(ni.stdout)
      emitStep('npm-install', 'error', msg)
      return { ok: false, error: msg }
    }
    emitLog(ni.stdout)
    emitStep('npm-install', 'ok')

    return { ok: true }
  } finally {
    session.end()
  }
}

// ── Start server + SSH tunnel ──────────────────────────────────────────────

const REMOTE_SERVER_PORT = 8447
// Live View do handoff escuta na 6789 no host onde o claude roda. Pra cards HTML do
// workspace remoto referenciarem o iframe `http://127.0.0.1:6789/tab/X` direto, abrimos
// um tunnel extra com porta LOCAL fixa = 6789. Se 6789 local estiver ocupada, skipa.
const LIVE_VIEW_PORT = 6789

// Tunnels secundários: 1 por host, vida atrelada ao tunnel principal. Não bloqueiam
// open-remote — best-effort.
const extraTunnels = new Map<string, TunnelHandle>()
const TOKEN_WAIT_TIMEOUT_MS = 10_000
const TOKEN_WAIT_INTERVAL_MS = 300

export interface OpenRemoteResult {
  ok: boolean
  /** URL local que o Electron renderer vai usar como DECKY_REMOTE_WS_URL. */
  localUrl?: string
  token?: string
  error?: string
}

export interface OpenRemoteArgs {
  host: string
  identity?: string
}

async function pickFreeLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        reject(new Error('failed to bind ephemeral port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

interface TunnelHandle {
  localPort: number
  proc: ChildProcess
  kill: () => void
}

const tunnels = new Map<string, TunnelHandle>()

/** Spawn de `ssh -N -L <local>:127.0.0.1:<remote>` pra criar o forward.
 *  Se `desiredLocalPort` for setado, tenta bind nele (não dinâmico). Usado pra portas
 *  bem-conhecidas do host remoto (Live View = 6789) — cards HTML com URLs hardcoded
 *  `http://127.0.0.1:6789` falham se virar uma porta aleatória.
 */
async function openTunnel(
  host: string,
  identity: string | undefined,
  remotePort: number,
  desiredLocalPort?: number
): Promise<TunnelHandle> {
  const parsed = parseHost(host)
  const userAtHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host
  const localPort = desiredLocalPort ?? (await pickFreeLocalPort())
  const sshArgs = [
    '-N',
    '-L',
    `${localPort}:127.0.0.1:${remotePort}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-p',
    String(parsed.port)
  ]
  if (identity && identity.trim()) {
    sshArgs.push('-i', expandHome(identity.trim()))
  }
  sshArgs.push(userAtHost)

  const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  // Pequeno wait pra que o forward esteja realmente listening — ssh é silencioso quando OK.
  await new Promise<void>((resolve, reject) => {
    let resolved = false
    const onExit = (code: number | null): void => {
      if (resolved) return
      reject(new Error(`ssh tunnel exited (code ${code}) before forward established`))
    }
    proc.on('exit', onExit)
    setTimeout(() => {
      if (!proc.killed) {
        resolved = true
        proc.off('exit', onExit)
        resolve()
      }
    }, 1200)
  })

  return {
    localPort,
    proc,
    kill: () => {
      try {
        proc.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }
}

async function doOpenRemote(ctx: {
  host: string
  identity?: string
  emit: (e: InstallProgressEvent) => void
}): Promise<OpenRemoteResult> {
  const emitStep = (id: string, state: InstallStep['state'], detail?: string): void =>
    ctx.emit({ kind: 'step', step: { id, state, detail } })

  emitStep('start-server', 'pending')
  emitStep('wait-token', 'pending')
  emitStep('open-tunnel', 'pending')

  let session: SshSession
  try {
    session = await sshConnect(ctx.host, ctx.identity)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  try {
    // STEP 1 — start server in background (idempotente — se já estiver rodando, reuso).
    emitStep('start-server', 'running')
    // Detection pela porta (lsof) — pgrep -f "decky-server.js" sofria self-match (o próprio
    // script bash que roda o if contém "decky-server.js" na string). Fallback pra ss caso
    // lsof não esteja no host. Se nem um nem outro estiverem, tenta iniciar mesmo assim:
    // se já tiver alguém na porta, o server-side falha na hora e aparece em wait-token.
    const startCmd = `bash -lc '
      cd "$HOME/.decky-server"
      RUNNING=0
      if command -v lsof > /dev/null 2>&1; then
        if lsof -ti:8447 > /dev/null 2>&1; then RUNNING=1; fi
      elif command -v ss > /dev/null 2>&1; then
        if ss -ltn 2>/dev/null | grep -q ":8447 "; then RUNNING=1; fi
      fi
      if [ "$RUNNING" = "1" ]; then
        echo "ALREADY_RUNNING"
      else
        nohup node dist/decky-server.js start \
          > "$HOME/.decky-server/decky-server.log" 2>&1 &
        disown
        echo "STARTED $!"
      fi
    '`
    const start = await execOn(session.client, startCmd, 15_000)
    if (!start.ok) {
      const msg = start.stderr.trim() || start.error || 'failed to start decky-server'
      emitStep('start-server', 'error', msg)
      return { ok: false, error: msg }
    }
    const started = start.stdout.trim()
    emitStep('start-server', 'ok', started)

    // STEP 2 — wait for admin-token.txt to appear (server cria na 1ª boot)
    emitStep('wait-token', 'running')
    const tokenWaitCmd = `bash -lc '
      i=0
      while [ $i -lt ${Math.floor(TOKEN_WAIT_TIMEOUT_MS / TOKEN_WAIT_INTERVAL_MS)} ]; do
        if [ -f "$HOME/.decky-server/admin-token.txt" ]; then
          cat "$HOME/.decky-server/admin-token.txt"
          exit 0
        fi
        sleep ${(TOKEN_WAIT_INTERVAL_MS / 1000).toFixed(1)}
        i=$((i+1))
      done
      echo "TOKEN_TIMEOUT" >&2
      exit 1
    '`
    const tokenWait = await execOn(session.client, tokenWaitCmd, TOKEN_WAIT_TIMEOUT_MS + 3_000)
    if (!tokenWait.ok) {
      const msg =
        tokenWait.stderr.trim() ||
        tokenWait.error ||
        'token file did not appear in time (decky-server crashed at boot?)'
      emitStep('wait-token', 'error', msg)
      return { ok: false, error: msg }
    }
    const token = tokenWait.stdout.trim()
    emitStep('wait-token', 'ok', token.slice(0, 14) + '…')

    // Encerra a sessão SSH "exec" — daqui pra frente é só a sessão de tunnel que importa.
    session.end()

    // STEP 3 — open SSH local forward
    emitStep('open-tunnel', 'running')
    let tunnel: TunnelHandle
    try {
      tunnel = await openTunnel(ctx.host, ctx.identity, REMOTE_SERVER_PORT)
    } catch (err) {
      emitStep('open-tunnel', 'error', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
    // Mantém o tunnel vivo. Mata o anterior se o usuário trocar de host.
    const prev = tunnels.get(ctx.host)
    if (prev) prev.kill()
    tunnels.set(ctx.host, tunnel)
    // Garantia: se o decky fechar antes do user, o tunnel cai junto.
    app.on('before-quit', () => tunnel.kill())

    // Tunnel best-effort pra Live View do handoff (porta 6789). Cards HTML remotos com
    // iframes `http://127.0.0.1:6789/tab/X` passam a ver o handoff do PI via essa porta
    // LOCAL no Mac. Falha (ex: 6789 ocupada por outro processo) é só warning — não derruba
    // open-remote, só significa que esses iframes vão continuar em branco até liberar a porta.
    const prevExtra = extraTunnels.get(ctx.host)
    if (prevExtra) prevExtra.kill()
    try {
      const extra = await openTunnel(ctx.host, ctx.identity, LIVE_VIEW_PORT, LIVE_VIEW_PORT)
      extraTunnels.set(ctx.host, extra)
      app.on('before-quit', () => extra.kill())
      console.log(`[ssh] live-view tunnel up: 127.0.0.1:${LIVE_VIEW_PORT} → ${ctx.host}:${LIVE_VIEW_PORT}`)
    } catch (err) {
      console.warn(`[ssh] live-view tunnel (port ${LIVE_VIEW_PORT}) failed: ${(err as Error).message}`)
    }

    const localUrl = `ws://127.0.0.1:${tunnel.localPort}`
    emitStep('open-tunnel', 'ok', `${localUrl}`)
    return { ok: true, localUrl, token }
  } catch (err) {
    session.end()
    return { ok: false, error: (err as Error).message }
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

export function registerSshHandlers(getWsServer: () => DeckyWsServer | null): void {
  const ws = getWsServer()
  if (!ws) return
  ws.handle<SshExecArgs, SshExecResult>('ssh:exec', (args) =>
    sshExec(args ?? { host: '', command: '' })
  )
  ws.handle<InstallDeckyServerArgs, { ok: boolean; error?: string }>(
    'ssh:install-decky-server',
    async (args) => {
      if (!args?.host) return { ok: false, error: 'host required' }
      return doInstall({
        host: args.host,
        identity: args.identity,
        emit: (e) => ws.broadcast('ssh:install-progress', e)
      })
    }
  )
  ws.handle<OpenRemoteArgs, OpenRemoteResult>('ssh:open-remote', async (args) => {
    if (!args?.host) return { ok: false, error: 'host required' }
    return doOpenRemote({
      host: args.host,
      identity: args.identity,
      emit: (e) => ws.broadcast('ssh:install-progress', e)
    })
  })
}

/**
 * Versão silenciosa do open-remote — pra reconexão automática no boot. Não emite progress
 * events (ninguém tá escutando). Mesmo flow que ssh:open-remote (start server idempotente +
 * lê token + abre tunnel SSH local forward), mas sem UI feedback.
 */
export async function openRemoteSilent(
  host: string,
  identity: string | undefined
): Promise<OpenRemoteResult> {
  return doOpenRemote({ host, identity, emit: () => {} })
}

// ── Sync remote: rebuild local → sobe bundles novos pro engine remoto ─────────

function sha256OfFile(path: string): string | null {
  try {
    const buf = readFileSync(path)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

function findOptionalBundle(relPath: string): string | null {
  const appPath = app.getAppPath()
  const candidates = [
    join(appPath, relPath),
    join(appPath, '..', relPath),
    join(appPath, '..', '..', relPath)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export interface SyncResult {
  ok: boolean
  uploaded: string[]
  skipped: string[]
  error?: string
}

/**
 * Sobe os bundles atualizados (decky-server.js, dk-mcp.js, web/index.html) pro engine remoto
 * via SSH/SFTP. Compara SHA256 local vs remoto (via `sha256sum`) — só sobe o que mudou.
 * Após upload, mata o server e reinicia. Quem chamar precisa REABRIR o tunnel SSH local pra
 * pegar a nova porta dinâmica do server reiniciado (doOpenRemote faz isso).
 */
export async function syncServerBundlesToRemote(
  host: string,
  identity: string | undefined
): Promise<SyncResult> {
  const result: SyncResult = { ok: true, uploaded: [], skipped: [] }

  const localServer = findOptionalBundle('packages/decky-server/dist/decky-server.js')
  const localDkMcp = findOptionalBundle('packages/decky-server/dist/dk-mcp.bundled.js')
  const localWeb = findOptionalBundle('packages/decky-server/web/index.html')
  if (!localServer) {
    return { ok: false, uploaded: [], skipped: [], error: 'decky-server.js bundle não encontrado local — rode build primeiro' }
  }

  let session: SshSession
  try {
    session = await sshConnect(host, identity)
  } catch (err) {
    return { ok: false, uploaded: [], skipped: [], error: (err as Error).message }
  }

  try {
    const home = await execOn(session.client, 'echo $HOME', 3_000)
    const homeDir = home.stdout.trim()
    if (!home.ok || !homeDir) {
      return { ok: false, uploaded: [], skipped: [], error: '$HOME unresolved' }
    }
    const remoteBase = `${homeDir}/.decky-server`

    // Garante dirs.
    await execOn(session.client, `mkdir -p "${remoteBase}/dist" "${remoteBase}/web"`, 6_000)

    const tasks: Array<{ name: string; local: string; remote: string }> = [
      { name: 'decky-server.js', local: localServer, remote: `${remoteBase}/dist/decky-server.js` }
    ]
    if (localDkMcp) tasks.push({ name: 'dk-mcp.js', local: localDkMcp, remote: `${remoteBase}/dk-mcp.js` })
    if (localWeb) tasks.push({ name: 'web/index.html', local: localWeb, remote: `${remoteBase}/web/index.html` })

    for (const t of tasks) {
      const localHash = sha256OfFile(t.local)
      if (!localHash) continue
      // Best-effort: pega hash remoto. Se sha256sum não existir ou der erro, considera diff.
      const remoteHashCheck = await execOn(
        session.client,
        `sha256sum "${t.remote}" 2>/dev/null | awk '{print $1}' || true`,
        5_000
      )
      const remoteHash = remoteHashCheck.stdout.trim()
      if (remoteHash && remoteHash === localHash) {
        result.skipped.push(t.name)
        continue
      }
      const up = await putOn(session.client, t.local, t.remote)
      if (!up.ok) {
        return { ok: false, uploaded: result.uploaded, skipped: result.skipped, error: `${t.name}: ${up.error}` }
      }
      result.uploaded.push(t.name)
    }

    // Se subiu o decky-server.js, restart no remoto. Outros bundles não precisam restart
    // (dk-mcp é spawnado pelo claude on-demand; web é HTTP estático servido como-is).
    if (result.uploaded.includes('decky-server.js')) {
      await execOn(
        session.client,
        `PID=$(lsof -ti:8447 2>/dev/null); if [ -n "$PID" ]; then kill "$PID"; sleep 1; fi
         cd ${remoteBase} && nohup node dist/decky-server.js start >> ${remoteBase}/decky-server.log 2>&1 < /dev/null & disown
         sleep 2
         lsof -ti:8447 >/dev/null && echo restarted || echo failed-to-start`,
        15_000
      )
    }

    return result
  } finally {
    session.end()
  }
}
