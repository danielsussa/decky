import type { WebContents } from 'electron'
import { setControlChangeHandler, trackControlEnd, trackControlStart } from '@decky/server'
import { getWebViewsManager } from './web-views'

// IPC bridge — toda lógica de debounce/state vive em @decky/server/control-tracker.
// Este shim só faz duas coisas:
//  1) Na primeira chamada, registra um callback que repassa mudanças de estado pro
//     WebContentsView.setControlling (liga a borda animada + bloqueia input humano).
//  2) Adapta a interface "recebe WebContents" → "recebe cardId" usando o web-views manager.

let installed = false
function ensureInstalled(): void {
  if (installed) return
  installed = true
  setControlChangeHandler((cardId, isControlling) => {
    const m = getWebViewsManager()
    if (m) m.setControlling(cardId, isControlling)
  })
}

export function trackActivityStart(wc: WebContents | null, origin = 'unknown'): void {
  ensureInstalled()
  const m = getWebViewsManager()
  if (!m || !wc) return
  const cardId = m.cardIdFor(wc)
  if (!cardId) return
  trackControlStart(cardId, origin)
}

export function trackActivityEnd(): void {
  ensureInstalled()
  trackControlEnd()
}
