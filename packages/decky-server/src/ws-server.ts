import { createServer, type Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

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
}

export async function startWsServer(opts: WsServerOpts = {}): Promise<DeckyWsServer> {
  const host = opts.host ?? '127.0.0.1'
  const requestedPort = opts.port ?? 0
  const requiredToken = opts.token ?? null

  const handlers = new Map<string, WsHandler>()
  const clients = new Set<WebSocket>()

  const httpServer: HttpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    // Auth check (se requerido). Loopback default não exige.
    if (requiredToken) {
      const auth = (req.headers['authorization'] as string | undefined) ?? ''
      const url = new URL(req.url || '/', `http://${host}`)
      const tokenFromQuery = url.searchParams.get('token')
      const tokenFromHeader = auth.replace(/^Bearer\s+/i, '')
      const provided = tokenFromHeader || tokenFromQuery
      if (provided !== requiredToken) {
        ws.close(4001, 'unauthorized')
        return
      }
    }

    clients.add(ws)

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
