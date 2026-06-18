import { ipcMain } from 'electron'
import { dirname } from 'node:path'
import { cardUrlFor, findCardsRoot, registerCardsDir, type DeckyWsServer } from '@decky/server'

// Após a migração pra card://, este "servidor" só registra UM handler IPC: html:resolve recebe
// um path de arquivo e devolve a URL card:// correspondente. O nome "html-server" sobrevive
// por compat com a chamada antiga do renderer/preload; o servidor HTTP localhost original
// virou código morto e foi removido junto com este split.

function resolveHtmlPath(path: string): string {
  if (typeof path !== 'string' || !path) throw new Error('html:resolve: path required')
  // O cards root é o ancestral mais próximo contendo `.decky/cards/`. Pra arquivos fora
  // dessa árvore (preview_show de .html avulso), o fallback é o próprio dirname.
  const cardsRoot = findCardsRoot(path) ?? dirname(path)
  registerCardsDir(cardsRoot)
  // Card-manifesto (.json): a URL omite a extensão (card://host/foo, não foo.json) — o .json é
  // detalhe de implementação. O resolver card:// reconhece o path sem extensão e serve o .json.
  return cardUrlFor(path, cardsRoot).replace(/\.json$/i, '')
}

export function setupHtmlServer(getWsServer: () => DeckyWsServer | null): void {
  ipcMain.handle('html:resolve', (_e, path: string) => resolveHtmlPath(path))
  const ws = getWsServer()
  if (!ws) return
  ws.handle<{ path: string }, string>('html:resolve', (args) => resolveHtmlPath(args?.path ?? ''))
}
