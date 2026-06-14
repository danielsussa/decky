import { ipcMain } from 'electron'
import { dirname } from 'node:path'
import { cardUrlFor, findCardsRoot, registerCardsDir } from '@decky/server'

// Após a migração pra card://, este "servidor" só registra UM handler IPC: html:resolve recebe
// um path de arquivo e devolve a URL card:// correspondente. O nome "html-server" sobrevive
// por compat com a chamada antiga do renderer/preload; o servidor HTTP localhost original
// virou código morto e foi removido junto com este split.
export function setupHtmlServer(): void {
  ipcMain.handle('html:resolve', async (_e, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('html:resolve: path required')
    // O cards root é o ancestral mais próximo contendo `.decky/cards/`. Pra arquivos fora
    // dessa árvore (preview_show de .html avulso), o fallback é o próprio dirname.
    const cardsRoot = findCardsRoot(path) ?? dirname(path)
    registerCardsDir(cardsRoot)
    return cardUrlFor(path, cardsRoot)
  })
}
