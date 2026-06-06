// Backend do handoff no decky: sobe o socket-server compartilhado (@handoff/runtime-electron)
// dirigindo o WebContents do CARD WEB FOCADO. Opt-in via DECKY_HANDOFF — não muda o default.
// Deixa o sdk/client.ts + adapters do handoff (HANDOFF_BACKEND=/tmp/handoff-decky.sock) e o MCP
// dinâmico dirigirem o mesmo card web logado que o usuário vê no decky.
import type { WebContents } from 'electron'
import { getWebViewsManager } from './web-views'
import { getAllCards } from './card-mirror'
import { startHandoffServer } from '@handoff/runtime-electron'

// Card web focado em qualquer sessão; fallback: único card web aberto no total. (O socket do
// handoff é global; o decky é multi-sessão — então busca o foco onde ele estiver.)
function activeWebCardWc(): WebContents | null {
  const manager = getWebViewsManager()
  if (!manager) return null
  const sessions = Object.values(getAllCards())
  for (const s of sessions) {
    const f = s.cards.find((c) => c.id === s.focused)
    if (f && f.type === 'web' && manager.has(f.id)) {
      const wc = manager.webContentsFor(f.id)
      if (wc) return wc
    }
  }
  const webIds = new Set<string>()
  for (const s of sessions) for (const c of s.cards) if (c.type === 'web') webIds.add(c.id)
  if (webIds.size === 1) {
    const only = [...webIds][0]
    if (manager.has(only)) return manager.webContentsFor(only)
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

export function startDeckyHandoffBackend(): void {
  startHandoffServer({
    getActiveWebContents: activeWebCardWc,
    normalizeUrl
  })
  console.log('[handoff] decky backend on — dirige o card web focado')
}
