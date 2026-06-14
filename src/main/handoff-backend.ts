// Backend do handoff no decky: UM socket POR SESSÃO em /tmp/handoff-decky-<sessionId>.sock,
// dirigindo só os cards web da própria sessão. Cada pty exporta HANDOFF_SOCKET apontando
// pro seu socket — quando o handoff CLI/SDK/MCP é spawnado dentro dessa sessão, ele cai no
// backend isolado. Resolve o vazamento cross-session/cross-workspace que o socket global
// (/tmp/handoff-decky.sock) tinha: qualquer cliente dirigia o card focado em QUALQUER
// sessão, então uma sessão A podia mexer num card de B sem nenhuma barreira.
import type { WebContents } from 'electron'
import { getWebViewsManager } from './web-views'
import { getCardsForSession, normalizeAddressBarUrl, sessionHandoffSocketPath } from '@decky/server'
import { startHandoffServer, type HandoffServerHandle } from '@handoff/runtime-electron'
import { trackActivityStart, trackActivityEnd } from './handoff-activity'

interface SessionBackend {
  sessionId: string
  handle: HandoffServerHandle
  // Sticky pointer pro WC dirigido NA SESSÃO. Mantém o mesmo card mesmo se o foco da sessão
  // mudar — só "perde" se o card for fechado. Per-instance: cada sessão tem o próprio sticky,
  // sem cruzar entre sessões/workspaces.
  stickyWc: WebContents | null
}

const backends = new Map<string, SessionBackend>()

// Resolução do card alvo, SCOPED na sessão: foco da sessão → único card web da sessão →
// qualquer card web da sessão (escolha estável). Cards de outras sessões NUNCA entram.
function activeWebCardWcForSession(backend: SessionBackend): WebContents | null {
  // (1) Sticky vivo → continua nele.
  if (backend.stickyWc && !backend.stickyWc.isDestroyed()) return backend.stickyWc

  const manager = getWebViewsManager()
  if (!manager) return null
  const session = getCardsForSession(backend.sessionId)
  if (!session.cards.length) return null

  // (2) Foco da sessão, se for um card web.
  const focused = session.cards.find((c) => c.id === session.focused)
  if (focused && focused.type === 'web' && manager.has(focused.id)) {
    const wc = manager.webContentsFor(focused.id)
    if (wc) {
      backend.stickyWc = wc
      return wc
    }
  }

  // (3) Único card web na sessão.
  const webCards = session.cards.filter((c) => c.type === 'web')
  if (webCards.length === 1 && manager.has(webCards[0].id)) {
    const wc = manager.webContentsFor(webCards[0].id)
    if (wc) {
      backend.stickyWc = wc
      return wc
    }
  }

  // (4) Qualquer card web da sessão (escolha estável: primeiro id).
  for (const c of webCards) {
    if (manager.has(c.id)) {
      const wc = manager.webContentsFor(c.id)
      if (wc) {
        backend.stickyWc = wc
        return wc
      }
    }
  }
  return null
}

export function startSessionHandoffBackend(sessionId: string): HandoffServerHandle {
  // Idempotente: chamado de novo na mesma sessão (ex.: recriar pty), reaproveita o backend.
  const existing = backends.get(sessionId)
  if (existing) return existing.handle

  const socketPath = sessionHandoffSocketPath(sessionId)
  const backend: SessionBackend = { sessionId, stickyWc: null, handle: null as unknown as HandoffServerHandle }

  const handle = startHandoffServer({
    socketPath,
    getActiveWebContents: () => activeWebCardWcForSession(backend),
    normalizeUrl: normalizeAddressBarUrl,
    // cmd vem do runtime; snapshot/see/wait JÁ são filtrados como passivos lá.
    onActivity: (kind, wc, cmd) => {
      if (kind === 'start') trackActivityStart(wc, `handoff-socket:${cmd}:${sessionId}`)
      else trackActivityEnd()
    }
  })

  backend.handle = handle
  backends.set(sessionId, backend)
  console.log(`[handoff] session=${sessionId} backend on — ${socketPath}`)
  return handle
}

export async function stopSessionHandoffBackend(sessionId: string): Promise<void> {
  const b = backends.get(sessionId)
  if (!b) return
  backends.delete(sessionId)
  await b.handle.close()
  console.log(`[handoff] session=${sessionId} backend off`)
}
