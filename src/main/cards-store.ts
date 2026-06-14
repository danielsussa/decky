import { ipcMain } from 'electron'
import { writeCard, listCards, deleteCard, type DeckyWsServer } from '@decky/server'

// IPC/WS bridge — toda a lógica vive em @decky/server. WS roda em paralelo ao IPC durante a
// transição; quando todos os domínios migrarem, o ipcMain.handle some.
export function registerCardsHandlers(getWsServer: () => DeckyWsServer | null): void {
  ipcMain.handle(
    'cards:write',
    (_e, workspace: string, cardId: string, content: string, ext?: '.md' | '.html') =>
      writeCard(workspace, cardId, content, ext ?? '.md')
  )
  ipcMain.handle('cards:list', (_e, workspace: string) => listCards(workspace))
  ipcMain.handle('cards:delete', (_e, workspace: string, cardId: string) =>
    deleteCard(workspace, cardId)
  )

  const ws = getWsServer()
  if (!ws) return
  ws.handle<
    { workspace: string; cardId: string; content: string; ext?: '.md' | '.html' },
    string | null
  >('cards:write', (args) =>
    writeCard(args?.workspace ?? '', args?.cardId ?? '', args?.content ?? '', args?.ext ?? '.md')
  )
  ws.handle<{ workspace: string }, Awaited<ReturnType<typeof listCards>>>('cards:list', (args) =>
    listCards(args?.workspace ?? '')
  )
  ws.handle<{ workspace: string; cardId: string }, boolean>('cards:delete', (args) =>
    deleteCard(args?.workspace ?? '', args?.cardId ?? '')
  )
}
