import { WS_URL_PREFIX } from '@decky/shared'

// WS client minimalista usado pelo preload pra falar com o decky-server (loopback na Fase 2,
// remoto via Tailscale na Fase 3). Lazy connect — abre na 1ª invoke/on, compartilha a conexão
// entre chamadas concorrentes. Reset on close → próximo invoke/on reabre.
//
// Listener único global no socket roteia todo tráfego entrante:
//  - { kind: 'reply', reqId } → resolve a Promise registrada por wsInvoke
//  - { kind: outro }           → entrega pra todos handlers registrados via wsOn
//
// Sem reconnect agressivo, sem queue de pendentes durante drop. Chamadas durante drop falham
// (10s timeout). Broadcasts perdidos enquanto desconectado — POC suficiente.

const INVOKE_TIMEOUT_MS = 10_000

let cachedUrl: string | null | undefined = undefined
function getWsUrl(): string | null {
  if (cachedUrl !== undefined) return cachedUrl
  const arg = process.argv.find((a) => a.startsWith(WS_URL_PREFIX))
  cachedUrl = arg ? arg.slice(WS_URL_PREFIX.length) || null : null
  return cachedUrl
}

interface PendingInvoke {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingInvokes = new Map<string, PendingInvoke>()
const broadcastHandlers = new Map<string, Set<(args: unknown) => void>>()

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

let wsPromise: Promise<WebSocket> | null = null
function getWs(): Promise<WebSocket> {
  if (wsPromise) return wsPromise
  const url = getWsUrl()
  if (!url) {
    return Promise.reject(new Error('no WS URL — main did not pass --decky-ws-url'))
  }
  wsPromise = new Promise<WebSocket>((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      wsPromise = null
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
      wsPromise = null
      reject(new Error('WS connect failed'))
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)

    // Listener único — roteia replies e broadcasts pros consumers corretos.
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
        const pending = pendingInvokes.get(reply.reqId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingInvokes.delete(reply.reqId)
        if (reply.ok) pending.resolve(reply.result)
        else pending.reject(new Error(reply.error || 'ws error'))
        return
      }
      // Broadcast — entrega pra todos handlers do kind (cópia da Set pra permitir unsubscribe
      // dentro do callback sem race).
      const handlers = broadcastHandlers.get(msg.kind)
      if (!handlers || handlers.size === 0) return
      const args = (msg as IncomingBroadcast).args
      for (const h of Array.from(handlers)) h(args)
    })

    // Se cair depois de aberto, libera o cache pra próximo invoke/on reabrir.
    ws.addEventListener('close', () => {
      wsPromise = null
      // Rejeita invokes pendentes — não dá pra esperar reply de conexão morta.
      for (const p of pendingInvokes.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('ws closed'))
      }
      pendingInvokes.clear()
      // Broadcasts ficam: próxima conexão herda os handlers.
    })
  })
  return wsPromise
}

export async function wsInvoke<T = unknown>(kind: string, args?: unknown): Promise<T> {
  const ws = await getWs()
  const reqId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInvokes.delete(reqId)
      reject(new Error(`ws ${kind} timed out after ${INVOKE_TIMEOUT_MS}ms`))
    }, INVOKE_TIMEOUT_MS)
    pendingInvokes.set(reqId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer
    })
    ws.send(JSON.stringify({ v: 1, kind, reqId, args }))
  })
}

/** Subscribe a um broadcast push do server (kind sem 'reply'). Retorna função de unsubscribe. */
export function wsOn<T = unknown>(kind: string, handler: (args: T) => void): () => void {
  let set = broadcastHandlers.get(kind)
  if (!set) {
    set = new Set()
    broadcastHandlers.set(kind, set)
  }
  set.add(handler as (args: unknown) => void)
  // Garante que a conexão esteja sendo estabelecida (lazy) — broadcasts não funcionam sem ws aberto.
  void getWs().catch(() => {
    // sem WS URL ou connect falhou; handler permanece registrado pra próxima tentativa
  })
  return () => {
    broadcastHandlers.get(kind)?.delete(handler as (args: unknown) => void)
  }
}

/** Útil pra UI mostrar "WS desconectado". Não bloqueia — só reflete estado atual. */
export function hasWsUrl(): boolean {
  return getWsUrl() !== null
}
