import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http'
import { extname, join, normalize, resolve as resolvePath } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
  bootstrapApprove,
  findApprovedById,
  requestPairing,
  touchLastSeen,
  waitForPairing
} from './devices'

// WebSocket server pro decky-server: 1 transport pra TODO o protocolo (sessões, cards, widgets,
// preview, browser-manager). Para Fase 2 (loopback), roda em 127.0.0.1:<porta-livre> sem auth.
// Para Fase 3 (remoto), o mesmo server passa a aceitar token bearer + TLS terminado por proxy
// (Tailscale/Caddy). O shape do protocolo já é stateless (cada msg tem reqId), preparado pra
// multi-device (vários clients no mesmo server, broadcast push-style).

export interface WsMessage<TArgs = unknown> {
  v: 1
  kind: string
  /** Presente em req/resp. Ausente em fire-and-forget (envio sem espera). */
  reqId?: string
  args?: TArgs
}

export interface WsReply<TResult = unknown> {
  v: 1
  kind: 'reply'
  reqId: string
  ok: boolean
  result?: TResult
  error?: string
}

export type WsHandler<TArgs = unknown, TResult = unknown> = (
  args: TArgs
) => Promise<TResult> | TResult

export interface DeckyWsServer {
  /** Registra um handler req/resp para um kind ('cli:list', 'cards:write', etc). */
  handle<TArgs = unknown, TResult = unknown>(
    kind: string,
    fn: WsHandler<TArgs, TResult>
  ): void
  /** Broadcast pra TODOS clients conectados — eventos push (file:changed, pty:data, etc). */
  broadcast(kind: string, args: unknown): void
  /** URL onde tá escutando (já com porta resolvida). */
  url: string
  /** Porta efetiva (útil pra passar pro client local). */
  port: number
  /** Quantos clients ativos. */
  clientCount(): number
  /** Fecha o server graciosamente. */
  close(): Promise<void>
}

export interface WsServerOpts {
  /** Default '127.0.0.1' (loopback). Pra expor publicamente, '0.0.0.0' + TLS por proxy. */
  host?: string
  /** Default 0 (porta livre escolhida pelo kernel). */
  port?: number
  /**
   * Se setado, exige token bearer no header `Authorization` OU query param `?token=`.
   * Em modo loopback (Fase 2) deixa null/undefined — só processo local conecta.
   */
  token?: string | null
  /**
   * Se setado, o mesmo httpServer que atende WS upgrade serve arquivos estáticos a partir deste
   * diretório. Útil pro PWA cliente: o browser carrega o bundle do renderer da mesma porta do
   * WS, sem precisar de outra infra. Path-traversal é bloqueado.
   */
  staticRoot?: string
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.end()
    return
  }
  // Tira query string + decode + normalize, rejeita traversal.
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch {
    res.statusCode = 400
    res.end()
    return
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html'
  const candidate = normalize(join(root, pathname))
  if (!candidate.startsWith(root)) {
    res.statusCode = 403
    res.end()
    return
  }
  try {
    const st = await stat(candidate)
    // Diretórios viram index.html dentro deles (SPA-friendly pra rotas filhas).
    const target = st.isDirectory() ? join(candidate, 'index.html') : candidate
    const st2 = st.isDirectory() ? await stat(target) : st
    const mime = STATIC_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    res.statusCode = 200
    res.setHeader('content-type', mime)
    res.setHeader('content-length', String(st2.size))
    res.setHeader('cache-control', 'no-cache')
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target).on('error', () => {
      if (!res.headersSent) res.statusCode = 500
      res.end()
    }).pipe(res)
  } catch {
    // SPA fallback: paths sem arquivo viram index.html — necessário pro client-side router.
    try {
      const fallback = join(root, 'index.html')
      const fst = await stat(fallback)
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('content-length', String(fst.size))
      res.setHeader('cache-control', 'no-cache')
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(fallback).on('error', () => {
        if (!res.headersSent) res.statusCode = 500
        res.end()
      }).pipe(res)
    } catch {
      res.statusCode = 404
      res.end()
    }
  }
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

