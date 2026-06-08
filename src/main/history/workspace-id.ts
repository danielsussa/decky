import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { workspaceDir } from '../paths'

// History-specific metadata per workspace. Kept SEPARATE from workspace.json (owned by the
// renderer-driven workspace-store) to avoid races and to keep concerns isolated.
//  - workspaceId: stable UUID tag for every visit/favorite registered with the global DB.
//                 Survives folder rename (which a path-hash wouldn't).
//  - isolated:    when true, this workspace's entries never surface in cross-workspace search.

interface HistoryMeta {
  workspaceId: string
  isolated: boolean
}

const FILE = 'history-meta.json'
const cache = new Map<string, HistoryMeta>()

function metaPath(cwd: string): string {
  return join(workspaceDir(cwd), FILE)
}

export function getWorkspaceMeta(cwd: string): HistoryMeta {
  const cached = cache.get(cwd)
  if (cached) return cached
  const path = metaPath(cwd)
  try {
    const text = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(text) as Partial<HistoryMeta>
    if (parsed.workspaceId) {
      const meta: HistoryMeta = {
        workspaceId: parsed.workspaceId,
        isolated: !!parsed.isolated
      }
      cache.set(cwd, meta)
      return meta
    }
  } catch {
    // not present yet — mint below
  }
  const minted: HistoryMeta = { workspaceId: randomUUID(), isolated: false }
  writeMeta(path, minted)
  cache.set(cwd, minted)
  return minted
}

export function setWorkspaceIsolated(cwd: string, isolated: boolean): void {
  const current = getWorkspaceMeta(cwd)
  const next: HistoryMeta = { ...current, isolated }
  writeMeta(metaPath(cwd), next)
  cache.set(cwd, next)
}

function writeMeta(path: string, meta: HistoryMeta): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(meta, null, 2))
  } catch (err) {
    console.error('[history] failed to write workspace meta:', err)
  }
}
