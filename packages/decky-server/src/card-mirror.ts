// Canonical mirror of the renderer's per-session card state. The renderer holds the truth
// (it owns focus + resolution + file materialization) and pushes a full snapshot here on every
// change. The HTTP server and MCP tools read this mirror so external callers (the session bot)
// can ask "what cards does the user have open right now?" without round-tripping the renderer.

export type MirrorCardKind =
  | 'markdown'
  | 'diff'
  | 'json'
  | 'web'
  | 'html'
  | 'me'
  | 'editor'
  | 'xlsx'
  | 'form'
  | 'none'

export type MirrorCard = {
  id: string
  title: string
  type: MirrorCardKind
  path?: string
  url?: string
  pinned: boolean
}

export type MirrorSession = {
  cards: MirrorCard[]
  focused: string | null
  // Workspace cwd of the session. Used by `/cards/search` to resolve
  // <workspace>/.decky/cards/ for the MCP search_cards tool.
  cwd?: string
}

const bySession = new Map<string, MirrorSession>()

export function getCardsForSession(sessionId: string): MirrorSession {
  return bySession.get(sessionId) ?? { cards: [], focused: null }
}

export function getAllCards(): Record<string, MirrorSession> {
  return Object.fromEntries(bySession)
}

// Apply a full per-session snapshot pushed by the renderer (debounced on its side).
export function applyCardsStateSync(payload: { sessions: Record<string, MirrorSession> }): void {
  if (!payload || typeof payload !== 'object') return
  const next = payload.sessions ?? {}
  // Replace wholesale — the renderer always sends the full state, never partials.
  bySession.clear()
  for (const [id, s] of Object.entries(next)) {
    if (!s) continue
    bySession.set(id, {
      cards: Array.isArray(s.cards) ? s.cards : [],
      focused: typeof s.focused === 'string' ? s.focused : null,
      cwd: typeof s.cwd === 'string' ? s.cwd : undefined
    })
  }
}

// Per-session reqId → pending resolver. POST /preview parks here until the renderer acks the
// resolved {cardId, path} for that broadcast (or the 2s safety timeout fires).
type Pending = (info: { cardId: string; path?: string; title?: string }) => void
const pending = new Map<string, Pending>()

export function registerPreviewResolution(
  reqId: string,
  resolver: Pending,
  timeoutMs = 2000
): void {
  pending.set(reqId, resolver)
  setTimeout(() => {
    const fn = pending.get(reqId)
    if (!fn) return
    pending.delete(reqId)
    fn({ cardId: '', path: undefined })
  }, timeoutMs)
}

// Renderer acks a preview broadcast: tells main which cardId+path the inline source landed
// on so the HTTP response can echo it back to the MCP caller.
export function applyPreviewResolved(payload: {
  reqId?: string
  cardId?: string
  path?: string
  title?: string
}): void {
  const id = payload?.reqId
  if (!id) return
  const fn = pending.get(id)
  if (!fn) return
  pending.delete(id)
  fn({
    cardId: typeof payload.cardId === 'string' ? payload.cardId : '',
    path: typeof payload.path === 'string' ? payload.path : undefined,
    title: typeof payload.title === 'string' ? payload.title : undefined
  })
}
