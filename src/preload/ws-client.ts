import { WS_URL_PREFIX } from '@decky/shared'

// WS client minimalista usado pelo preload pra falar com o decky-server (loopback na Fase 2,
// remoto via Tailscale na Fase 3). Lazy connect — abre na 1ª invoke, compartilha a conexão
// entre chamadas concorrentes. Reset on close → próximo invoke reabre. Sem reconnect agressivo
// nem queue de pendentes nessa versão; chamadas durante drop falham (10s timeout) e o caller
// trata como erro normal de RPC.

const INVOKE_TIMEOUT_MS = 10_000

let cachedUrl: string | null | undefined = undefined
function getWsUrl(): string | null {
  if (cachedUrl !== undefined) return cachedUrl
  const arg = process.argv.find((a) => a.startsWith(WS_URL_PREFIX))
  cachedUrl = arg ? arg.slice(WS_URL_PREFIX.length) || null : null
  return cachedUrl
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
    // Se cair depois de aberto, libera o cache pra próximo invoke reabrir.
    ws.addEventListener('close', () => {
      wsPromise = null
    })
  })
  return wsPromise
}

interface WsReply {
  v: 1
  kind: 'reply'
  reqId: string
  ok: boolean
  result?: unknown
  error?: string
}

export async function wsInvoke<T = unknown>(kind: string, args?: unknown): Promise<T> {
  const ws = await getWs()
  const reqId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const onMessage = (ev: MessageEvent): void => {
      let msg: WsReply
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      if (msg.kind !== 'reply' || msg.reqId !== reqId) return
      cleanup()
      if (msg.ok) resolve(msg.result as T)
      else reject(new Error(msg.error || `ws ${kind} failed`))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`ws ${kind} timed out after ${INVOKE_TIMEOUT_MS}ms`))
    }, INVOKE_TIMEOUT_MS)
    function cleanup(): void {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ v: 1, kind, reqId, args }))
  })
}

/** Útil pra UI mostrar "WS desconectado". Não bloqueia — só reflete estado atual. */
export function hasWsUrl(): boolean {
  return getWsUrl() !== null
}