export async function startWsServer(opts: WsServerOpts = {}): Promise<DeckyWsServer> {
  const host = opts.host ?? '127.0.0.1'
  const requestedPort = opts.port ?? 0
  const requiredToken = opts.token ?? null
  const staticRoot = opts.staticRoot ? resolvePath(opts.staticRoot) : null

  const handlers = new Map<string, WsHandler>()
  const clients = new Set<WebSocket>()

  const httpServer: HttpServer = createServer((req, res) => {
    // Endpoints de auth ANTES do static — fluxo de pareamento sem JS bundle precisa atender.
    if (req.url && req.url.startsWith('/auth/')) {
      void handleAuthRequest(req, res, requiredToken)
      return
    }
    if (!staticRoot) {
      res.statusCode = 404
      res.end()
      return
    }
    serveStatic(req, res, staticRoot)
  })
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    // Auth: prioridade pra cookie de device aprovado. Token (admin) ainda funciona pra
    // bootstrap e recovery; quando passa via ?token=, faz auto-approve do device atual.
    void (async () => {
      if (!requiredToken) {
        clients.add(ws)
        return
      }
      const url = new URL(req.url || '/', `http://${host}`)
      const cookies = parseCookies(req.headers['cookie'] as string | undefined)
      const deviceId = cookies[DEVICE_COOKIE]
      if (deviceId) {
        const dev = await findApprovedById(deviceId)
        if (dev) {
          await touchLastSeen(deviceId)
          clients.add(ws)
          return
        }
      }
      const tokenFromQuery = url.searchParams.get('token')
      const auth = (req.headers['authorization'] as string | undefined) ?? ''
      const tokenFromHeader = auth.replace(/^Bearer\s+/i, '')
      const provided = tokenFromHeader || tokenFromQuery
      if (provided === requiredToken) {
        // Bootstrap: WS conectou com admin-token sem cookie de device. Não cria approved aqui
        // (não temos jeito de devolver Set-Cookie no WS handshake após upgrade). Funciona pra
        // recovery via HTTP POST /auth/bootstrap. Mantém compat com clientes WS antigos.
        clients.add(ws)
        return
      }
      ws.close(4001, 'unauthorized')
    })()

    ws.on('message', (data) => {
      let msg: WsMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.v !== 1 || typeof msg.kind !== 'string') return

      void dispatch(ws, msg)
    })

    ws.on('close', () => clients.delete(ws))
    ws.on('error', (err) => {
      console.error('[ws-server] client error:', err)
      clients.delete(ws)
    })
  })

  async function dispatch(ws: WebSocket, msg: WsMessage): Promise<void> {
    const handler = handlers.get(msg.kind)
    if (!handler) {
      if (msg.reqId) {
        replyError(ws, msg.reqId, `unknown kind: ${msg.kind}`)
      }
      return
    }
    try {
      const result = await handler(msg.args)
      if (msg.reqId) replyOk(ws, msg.reqId, result)
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      if (msg.reqId) replyError(ws, msg.reqId, message)
      else console.error(`[ws-server] handler ${msg.kind} threw:`, err)
    }
  }

  function replyOk(ws: WebSocket, reqId: string, result: unknown): void {
    const reply: WsReply = { v: 1, kind: 'reply', reqId, ok: true, result }
    safeSend(ws, JSON.stringify(reply))
  }

  function replyError(ws: WebSocket, reqId: string, error: string): void {
    const reply: WsReply = { v: 1, kind: 'reply', reqId, ok: false, error }
    safeSend(ws, JSON.stringify(reply))
  }

  function safeSend(ws: WebSocket, payload: string): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload)
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(requestedPort, host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const addr = httpServer.address()
  if (!addr || typeof addr === 'string') {
    throw new Error('ws-server: failed to bind')
  }
  const port = addr.port

  return {
    url: `ws://${host}:${port}`,
    port,
    handle(kind, fn) {
      handlers.set(kind, fn as WsHandler)
    },
    broadcast(kind, args) {
      const payload = JSON.stringify({ v: 1, kind, args })
      for (const ws of clients) safeSend(ws, payload)
    },
    clientCount(): number {
      return clients.size
    },
    async close(): Promise<void> {
      for (const ws of clients) {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
      clients.clear()
      await new Promise<void>((resolve) => {
        wss.close(() => resolve())
      })
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      })
    }
  }
}

// ── Auth: cookie + endpoints HTTP /auth/* ─────────────────────────────────────
const DEVICE_COOKIE = 'decky-device-id'
const PENDING_COOKIE = 'decky-pending-id'

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

