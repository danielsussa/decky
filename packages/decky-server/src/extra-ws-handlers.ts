import { workspaceCardsDir } from '@decky/shared/node'
import { searchCards } from './cards-search'
import { computeBacklinks, resolveWikilink } from './cards-wikilinks'
import type { DeckyWsServer } from './ws-server'

// Handlers WS de cards que o shim Electron (src/main/index.ts) delega ao @decky/server embarcado.
// Os demais domínios (cards:write, cards:state-sync, claudeSessions:*, file:*, sessions:*) são
// registrados direto no src/main — este módulo cobre só search/wikilink/backlinks.

export function registerCardsExtraWsHandlers(ws: DeckyWsServer): void {
  ws.handle<{ workspace: string; query: string; limit?: number }, unknown>('cards:search', (args) =>
    searchCards(
      workspaceCardsDir(args?.workspace ?? ''),
      args?.query ?? '',
      typeof args?.limit === 'number' ? args.limit : 20,
      'html'
    )
  )
  ws.handle<{ workspace: string; name: string }, string | null>('cards:resolve-wikilink', (args) =>
    resolveWikilink(workspaceCardsDir(args?.workspace ?? ''), args?.name ?? '')
  )
  ws.handle<{ workspace: string; cardPath: string }, unknown>('cards:backlinks', (args) =>
    computeBacklinks(workspaceCardsDir(args?.workspace ?? ''), args?.cardPath ?? '')
  )
}
