import { ipcMain, type BrowserWindow } from 'electron'
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

function applyReply(msg: { reqId?: string; result?: unknown; error?: string }): void {
  if (!msg || typeof msg.reqId !== 'string') return
  const p = pending.get(msg.reqId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(msg.reqId)
  p.resolve({ result: msg.result, error: msg.error })
}

export function registerWidgetBridge(
  _getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): void {
  ipcMain.on('widget:call-reply', (_e, msg) => applyReply(msg))
  const ws = getWsServer()
  if (!ws) return
  ws.handle<{ reqId?: string; result?: unknown; error?: string }, void>(
    'widget:call-reply',
    (payload) => applyReply(payload ?? {})
  )
}

export async function awaitWidgetCall(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  call: Omit<WidgetCallPayload, 'reqId'>,
  timeoutMs = 5000
): Promise<{ result?: unknown; error?: string }> {
  const win = getWindow()
  const ws = getWsServer()
  // Sem janela aberta E sem WS clients = ninguém pra atender. Falha rápido.
  if ((!win || win.isDestroyed()) && (!ws || ws.clientCount() === 0)) {
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
    if (win && !win.isDestroyed()) win.webContents.send('widget:call', payload)
    ws?.broadcast('widget:call', payload)
  })
}
