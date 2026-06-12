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
  tags: string[]
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/m
const HTML_TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i
const HTML_H1_RE = /<h1[^>]*>([^<]+)<\/h1>/i
// `<meta name="tags" content="poc xlsx decky">` — case-insensitive, attrs in any order.
const HTML_TAGS_RE = /<meta\s+[^>]*name\s*=\s*["']tags["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/i
const HTML_TAGS_RE_REV = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']tags["'][^>]*>/i
// YAML-ish frontmatter for .md: `tags: [poc, xlsx]` or `tags: poc xlsx` within --- --- block.
const MD_FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/
const MD_TAGS_LINE_RE = /^tags\s*:\s*(.+)$/im

export function extractTags(content: string): string[] {
  // HTML meta first.
  const m = content.match(HTML_TAGS_RE) || content.match(HTML_TAGS_RE_REV)
  if (m && m[1]) return normalizeTags(m[1])
  // Markdown frontmatter.
  const fm = content.match(MD_FRONTMATTER_RE)
  if (fm) {
    const line = fm[1].match(MD_TAGS_LINE_RE)
    if (line && line[1]) {
      const raw = line[1].trim().replace(/^\[|\]$/g, '')
      return normalizeTags(raw)
    }
  }
  return []
}

function normalizeTags(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^#/, '').toLowerCase())
    .filter((t) => t.length > 0 && /^[a-z0-9][a-z0-9_-]*$/.test(t))
}

export function deriveTitle(content: string, fallback: string): string {
  const h = content.match(HEADING_RE)
  if (h && h[1]) return h[1].trim().slice(0, 80)
  const ht = content.match(HTML_TITLE_RE)
  if (ht && ht[1]) return ht[1].trim().slice(0, 80)
  const h1 = content.match(HTML_H1_RE)
  if (h1 && h1[1]) return h1[1].trim().slice(0, 80)
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

export type CardKindFilter = 'all' | 'md' | 'html'

export async function listMdFiles(
  root: string,
  prefix = '',
  kindFilter: CardKindFilter = 'all'
): Promise<{ id: string; path: string; mtime: number; kind: 'md' | 'html' }[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { id: string; path: string; mtime: number; kind: 'md' | 'html' }[] = []
  for (const ent of entries) {
    const abs = join(root, ent.name)
    if (ent.isDirectory()) {
      const childPrefix = prefix ? `${prefix}/${ent.name}` : ent.name
      out.push(...(await listMdFiles(abs, childPrefix, kindFilter)))
      continue
    }
    if (!ent.isFile()) continue
    const isMd = ent.name.endsWith('.md')
    const isHtml = ent.name.endsWith('.html') || ent.name.endsWith('.htm')
    if (!isMd && !isHtml) continue
    if (kindFilter === 'md' && !isMd) continue
    if (kindFilter === 'html' && !isHtml) continue
    // PINNED.md is the workspace's pinned-cards index, not a page itself.
    if (!prefix && ent.name === 'PINNED.md') continue
    const ext = isHtml ? (ent.name.endsWith('.htm') ? '.htm' : '.html') : '.md'
    const baseId = ent.name.slice(0, -ext.length)
    const id = prefix ? `${prefix}/${baseId}` : baseId
    try {
      const st = await stat(abs)
      out.push({ id, path: abs, mtime: st.mtimeMs, kind: isHtml ? 'html' : 'md' })
    } catch {
      out.push({ id, path: abs, mtime: 0, kind: isHtml ? 'html' : 'md' })
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
  lineIdx: number,
  kind: 'md' | 'html' = 'md'
): { snippet: string; line: number } {
  const lines = content.split('\n')
  const start = Math.max(0, lineIdx - 1)
  const end = Math.min(lines.length, lineIdx + 2)
  let raw = lines.slice(start, end).join('\n')
  if (kind === 'html') {
    // Strip tags so the snippet reads as text, not "<div class=...>".
    raw = raw
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return { snippet: raw.slice(0, 300), line: lineIdx + 1 }
}

export async function searchCards(
  cardsDir: string,
  query: string,
  limit = 20,
  kindFilter: CardKindFilter = 'all'
): Promise<CardHit[]> {
  const files = await listMdFiles(cardsDir, '', kindFilter)
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
        mtime: f.mtime,
        tags: extractTags(content)
      })
    }
    return out
  }

  // Tag-only filter: `#flow` (single token) means "match cards whose tag list contains 'flow'",
  // body matches ignored. Multiple `#a #b` are AND'd. Bare words still match body+tags.
  const tagOnly = q.startsWith('#')
  const requiredTags = (q.match(/#([a-z0-9][a-z0-9_-]*)/gi) || []).map((s) =>
    s.slice(1).toLowerCase()
  )
  const bareQuery = q.replace(/#[a-z0-9][a-z0-9_-]*/gi, '').trim()

  const hits: CardHit[] = []
  for (const f of files) {
    let content = ''
    try {
      content = await readFile(f.path, 'utf-8')
    } catch {
      continue
    }
    const tags = extractTags(content)
    if (requiredTags.length && !requiredTags.every((t) => tags.includes(t))) continue

    let score = 0
    let firstLine = -1

    // Tag boost: every required tag contributes a flat +5; bare-word match in tags contributes +3.
    if (requiredTags.length) score += requiredTags.length * 5
    if (bareQuery && tags.some((t) => t.includes(bareQuery.toLowerCase()))) score += 3

    if (bareQuery) {
      const m = findMatches(content, bareQuery)
      score += m.count
      firstLine = m.firstLine
    } else if (!tagOnly) {
      const m = findMatches(content, q)
      score += m.count
      firstLine = m.firstLine
    }

    if (score === 0) continue
    const snip =
      firstLine >= 0 ? makeSnippet(content, firstLine, f.kind) : { snippet: '', line: 0 }
    hits.push({
      id: f.id,
      path: f.path,
      title: deriveTitle(content, f.id),
      snippet: snip.snippet,
      line: snip.line,
      score,
      mtime: f.mtime,
      tags
    })
  }
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return hits.slice(0, limit)
}
