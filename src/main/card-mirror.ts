import { ipcMain, type BrowserWindow } from 'electron'
import { applyCardsStateSync, applyPreviewResolved } from '@decky/server'

// IPC bridge — toda lógica de mirror vive em @decky/server. Quando o transport virar WS,
// estes ipcMain.on viram ws-handlers e o server passa a receber o sync direto do client.
export function registerCardMirrorHandlers(_getWindow: () => BrowserWindow | null): void {
  ipcMain.on('cards:state-sync', (_e, payload) => applyCardsStateSync(payload))
  ipcMain.on('preview:resolved', (_e, payload) => applyPreviewResolved(payload))
}
