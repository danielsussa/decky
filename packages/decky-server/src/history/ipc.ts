import { ipcMain } from 'electron'
import { getHistoryDb } from './db'
import { getWorkspaceMeta, setWorkspaceIsolated } from './workspace-id'

// Minimum IPC surface for PR 1 — enough to smoke-test that captures land and the renderer
// (or a dev console) can read them back. The full search/tag surface lands in later PRs.

interface RecentVisitRow {
  id: number
  url: string
  title: string | null
  favicon: string | null
  card_id: string | null
  workspace_id: string
  visited_at: number
  dwell_ms: number
  transition: string | null
}

interface SuggestionRow {
  url: string
  title: string | null
  favicon: string | null
  hits: number
  last_visited: number
}

export function registerHistoryIpc(): void {
  // List the N most recent visits. `workspaceCwd` filters to that workspace; pass null to
  // get cross-workspace (used by the eventual "expand to all workspaces" toggle).
  ipcMain.handle(
    'history:list-recent',
    (_e, payload: { workspaceCwd: string | null; limit?: number }): RecentVisitRow[] => {
      const limit = Math.max(1, Math.min(payload.limit ?? 50, 500))
      const db = getHistoryDb()
      if (payload.workspaceCwd) {
        const ws = getWorkspaceMeta(payload.workspaceCwd)
        return db
          .prepare(
            `SELECT id, url, title, favicon, card_id, workspace_id, visited_at, dwell_ms, transition
             FROM visits
             WHERE workspace_id = ?
             ORDER BY visited_at DESC
             LIMIT ?`
          )
          .all(ws.workspaceId, limit) as RecentVisitRow[]
      }
      return db
        .prepare(
          `SELECT id, url, title, favicon, card_id, workspace_id, visited_at, dwell_ms, transition
           FROM visits
           ORDER BY visited_at DESC
           LIMIT ?`
        )
        .all(limit) as RecentVisitRow[]
    }
  )

  // Address-bar autocomplete: dedup por URL, ranking por frecência (hits desempata por recência).
  // Empty query devolve os top N por frecência geral (sem filtro) — vira "histórico recente
  // rankeado" assim que o usuário foca o input vazio.
  ipcMain.handle(
    'history:suggest',
    (
      _e,
      payload: { workspaceCwd: string | null; query: string; limit?: number }
    ): SuggestionRow[] => {
      const limit = Math.max(1, Math.min(payload.limit ?? 8, 50))
      const db = getHistoryDb()
      const q = (payload.query || '').trim()
      // LIKE com escape de %/_/\ pra não vazar wildcard do usuário.
      const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
      const like = `%${escaped}%`
      const wsId = payload.workspaceCwd ? getWorkspaceMeta(payload.workspaceCwd).workspaceId : null

      // Pega o favicon/title mais recentes (não-null) por URL via subquery, em vez de MAX(title)
      // que devolveria string mais "alta" lexicograficamente.
      const baseSelect = `
        SELECT
          v.url AS url,
          (SELECT title FROM visits WHERE url = v.url AND title IS NOT NULL
             ORDER BY visited_at DESC LIMIT 1) AS title,
          (SELECT favicon FROM visits WHERE url = v.url AND favicon IS NOT NULL
             ORDER BY visited_at DESC LIMIT 1) AS favicon,
          COUNT(*) AS hits,
          MAX(v.visited_at) AS last_visited
        FROM visits v
      `
      const where: string[] = []
      const params: unknown[] = []
      if (wsId) {
        where.push('v.workspace_id = ?')
        params.push(wsId)
      }
      if (q) {
        where.push("(v.url LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\')")
        params.push(like, like)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      params.push(limit)
      const sql = `${baseSelect} ${whereSql}
        GROUP BY v.url
        ORDER BY hits DESC, last_visited DESC
        LIMIT ?`
      return db.prepare(sql).all(...params) as SuggestionRow[]
    }
  )

  ipcMain.handle('history:get-workspace-meta', (_e, cwd: string) => getWorkspaceMeta(cwd))
  ipcMain.handle('history:set-workspace-isolated', (_e, cwd: string, isolated: boolean) => {
    setWorkspaceIsolated(cwd, isolated)
    return true
  })
}
