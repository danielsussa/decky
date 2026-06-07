// Backend do handoff no decky: sobe o socket-server compartilhado (@handoff/runtime-electron)
// dirigindo o WebContents do CARD WEB FOCADO. Opt-in via DECKY_HANDOFF — não muda o default.
// Deixa o sdk/client.ts + adapters do handoff (HANDOFF_BACKEND=/tmp/handoff-decky.sock) e o MCP
// dinâmico dirigirem o mesmo card web logado que o usuário vê no decky.
import type { WebContents } from 'electron'
import { getWebViewsManager } from './web-views'
import { getAllCards } from './card-mirror'
import { startHandoffServer } from '@handoff/runtime-electron'
import { trackActivityStart, trackActivityEnd } from './handoff-activity'

// Sticky pointer pra WebContents que estamos dirigindo. Uma vez que o agente começa, mantém
// o MESMO card mesmo se o foco mudar (editor, outra aba, outra sessão do decky). Sobrevive
// re-renders e troca de foco. Só "perde" o alvo se o card for fechado (WC destroyed).
let stickyWc: WebContents | null = null

// Resolução, sticky-first: enquanto o WC alvo estiver vivo, continua nele. Se não tiver
// alvo (boot inicial OU o card sticky foi fechado), elege um: preferência por foco, depois
// único card web global, depois qualquer card web aberto.
function activeWebCardWc(): WebContents | null {
  // (1) Sticky: continua dirigindo o mesmo WC. Independe de foco — só quebra se for destruído.
  if (stickyWc && !stickyWc.isDestroyed()) return stickyWc

  const manager = getWebViewsManager()
  if (!manager) return null
  const sessions = Object.values(getAllCards())

  // (2) Bootstrap: card web focado em alguma sessão.
  for (const s of sessions) {
    const f = s.cards.find((c) => c.id === s.focused)
    if (f && f.type === 'web' && manager.has(f.id)) {
      const wc = manager.webContentsFor(f.id)
      if (wc) {
        stickyWc = wc
        return wc
      }
    }
  }
  const webIds = new Set<string>()
  for (const s of sessions) for (const c of s.cards) if (c.type === 'web') webIds.add(c.id)
  // (3) Único card web global.
  if (webIds.size === 1) {
    const only = [...webIds][0]
    if (manager.has(only)) {
      const wc = manager.webContentsFor(only)
      if (wc) {
        stickyWc = wc
        return wc
      }
    }
  }
  // (4) Qualquer card web aberto (escolha estável: primeiro id).
  for (const id of webIds) {
    if (manager.has(id)) {
      const wc = manager.webContentsFor(id)
      if (wc) {
        stickyWc = wc
        return wc
      }
    }
  }
  return null
}

// address-bar → URL (mesmo afordance do normalizeAddress dos outros hosts).
function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return 'about:blank'
  if (/^(https?|file|about|data|chrome):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s)) return `http://${s}`
  if (/^[^\s]+\.[^\s]{2,}/.test(s) && !/\s/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

// O tracker debounced de "controlando" vive em handoff-activity.ts — compartilhado com o
// preview-server (/web/act), porque os dois caminhos dirigem o mesmo WC e o usuário precisa
// ver o feedback visual independente de qual cliente está dirigindo.
function onActivity(kind: 'start' | 'end', wc: WebContents | null): void {
  if (kind === 'start') trackActivityStart(wc)
  else trackActivityEnd()
}

export function startDeckyHandoffBackend(): void {
  startHandoffServer({
    getActiveWebContents: activeWebCardWc,
    normalizeUrl,
    onActivity
  })
  console.log('[handoff] decky backend on — dirige o card web focado')
}
