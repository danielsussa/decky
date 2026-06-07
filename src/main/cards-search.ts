import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Shared helper for "search the user's card library" — used by the MCP `search_cards`
// tool AND the in-app Cmd+Shift+F palette. Reads files directly (no ripgrep dep) so it
// works in packaged builds without external binaries.

export interface CardHit {
  id: string
  path: string
  title: string
  snippet: string
  line: number
  score: number
  mtime: number
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/m

export function deriveTitle(content: string, fallback: string): string {
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

export async function listMdFiles(
  root: string,
  prefix = ''
): Promise<{ id: string; path: string; mtime: number }[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { id: string; path: string; mtime: number }[] = []
  for (const ent of entries) {
    const abs = join(root, ent.name)
    if (ent.isDirectory()) {
      const childPrefix = prefix ? `${prefix}/${ent.name}` : ent.name
      out.push(...(await listMdFiles(abs, childPrefix)))
      continue
    }
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue
    // PINNED.md is the workspace's pinned-cards index, not a page itself.
    if (!prefix && ent.name === 'PINNED.md') continue
    const baseId = ent.name.slice(0, -'.md'.length)
    const id = prefix ? `${prefix}/${baseId}` : baseId
    try {
      const st = await stat(abs)
      out.push({ id, path: abs, mtime: st.mtimeMs })
    } catch {
      out.push({ id, path: abs, mtime: 0 })
    }
  }
  return out
}

function findMatches(
  content: string,
  needle: string
): { count: number; firstLine: number } {
  const lines = content.split('\n')
  const ndl = needle.toLowerCase()
  let count = 0
  let first = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(ndl)) {
      count++
      if (first < 0) first = i
    }
  }
  return { count, firstLine: first }
}

function makeSnippet(
  content: string,
  lineIdx: number
): { snippet: string; line: number } {
  const lines = content.split('\n')
  const start = Math.max(0, lineIdx - 1)
  const end = Math.min(lines.length, lineIdx + 2)
  return { snippet: lines.slice(start, end).join('\n').slice(0, 300), line: lineIdx + 1 }
}

export async function searchCards(
  cardsDir: string,
  query: string,
  limit = 20
): Promise<CardHit[]> {
  const files = await listMdFiles(cardsDir)
  const q = query.trim()

  // Empty query: top N by mtime — read each file just to derive a title.
  if (!q) {
    files.sort((a, b) => b.mtime - a.mtime)
    const top = files.slice(0, limit)
    const out: CardHit[] = []
    for (const f of top) {
      let content = ''
      try {
        content = await readFile(f.path, 'utf-8')
      } catch {
        // file disappeared between readdir and readFile — surface anyway with id as title
      }
      out.push({
        id: f.id,
        path: f.path,
        title: deriveTitle(content, f.id),
        snippet: '',
        line: 0,
        score: 0,
        mtime: f.mtime
      })
    }
    return out
  }

  // With query: score by case-insensitive substring match count per file.
  const hits: CardHit[] = []
  for (const f of files) {
    let content = ''
    try {
      content = await readFile(f.path, 'utf-8')
    } catch {
      continue
    }
    const { count, firstLine } = findMatches(content, q)
    if (count === 0) continue
    const snip = makeSnippet(content, firstLine)
    hits.push({
      id: f.id,
      path: f.path,
      title: deriveTitle(content, f.id),
      snippet: snip.snippet,
      line: snip.line,
      score: count,
      mtime: f.mtime
    })
  }
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return hits.slice(0, limit)
}
