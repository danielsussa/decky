import {
  WS_URL_PREFIX,
  ENGINES_ARG_PREFIX,
  LOCAL_ENGINE_ID,
  parseEnginesArg,
  type Engine
} from '@decky/shared'

// WS client multi-engine: o decky fala com N engines ao mesmo tempo (o `local` embarcado +
// cada `server` remoto). Cada conexão é lazy, compartilhada entre chamadas, e reabre no próximo
// invoke/on após um drop. Roteamento por `engineId` — quem chama escolhe o engine (workspace →
// engine no preload). Antes era socket único global (local OU remoto), o que escondia o local.
//
// Por conexão, um listener único roteia o tráfego entrante:
//  - { kind: 'reply', reqId } → resolve a Promise registrada por wsInvoke naquele engine
//  - { kind: outro }          → entrega pros handlers de wsOn daquele engine

const INVOKE_TIMEOUT_MS = 10_000

interface PendingInvoke {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface IncomingReply {
  v: 1
  kind: 'reply'
  reqId: string
  ok: boolean
  result?: unknown
  error?: string
}

interface IncomingBroadcast {
  v: 1
  kind: string
  args?: unknown
}

// Estado por engine. broadcastHandlers sobrevive a reconnect (a próxima conexão herda os
// handlers); wsPromise/pending são resetados no close.
interface ConnState {
  url: string
  token?: string
  wsPromise: Promise<WebSocket> | null
  pending: Map<string, PendingInvoke>
  broadcast: Map<string, Set<(args: unknown) => void>>
}

// ---- registry de engines (vem do argv no boot) ------------------------------------------------

const engines = new Map<string, Engine>()
const conns = new Map<string, ConnState>()

function loadEnginesFromArgv(): void {
  const enginesArg = process.argv.find((a) => a.startsWith(ENGINES_ARG_PREFIX))
  if (enginesArg) {
    for (const e of parseEnginesArg(enginesArg)) engines.set(e.id, e)
  }
  // Back-compat / fallback: se não veio lista mas veio o --decky-ws-url antigo, ele é o local.
  if (!engines.has(LOCAL_ENGINE_ID)) {
    const legacy = process.argv.find((a) => a.startsWith(WS_URL_PREFIX))
    const url = legacy ? legacy.slice(WS_URL_PREFIX.length) : ''
    if (url) {
      engines.set(LOCAL_ENGINE_ID, {
        id: LOCAL_ENGINE_ID,
        kind: 'local',
        label: 'local',
        url
      })
    }
  }
}
loadEnginesFromArgv()

function withTokenQuery(url: string, token?: string): string {
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

function getConn(engineId: string): ConnState {
  let c = conns.get(engineId)
  if (!c) {
    const e = engines.get(engineId)
    c = {
      url: e?.url ?? '',
      token: e?.token,
      wsPromise: null,
      pending: new Map(),
      broadcast: new Map()
    }
    conns.set(engineId, c)
  }
  return c
}

function getWs(engineId: string): Promise<WebSocket> {
  const conn = getConn(engineId)
  if (conn.wsPromise) return conn.wsPromise
  if (!conn.url) {
    return Promise.reject(new Error(`engine '${engineId}': no WS URL`))
  }
  const fullUrl = withTokenQuery(conn.url, conn.token)
  conn.wsPromise = new Promise<WebSocket>((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(fullUrl)
    } catch (err) {
      conn.wsPromise = null
      reject(err)
      return
    }
    const onOpen = (): void => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      resolve(ws)
    }
    const onError = (): void => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      conn.wsPromise = null
      reject(new Error(`engine '${engineId}': WS connect failed`))
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)

    ws.addEventListener('message', (ev) => {
      let msg: IncomingReply | IncomingBroadcast
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (!msg || typeof msg.kind !== 'string') return
      if (msg.kind === 'reply' && typeof (msg as IncomingReply).reqId === 'string') {
        const reply = msg as IncomingReply
        const p = conn.pending.get(reply.reqId)
        if (!p) return
        clearTimeout(p.timer)
        conn.pending.delete(reply.reqId)
        if (reply.ok) p.resolve(reply.result)
        else p.reject(new Error(reply.error || 'ws error'))
        return
      }
      const handlers = conn.broadcast.get(msg.kind)
      if (!handlers || handlers.size === 0) return
      const args = (msg as IncomingBroadcast).args
      for (const h of Array.from(handlers)) h(args)
    })

    ws.addEventListener('close', () => {
      conn.wsPromise = null
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`engine '${engineId}': ws closed`))
      }
      conn.pending.clear()
      // broadcast handlers ficam — próxima conexão herda.
    })
  })
  return conn.wsPromise
}

