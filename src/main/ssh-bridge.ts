import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { Client, type ConnectConfig } from 'ssh2'
import type { DeckyWsServer } from '@decky/server'

// SSH bridge no main process — expõe ssh:exec via WS pro renderer mandar comandos rodarem
// num host remoto. Fica no main (não no @decky/server) porque a UX de "Add server" só faz
// sentido a partir do Electron client; o decky-server standalone NUNCA precisa fazer SSH.
//
// Auth precedence (igual o ssh CLI):
//   1. Identity explícito (path do arquivo da chave privada)
//   2. SSH config (~/.ssh/config) — TODO: ainda não parseado, próximas PRs
//   3. Chaves comuns: ~/.ssh/id_ed25519, id_rsa, id_ecdsa
//   4. ssh-agent — TODO: integração com SSH_AUTH_SOCK
//
// PR #25 cobre só (1) + (3); (2) e (4) entram quando precisar.

const COMMON_KEY_PATHS = [
  '.ssh/id_ed25519',
  '.ssh/id_rsa',
  '.ssh/id_ecdsa'
]

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
  // Tenta as chaves comuns na ordem
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
  // [user@]host[:port]
  let user: string | undefined
  let rest = trimmed
  const atIdx = rest.indexOf('@')
  if (atIdx >= 0) {
    user = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
  }
  let port = 22
  const colonIdx = rest.lastIndexOf(':')
  // ipv6 has multiple ":" — ignora se for nesse formato (futuro: [::1]:port)
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

const DEFAULT_TIMEOUT_MS = 10_000

export async function sshExec(args: SshExecArgs): Promise<SshExecResult> {
  let parsed: ParsedHost
  let privateKey: Buffer | null
  try {
    parsed = parseHost(args.host)
    privateKey = resolvePrivateKey(args.identity)
  } catch (err) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', error: (err as Error).message }
  }

  const config: ConnectConfig = {
    host: parsed.host,
    port: parsed.port,
    username: parsed.user || process.env.USER || 'root',
    readyTimeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
  if (privateKey) config.privateKey = privateKey

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
          settle({
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: '',
            error: err.message
          })
          return
        }
        let stdout = ''
        let stderr = ''
        stream
          .on('close', (code: number | null) => {
            clearTimeout(timer)
            settle({
              ok: code === 0,
              exitCode: code ?? null,
              stdout,
              stderr
            })
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
      settle({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: err.message
      })
    })

    try {
      client.connect(config)
    } catch (err) {
      clearTimeout(timer)
      settle({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: (err as Error).message
      })
    }
  })
}

export function registerSshHandlers(getWsServer: () => DeckyWsServer | null): void {
  const ws = getWsServer()
  if (!ws) return
  ws.handle<SshExecArgs, SshExecResult>('ssh:exec', (args) =>
    sshExec(args ?? { host: '', command: '' })
  )
}
