import { ipcMain } from 'electron'
import { dirname } from 'node:path'
import { cardUrlFor, findCardsRoot, registerCardsDir, type DeckyWsServer } from '@decky/server'
import type { Engine } from '@decky/shared'
import { setRemoteCardEngine } from './remote-card-fetcher'

// Após a migração pra card://, este "servidor" só registra UM handler IPC: html:resolve recebe
// um path de arquivo e devolve a URL card:// correspondente. O nome "html-server" sobrevive
// por compat com a chamada antiga do renderer/preload; o servidor HTTP localhost original
// virou código morto e foi removido junto com este split.

// Provider async que diz se um path absoluto pertence a workspace remoto + devolve o Engine
// dono. Injetado pelo main no boot. Lê do state direto (sem cache) — chamado uma vez por
// abertura de card, latency é barata. Sem isso, paths remotos cairiam no resolver local de
// card:// e o WebContentsView mostrava "not found".
let remoteEngineForPath: (absPath: string) => Promise<Engine | null> = async () => null
export function setHtmlRemoteEngineProvider(
  provider: (absPath: string) => Promise<Engine | null>
): void {
  remoteEngineForPath = provider
}

async function resolveHtmlPath(path: string): Promise<string> {
  if (typeof path !== 'string' || !path) throw new Error('html:resolve: path required')
  // O cards root é o ancestral mais próximo contendo `.decky/cards/`. Pra arquivos fora
  // dessa árvore (preview_show de .html avulso), o fallback é o próprio dirname.
  const cardsRoot = findCardsRoot(path) ?? dirname(path)
  const host = registerCardsDir(cardsRoot)
  // Se este path pertence a workspace remoto, ensina o card-protocol a buscar via WS no
  // engine dono — slug do host é deterministic (SHA1 do cardsRoot abs), então registrar aqui
  // já é suficiente pro próximo request card://ws-XXX/* chegar com lookup pronto.
  const engine = await remoteEngineForPath(path)
  if (engine) setRemoteCardEngine(host, engine)
  return cardUrlFor(path, cardsRoot)
}

export function setupHtmlServer(getWsServer: () => DeckyWsServer | null): void {
  ipcMain.handle('html:resolve', (_e, path: string) => resolveHtmlPath(path))
  const ws = getWsServer()
  if (!ws) return
  ws.handle<{ path: string }, string>('html:resolve', (args) => resolveHtmlPath(args?.path ?? ''))
}