function setCookie(res: ServerResponse, name: string, value: string, maxAgeSec: number): void {
  // SameSite=Lax pra funcionar bem em mobile (Strict bloqueia top-level nav refresh).
  // Sem Secure por enquanto — quando rolar HTTPS via tailscale serve, adiciona.
  const prev = res.getHeader('set-cookie')
  const cookieStr = `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`
  const all = Array.isArray(prev) ? [...prev, cookieStr] : prev ? [String(prev), cookieStr] : [cookieStr]
  res.setHeader('set-cookie', all)
}

function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, '', 0)
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8') || '{}'
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  adminToken: string | null
): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const cookies = parseCookies(req.headers['cookie'] as string | undefined)
    const ua = (req.headers['user-agent'] as string | undefined) ?? 'unknown'
    const ip = clientIp(req)

    // GET /auth/me — devolve estado: approved / pending / nada. Browser usa pra rotear UI.
    if (req.method === 'GET' && url.pathname === '/auth/me') {
      const deviceId = cookies[DEVICE_COOKIE]
      if (deviceId) {
        const dev = await findApprovedById(deviceId)
        if (dev) {
          await touchLastSeen(deviceId)
          jsonResponse(res, 200, {
            approved: true,
            device: { id: dev.id, name: dev.name }
          })
          return
        }
        // Cookie inválido (revogado, file resetado) — limpa.
        clearCookie(res, DEVICE_COOKIE)
      }
      const pendingId = cookies[PENDING_COOKIE]
      if (pendingId) {
        const { listAll } = await import('./devices')
        const all = await listAll()
        const p = all.pending.find((x) => x.id === pendingId)
        if (p) {
          jsonResponse(res, 200, {
            approved: false,
            pending: { id: p.id, code: p.code, expiresAt: p.expiresAt }
          })
          return
        }
        clearCookie(res, PENDING_COOKIE)
      }
      jsonResponse(res, 200, { approved: false })
      return
    }

    // POST /auth/request-pairing — cria pending entry, seta cookie de pending.
    if (req.method === 'POST' && url.pathname === '/auth/request-pairing') {
      const pending = await requestPairing({
        ip,
        userAgent: ua,
        existingPendingId: cookies[PENDING_COOKIE]
      })
      setCookie(res, PENDING_COOKIE, pending.id, 60 * 30) // 30min
      jsonResponse(res, 200, {
        id: pending.id,
        code: pending.code,
        expiresAt: pending.expiresAt
      })
      return
    }

    // GET /auth/wait-pairing — long-poll até approved/rejected/expired/timeout.
    if (req.method === 'GET' && url.pathname === '/auth/wait-pairing') {
      const pendingId = cookies[PENDING_COOKIE]
      if (!pendingId) {
        jsonResponse(res, 400, { error: 'no pending cookie' })
        return
      }
      const result = await waitForPairing(pendingId, 25_000) // < default 30s do client
      if (result === 'approved') {
        // Servidor mantém o pending.id como device.id após approvePending — promove o cookie
        // pendente pra cookie de device. Browser deve refetch /auth/me na próxima request.
        setCookie(res, DEVICE_COOKIE, pendingId, 90 * 24 * 3600) // 90 dias
        clearCookie(res, PENDING_COOKIE)
      }
      jsonResponse(res, 200, { status: result })
      return
    }

    // POST /auth/bootstrap — usa admin-token via body { token }. Auto-aprova o device atual
    // e seta cookie. Caminho de recovery quando você revogou tudo ou tá montando do zero.
    if (req.method === 'POST' && url.pathname === '/auth/bootstrap') {
      const body = (await readJsonBody(req).catch(() => ({}))) as { token?: string }
      if (!adminToken || body.token !== adminToken) {
        jsonResponse(res, 401, { error: 'invalid token' })
        return
      }
      const dev = await bootstrapApprove({ ip, userAgent: ua })
      setCookie(res, DEVICE_COOKIE, dev.id, 90 * 24 * 3600)
      clearCookie(res, PENDING_COOKIE)
      jsonResponse(res, 200, { device: { id: dev.id, name: dev.name } })
      return
    }

    // POST /auth/logout — apaga cookie. Não revoga o device (admin pode fazer via WS).
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      clearCookie(res, DEVICE_COOKIE)
      clearCookie(res, PENDING_COOKIE)
      jsonResponse(res, 200, { ok: true })
      return
    }

    jsonResponse(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[auth] handler error:', err)
    jsonResponse(res, 500, { error: (err as Error).message })
  }
}
