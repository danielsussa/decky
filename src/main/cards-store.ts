import { ipcMain } from 'electron'
import { writeCard, listCards, deleteCard } from '@decky/server'

// IPC bridge — toda a lógica vive em @decky/server. Quando o transport virar WS, este shim
// some e os mesmos handlers passam a ser registrados num ws-router em vez de ipcMain.
export function registerCardsHandlers(): void {
  ipcMain.handle(
    'cards:write',
    (_e, workspace: string, cardId: string, content: string, ext?: '.md' | '.html') =>
      writeCard(workspace, cardId, content, ext ?? '.md')
  )
  ipcMain.handle('cards:list', (_e, workspace: string) => listCards(workspace))
  ipcMain.handle('cards:delete', (_e, workspace: string, cardId: string) =>
    deleteCard(workspace, cardId)
  )
}