export interface WsInvokeOptions {
  /** Override the 10s default for handlers that legitimately take longer (e.g. dev:rebuild). */
  timeoutMs?: number
}

export async function wsInvoke<T = unknown>(
  engineId: string,
  kind: string,
  args?: unknown,
  opts?: WsInvokeOptions
): Promise<T> {
  const conn = getConn(engineId)
  const ws = await getWs(engineId)
  const reqId = crypto.randomUUID()
  const timeoutMs = opts?.timeoutMs ?? INVOKE_TIMEOUT_MS
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(reqId)
      reject(new Error(`ws ${kind} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    conn.pending.set(reqId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer
    })
    ws.send(JSON.stringify({ v: 1, kind, reqId, args }))
  })
}

/**
 * Fire-and-forget send pro engine. Sem reqId, sem espera. Falha silenciosamente se o socket
 * estiver fechado.
 */
export async function wsSend(engineId: string, kind: string, args?: unknown): Promise<void> {
  try {
    const ws = await getWs(engineId)
    ws.send(JSON.stringify({ v: 1, kind, args }))
  } catch (err) {
    console.warn(`[ws] send ${kind} (engine ${engineId}) failed:`, err)
  }
}

/** Subscribe a um broadcast push de um engine. Retorna função de unsubscribe. */
export function wsOn<T = unknown>(
  engineId: string,
  kind: string,
  handler: (args: T) => void
): () => void {
  const conn = getConn(engineId)
  let set = conn.broadcast.get(kind)
  if (!set) {
    set = new Set()
    conn.broadcast.set(kind, set)
  }
  set.add(handler as (args: unknown) => void)
  // Garante que a conexão esteja sendo estabelecida (lazy).
  void getWs(engineId).catch(() => {
    // sem URL ou connect falhou; handler permanece registrado pra próxima tentativa.
  })
  return () => {
    conn.broadcast.get(kind)?.delete(handler as (args: unknown) => void)
  }
}

/** Lista de engines conhecidos (do argv). */
export function listEngines(): Engine[] {
  return Array.from(engines.values())
}

/** Útil pra UI mostrar "WS desconectado". Não bloqueia — só reflete se há URL pro engine. */
export function hasEngine(engineId: string): boolean {
  return !!engines.get(engineId)?.url
}

/**
 * Registra/atualiza um engine em runtime (ex: "Add server" sem relaunch). Se a URL mudou,
 * derruba a conexão antiga pra reabrir na nova.
 */
export function upsertEngine(engine: Engine): void {
  const prev = engines.get(engine.id)
  engines.set(engine.id, engine)
  const conn = conns.get(engine.id)
  if (conn && prev?.url !== engine.url) {
    conn.url = engine.url
    conn.token = engine.token
    conn.wsPromise = null // próximo invoke/on reabre na URL nova
  } else if (conn) {
    conn.token = engine.token
  }
}

/**
 * Remove um engine em runtime (ex: "Remove server" no modal de confirmação). Fecha a conexão
 * WS aberta (se houver) e descarta listeners de broadcast. Engine local ('local') não pode
 * ser removido — é o embarcado e some só com app.quit.
 */
export function removeEngine(engineId: string): void {
  if (engineId === LOCAL_ENGINE_ID) return
  engines.delete(engineId)
  const conn = conns.get(engineId)
  if (conn) {
    // Rejeita invokes pendentes E fecha o socket (close handler do dispatcher também já limpa).
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('engine removed'))
    }
    conn.pending.clear()
    conn.broadcast.clear()
    if (conn.wsPromise) {
      void conn.wsPromise
        .then((ws) => {
          try {
            ws.close()
          } catch {
            // ignore
          }
        })
        .catch(() => {
          // não tinha conexão aberta
        })
    }
    conns.delete(engineId)
  }
}
