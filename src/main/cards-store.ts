import { writeFile, mkdir, rename, readdir, stat, readFile, unlink, rmdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ipcMain } from 'electron'
import { cardFilePath, safeCardId, workspaceCardsDir } from './paths'

// Serialize writes per-file so rapid successive updates to the same card don't clobber.
const writeChains = new Map<string, Promise<void>>()

export interface WorkspaceCardEntry {
  id: string
  path: string
  title: string
  mtime: number
}

// Headings are H1-H6 in markdown.
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/m

function deriveTitle(content: string, fallback: string): string {
  const h = content.match(HEADING_RE)
  if (h && h[1]) return h[1].trim().slice(0, 80)
  const first = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (first) {
    const clean = first.replace(/^[#>*\-`\s]+/, '').trim()
    if (clean) return clean.slice(0, 80)
  }
  return fallback
}

async function walkCards(root: string, prefix = ''): Promise<WorkspaceCardEntry[]> {
  let entries: Dirent[]
  try {
    entries = (await readdir(root, { withFileTypes: true, encoding: 'utf-8' })) as Dirent[]
  } catch {
    return []
  }
  const out: WorkspaceCardEntry[] = []
  for (const ent of entries) {
    const abs = join(root, ent.name)
    if (ent.isDirectory()) {
      const childPrefix = prefix ? `${prefix}/${ent.name}` : ent.name
      out.push(...(await walkCards(abs, childPrefix)))
      continue
    }
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    // PINNED.md is the workspace's pinned-cards index, not a page itself.
    if (!prefix && ent.name === 'PINNED.md') continue
    const baseId = ent.name.slice(0, -'.md'.length)
    const id = prefix ? `${prefix}/${baseId}` : baseId
    let content = ''
    let mtime = 0
    try {
      const [text, st] = await Promise.all([readFile(abs, { encoding: 'utf-8' }), stat(abs)])
      content = text as string
      mtime = st.mtimeMs
    } catch {
      // partial failure: still surface the file with whatever info we got
    }
    out.push({ id, path: abs, title: deriveTitle(content, baseId), mtime })
  }
  return out
}

// Validate the resolved path stays inside the workspace's cards dir — defense in depth even
// though safeCardId strips traversal. Both args should be absolute.
function isUnderCardsDir(cardsDir: string, target: string): boolean {
  const rel = relative(cardsDir, target)
  return !!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`)
}

// Walk up from the deleted file removing now-empty parent dirs, stopping at cardsDir.
async function cleanupEmptyParents(cardsDir: string, fromFile: string): Promise<void> {
  let dir = dirname(fromFile)
  while (dir !== cardsDir && dir.startsWith(cardsDir + sep)) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

// Main owns where a card file lives (<workspace>/.decky/cards/<id>.md). The renderer only
// passes (workspace, cardId, content) and gets back the resolved abs path to store on the
// source + watch. Returns null on failure.
export function registerCardsHandlers(): void {
  ipcMain.handle(
    'cards:write',
    async (_e, workspace: string, cardId: string, content: string): Promise<string | null> => {
      const path = cardFilePath(workspace, cardId)
      const prev = writeChains.get(path) ?? Promise.resolve()
      let ok = true
      const next = prev
        .then(async () => {
          await mkdir(dirname(path), { recursive: true })
          const tmp = path + '.tmp'
          await writeFile(tmp, content, 'utf-8')
          await rename(tmp, path)
        })
        .catch((err) => {
          ok = false
          console.error(`[cards-store] write failed for ${path}:`, err)
        })
      writeChains.set(path, next)
      await next
      return ok ? path : null
    }
  )

  // List every .md page under the workspace's cards dir (recursive). Returns id (slash-
  // segmented), abs path, derived title (first heading or first non-empty line), and mtime.
  ipcMain.handle('cards:list', async (_e, workspace: string): Promise<WorkspaceCardEntry[]> => {
    const root = workspaceCardsDir(workspace)
    const list = await walkCards(root)
    list.sort((a, b) => b.mtime - a.mtime)
    return list
  })

  // Delete a single card file. Validates the resolved path is inside the workspace's
  // cards dir before unlinking; cleans up empty parent directories afterward.
  ipcMain.handle(
    'cards:delete',
    async (_e, workspace: string, cardId: string): Promise<boolean> => {
      const cardsDir = workspaceCardsDir(workspace)
      const target = join(cardsDir, `${safeCardId(cardId)}.md`)
      if (!isUnderCardsDir(cardsDir, target)) {
        console.warn(`[cards-store] refused delete outside cards dir: ${target}`)
        return false
      }
      try {
        await unlink(target)
      } catch (err) {
        console.error(`[cards-store] delete failed for ${target}:`, err)
        return false
      }
      await cleanupEmptyParents(cardsDir, target)
      return true
    }
  )
}
