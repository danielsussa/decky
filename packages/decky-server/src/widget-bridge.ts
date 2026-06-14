import { randomUUID } from 'node:crypto'
import type { DeckyWsServer } from './ws-server'

// Bridge for the MCP-side imperative API ("card_invoke" / "card_get") to reach a live React
// widget in the renderer. Mirrors the prompt_form long-poll pattern: HTTP request parks a
// resolver here, IPC fans out to the renderer, renderer replies with a reqId, we resolve.
//
// Why this exists: editing markdown to mutate a widget is coarse (the whole spec reparses,
// the widget remounts, no transient effects). With a bridge, MCP tools can target ops
// (`flow:setActive`) directly on a mounted widget and read its state. See arquitetura-cards-io.

type Resolver = (outcome: { result?: unknown; error?: string }) => void
const pending = new Map<string, { resolve: Resolver; timer: NodeJS.Timeout }>()

export type WidgetCallKind = 'invoke' | 'get' | 'list'
export type WidgetCallPayload = {
  reqId: string
  kind: WidgetCallKind
  cardId?: string
  widgetId?: string
  op?: string
  args?: unknown
  key?: string
}

export function applyWidgetReply(msg: {
  reqId?: string
  result?: unknown
  error?: string
}): void {
  if (!msg || typeof msg.reqId !== 'string') return
  const p = pending.get(msg.reqId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(msg.reqId)
  p.resolve({ result: msg.result, error: msg.error })
}

export function registerWidgetBridge(getWsServer: () => DeckyWsServer | null): void {
  const ws = getWsServer()
  if (!ws) return
  ws.handle<{ reqId?: string; result?: unknown; error?: string }, void>(
    'widget:call-reply',
    (payload) => applyWidgetReply(payload ?? {})
  )
}

// Adapter de "emit widget:call". O shim Electron passa um emit que faz webContents.send,
// e o WS broadcast já tá embutido aqui. Pure — sem BrowserWindow.
export async function awaitWidgetCall(
  options: {
    getWsServer: () => DeckyWsServer | null
    /** Hook opcional pra emitir o mesmo payload via IPC pro Electron renderer. */
    emitIpc?: (payload: WidgetCallPayload) => void
    /** Permite o caller validar se alguém pode atender (ex: tem WebContents vivo). */
    hasIpcConsumer?: () => boolean
  },
  call: Omit<WidgetCallPayload, 'reqId'>,
  timeoutMs = 5000
): Promise<{ result?: unknown; error?: string }> {
  const ws = options.getWsServer()
  const hasIpc = options.hasIpcConsumer?.() ?? false
  // Ninguém pra atender = falha rápido.
  if (!hasIpc && (!ws || ws.clientCount() === 0)) {
    return { error: 'no active window or ws client' }
  }
  const reqId = randomUUID()
  const payload: WidgetCallPayload = { ...call, reqId }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve({ error: 'widget call timed out' })
    }, timeoutMs)
    pending.set(reqId, { resolve, timer })
    if (hasIpc) options.emitIpc?.(payload)
    ws?.broadcast('widget:call', payload)
  })
}
