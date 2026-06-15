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
  const wanted = ['better-sqlite3', 'node-pty', 'marked', 'ws']
  const versions = rootPackageJsonVersions()
  const deps: Record<string, string> = {}
  for (const name of wanted) {
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
  /** workspace cwd no remote — vai ser passado pro renderer recriar o workspace. */
  workspacePath: string
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

/** Spawn de `ssh -N -L <local>:127.0.0.1:<remote>` pra criar o forward. */
async function openTunnel(host: string, identity: string | undefined, remotePort: number): Promise<TunnelHandle> {
  const parsed = parseHost(host)
  const userAtHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host
  const localPort = await pickFreeLocalPort()
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
    // pgrep retorna 1 se NÃO acha; pra evitar set -e quebrar o script, usamos || true
    // e checamos a saída. Logamos no decky-server.log pra debug.
    const startCmd = `bash -lc '
      cd "$HOME/.decky-server"
      if pgrep -f "decky-server.js" > /dev/null; then
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
