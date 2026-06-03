import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

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

export function registerWidgetBridge(_getWindow: () => BrowserWindow | null): void {
  ipcMain.on(
    'widget:call-reply',
    (_e, msg: { reqId?: string; result?: unknown; error?: string }) => {
      if (!msg || typeof msg.reqId !== 'string') return
      const p = pending.get(msg.reqId)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(msg.reqId)
      p.resolve({ result: msg.result, error: msg.error })
    }
  )
}

export async function awaitWidgetCall(
  getWindow: () => BrowserWindow | null,
  call: Omit<WidgetCallPayload, 'reqId'>,
  timeoutMs = 5000
): Promise<{ result?: unknown; error?: string }> {
  const win = getWindow()
  if (!win || win.isDestroyed()) return { error: 'no active window' }
  const reqId = randomUUID()
  const payload: WidgetCallPayload = { ...call, reqId }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId)
      resolve({ error: 'widget call timed out' })
    }, timeoutMs)
    pending.set(reqId, { resolve, timer })
    win.webContents.send('widget:call', payload)
  })
}
