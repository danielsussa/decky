import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { deriveTitle, listMdFiles } from './cards-search'

// Wikilink resolution + reverse-link (backlinks) computation. Both are pure file-system
// walks over <workspace>/.decky/cards/. Used by the renderer (clickable [[name]] inside
// MarkdownPreview + BacklinksFooter) and the MCP `card_backlinks` tool.

export interface BacklinkHit {
  id: string
  path: string
  title: string
  snippet: string
  line: number
  mtime: number
}

// Match [[name]] outside code fences/inline code. Names allow letters, digits, dashes,
// underscores, dots, slashes (for folder paths like decky/plano-x). No spaces.
const WIKILINK_RE = /\[\[([\w./-]+)\]\]/g

// Walks every line and yields wikilink names — but skips lines inside ``` fences and
// the inline-code spans on each non-fenced line. Cheap enough for backlinks scanning;
// we don't need a full markdown parser here.
function* extractWikilinks(content: string): Generator<{ name: string; line: number }> {
  const lines = content.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // Strip inline `code` spans so [[name]] inside them doesn't count.
    const stripped = line.replace(/`[^`]*`/g, '')
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(stripped)) !== null) {
      yield { name: m[1], line: i + 1 }
    }
  }
}

// Try in order:
//   1. exact id match (name contains '/' or matches a known id directly): cardsDir/<name>.md
//   2. basename match: first .md under cardsDir whose filename === <name>.md
export async function resolveWikilink(cardsDir: string, name: string): Promise<string | null> {
  const files = await listMdFiles(cardsDir)
  const exact = files.find((f) => f.id === name)
  if (exact) return exact.path
  const byBase = files.find((f) => basename(f.path).slice(0, -'.md'.length) === name)
  return byBase ? byBase.path : null
}

// Compute backlinks for a target card. We accept the card's full path; the card is
// referenced under either its full id (decky/plano-x) OR its basename (plano-x). We
// match BOTH so callers don't need to commit to one form when authoring [[ ]].
export async function computeBacklinks(
  cardsDir: string,
  targetPath: string
): Promise<BacklinkHit[]> {
  const files = await listMdFiles(cardsDir)
  const target = files.find((f) => f.path === targetPath)
  if (!target) return []
  const targetBase = basename(targetPath).slice(0, -'.md'.length)
  const targetId = target.id

  const hits: BacklinkHit[] = []
  for (const f of files) {
    if (f.path === targetPath) continue
    let content = ''
    try {
      content = await readFile(f.path, 'utf-8')
    } catch {
      continue
    }
    let firstLine = -1
    for (const link of extractWikilinks(content)) {
      if (link.name === targetId || link.name === targetBase) {
        firstLine = link.line
        break
      }
    }
    if (firstLine < 0) continue
    const lines = content.split('\n')
    const ctxStart = Math.max(0, firstLine - 2)
    const ctxEnd = Math.min(lines.length, firstLine + 1)
    const snippet = lines.slice(ctxStart, ctxEnd).join('\n').slice(0, 300)
    hits.push({
      id: f.id,
      path: f.path,
      title: deriveTitle(content, f.id),
      snippet,
      line: firstLine,
      mtime: f.mtime
    })
  }
  hits.sort((a, b) => b.mtime - a.mtime)
  return hits
}
