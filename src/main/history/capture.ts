import { getHistoryDb } from './db'
import { getWorkspaceMeta } from './workspace-id'

// Per-card "open visit" — the row in `visits` that's still accumulating dwell time. At most one
// per cardId at any moment. On navigation, the previous one closes (committing dwell), a new
// one opens. On destroy/hide, dwell is committed but the entry stays around in DB.

type Transition = 'navigate' | 'in-page' | 'reload' | 'back-forward' | 'rehydrate'

interface OpenVisit {
  visitId: number
  cardId: string
  url: string
  openedAt: number
  visibleSince: number | null // null = not currently visible (zero-bounds or unmounted)
  dwellAccum: number // ms accumulated across hide/show cycles within this visit
}

const open = new Map<string, OpenVisit>()

export function openVisit(
  cardId: string,
  url: string,
  workspaceCwd: string | null,
  transition: Transition,
  meta: { title?: string | null; favicon?: string | null }
): void {
  if (!workspaceCwd) {
    // Card without a workspace context (older renderer / edge case) — close any open visit
    // for this card but skip new persistence; we can't tag a row without workspace_id.
    closeVisit(cardId)
    return
  }
  // Commit dwell on the previous visit before opening a new one.
  const prev = open.get(cardId)
  const prevUrl = prev?.url ?? null
  closeVisit(cardId)

  const ws = getWorkspaceMeta(workspaceCwd)
  const now = Date.now()
  const db = getHistoryDb()
  const stmt = db.prepare(
    `INSERT INTO visits
       (url, title, favicon, card_id, workspace_id, visited_at, navigated_from, transition)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const info = stmt.run(
    url,
    meta.title ?? null,
    meta.favicon ?? null,
    cardId,
    ws.workspaceId,
    now,
    prevUrl,
    transition
  )

  open.set(cardId, {
    visitId: Number(info.lastInsertRowid),
    cardId,
    url,
    openedAt: now,
    // If main already knows this card is visible (web:set-bounds with non-zero bounds came in
    // before navigation finished), the bounds path will flip visibleSince. For new cards,
    // start as not-visible — first non-zero setBounds flips it on.
    visibleSince: null,
    dwellAccum: 0
  })
}

export function patchTitle(cardId: string, title: string): void {
  const v = open.get(cardId)
  if (!v) return
  try {
    getHistoryDb().prepare('UPDATE visits SET title = ? WHERE id = ?').run(title, v.visitId)
  } catch (err) {
    console.error('[history] patchTitle failed:', err)
  }
}

export function patchFavicon(cardId: string, favicon: string | null): void {
  const v = open.get(cardId)
  if (!v) return
  try {
    getHistoryDb().prepare('UPDATE visits SET favicon = ? WHERE id = ?').run(favicon, v.visitId)
  } catch (err) {
    console.error('[history] patchFavicon failed:', err)
  }
}

// Read the URL of the open visit for a card (or null if none). Used pelo bootstrap em
// web-views.ts pra decidir se precisa abrir uma visit pra um card que já estava vivo.
export function getOpenVisitUrl(cardId: string): string | null {
  return open.get(cardId)?.url ?? null
}

export function setVisible(cardId: string, visible: boolean): void {
  const v = open.get(cardId)
  if (!v) return
  const now = Date.now()
  if (visible) {
    if (v.visibleSince === null) v.visibleSince = now
  } else {
    if (v.visibleSince !== null) {
      v.dwellAccum += now - v.visibleSince
      v.visibleSince = null
    }
  }
}

// Close the open visit on this card: commit accumulated dwell + any in-progress visible slice.
// The DB row stays (it's a historical record); we just stop tracking it.
export function closeVisit(cardId: string): void {
  const v = open.get(cardId)
  if (!v) return
  open.delete(cardId)
  let dwell = v.dwellAccum
  if (v.visibleSince !== null) dwell += Date.now() - v.visibleSince
  if (dwell <= 0) return
  try {
    getHistoryDb()
      .prepare('UPDATE visits SET dwell_ms = dwell_ms + ? WHERE id = ?')
      .run(dwell, v.visitId)
  } catch (err) {
    console.error('[history] closeVisit dwell commit failed:', err)
  }
}

// Called at shutdown so any in-flight dwell is persisted before the DB closes.
export function flushAll(): void {
  for (const cardId of Array.from(open.keys())) closeVisit(cardId)
}
