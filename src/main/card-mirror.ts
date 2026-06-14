import { ipcMain, type BrowserWindow } from 'electron'
import {
  applyCardsStateSync,
  applyPreviewResolved,
  type DeckyWsServer,
  type MirrorSession
} from '@decky/server'

// IPC/WS bridge — toda lógica de mirror vive em @decky/server. Os 2 eventos (cards:state-sync,
// preview:resolved) são fire-and-forget — sem reqId, server processa sem responder. WS roda
// em paralelo ao IPC durante a transição.
export function registerCardMirrorHandlers(
  _getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): void {
  ipcMain.on('cards:state-sync', (_e, payload) => applyCardsStateSync(payload))
  ipcMain.on('preview:resolved', (_e, payload) => applyPreviewResolved(payload))

  const ws = getWsServer()
  if (!ws) return
  ws.handle<{ sessions: Record<string, MirrorSession> }, void>('cards:state-sync', (payload) =>
    applyCardsStateSync(payload)
  )
  ws.handle<
    { reqId?: string; cardId?: string; path?: string; title?: string },
    void
  >('preview:resolved', (payload) => applyPreviewResolved(payload))
}
