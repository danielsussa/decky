import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { extractTags, listMdFiles, deriveTitle } from './cards-search'

// Generate a "live" bento-grid index of the workspace's #tags. Walks every .html/.md card
// in <workspace>/.decky/cards/, aggregates by tag, materializes a tags-index.html file.
// Called once on workspace open + on every file change in cards/ (debounced in main).

export interface TagBucket {
  tag: string
  count: number
  // Cards under this tag, newest first. Capped at ~6 for the bento preview.
  cards: { id: string; title: string; mtime: number }[]
}

export async function computeTagIndex(cardsDir: string): Promise<TagBucket[]> {
  const files = await listMdFiles(cardsDir, '', 'all')
  // tag -> array of card stubs
  const buckets = new Map<string, { id: string; title: string; mtime: number }[]>()
  // Prefer .html over .md when both siblings exist (legacy .md is fallback now).
  const seenBaseIds = new Set<string>()
  const sorted = [...files].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'html' ? -1 : 1
    return 0
  })
  for (const f of sorted) {
    if (seenBaseIds.has(f.id)) continue
    seenBaseIds.add(f.id)
    let content = ''
    try {
      content = await readFile(f.path, 'utf-8')
    } catch {
      continue
    }
    const tags = extractTags(content)
    if (tags.length === 0) continue
    const title = deriveTitle(content, f.id)
    for (const tag of tags) {
      const arr = buckets.get(tag) ?? []
      arr.push({ id: f.id, title, mtime: f.mtime })
      buckets.set(tag, arr)
    }
  }
  // Cap each bucket's cards to 6 most recent.
  const out: TagBucket[] = []
  for (const [tag, cards] of buckets) {
    cards.sort((a, b) => b.mtime - a.mtime)
    out.push({ tag, count: cards.length, cards: cards.slice(0, 6) })
  }
  // Sort tags by count desc, tiebreak by tag name asc.
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  return out
}

// Map a bucket count to a bento tier — drives `grid-column`/`grid-row` spans.
function tier(count: number): 'L' | 'M' | 'S' {
  if (count >= 7) return 'L'
  if (count >= 3) return 'M'
  return 'S'
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderTagsIndexHtml(buckets: TagBucket[]): string {
  const totalCards = new Set(buckets.flatMap((b) => b.cards.map((c) => c.id))).size
  const cells = buckets
    .map((b) => {
      const t = tier(b.count)
      const visible = b.cards.slice(0, t === 'L' ? 6 : t === 'M' ? 4 : 2)
      const list = visible
        .map(
          (c) =>
            `<li><a href="${esc(c.id)}.html" data-card-id="${esc(c.id)}">${esc(c.title)}</a></li>`
        )
        .join('')
      const more =
        b.count > visible.length
          ? `<div class="bento-more">+${b.count - visible.length} mais</div>`
          : ''
      return `<article class="bento-cell tier-${t}" data-tag="${esc(b.tag)}">
  <header class="bento-head">
    <span class="bento-tag">#${esc(b.tag)}</span>
    <span class="bento-count">${b.count}</span>
  </header>
  <ul class="bento-list">${list}</ul>
  ${more}
</article>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8" />
<title>Índice de tags</title>
<link rel="stylesheet" href="/__decky/default.css">
<style>
  body { padding: 24px 28px; margin: 0; }
  .bento-head-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 18px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .bento-head-row h1 {
    margin: 0;
    border: none;
    padding: 0;
    font-size: 1.6em;
  }
  .bento-meta {
    color: var(--text-3);
    font-family: var(--mono);
    font-size: 12px;
  }
  .bento-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    grid-auto-rows: 130px;
    grid-auto-flow: dense;
    gap: 12px;
  }
  .bento-cell {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: border-color 120ms, background 120ms;
  }
  .bento-cell:hover {
    border-color: var(--accent);
    background: var(--bg-2);
  }
  .tier-L { grid-column: span 2; grid-row: span 2; }
  .tier-M { grid-column: span 2; }
  .bento-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .bento-tag {
    font-family: var(--mono);
    color: var(--accent);
    font-weight: 600;
    font-size: 13px;
    letter-spacing: 0.3px;
  }
  .bento-count {
    font-family: var(--mono);
    color: var(--text-3);
    font-size: 11px;
    background: var(--bg-2);
    padding: 1px 7px;
    border-radius: 8px;
  }
  .bento-list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow: hidden;
  }
  .bento-list li {
    margin: 0;
    padding: 3px 0;
    font-size: 12px;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bento-list a {
    color: var(--text-2);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: color 120ms, border-color 120ms;
  }
  .bento-list a:hover {
    color: var(--text-1);
    border-bottom-color: var(--text-3);
  }
  .bento-more {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-3);
    margin-top: 6px;
  }
  .bento-empty {
    color: var(--text-3);
    font-style: italic;
    padding: 40px 0;
    text-align: center;
  }
</style>
</head>
<body>
<div class="bento-head-row">
  <h1>Índice de tags</h1>
  <span class="bento-meta">${buckets.length} tags · ${totalCards} cards taggeados</span>
</div>
${
  buckets.length === 0
    ? '<div class="bento-empty">Nenhum card com <code>&lt;meta name="tags"&gt;</code> ainda.</div>'
    : `<section class="bento-grid">${cells}</section>`
}
</body>
</html>
`
}

const INDEX_NAME = 'tags-index.html'

export async function writeTagsIndex(cardsDir: string): Promise<string | null> {
  try {
    const buckets = await computeTagIndex(cardsDir)
    const html = renderTagsIndexHtml(buckets)
    const out = join(cardsDir, INDEX_NAME)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, html, 'utf-8')
    return out
  } catch (err) {
    console.error('[tags-index] write failed:', err)
    return null
  }
}

export function tagsIndexFileName(): string {
  return INDEX_NAME
}
