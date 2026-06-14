import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { extractTags, listMdFiles, deriveTitle } from './cards-search'

// Generate a "live" bento-grid index of the workspace's #tags. Walks every .html/.md card
// in <workspace>/.decky/cards/, aggregates by tag, materializes a tags-index.html file.
// Called once on workspace open + on every file change in cards/ (debounced in main).

export interface TagBucket {
  tag: string
  count: number
  cards: { id: string; title: string; mtime: number }[]
}

export interface TagsHealth {
  totalCards: number
  taggedCards: number
  untaggedCards: number
  totalTags: number
  // Number of tags in each cardinality tier (H>=7, M>=3, S<3 — same as tier()).
  tiers: { H: number; M: number; S: number }
  // % of tagged cards covered by at least one tag of that tier.
  coverage: { H: number; M: number; S: number }
  // Largest bucket size / taggedCards. Signals "everything has the same tag" if >0.6.
  largestBucketFraction: number
  // 1-card tags / totalTags. Signals "tag pulverized into singletons" if >0.4.
  singletonsFraction: number
  warnings: string[]
}

export interface TagsIndexData {
  buckets: TagBucket[]
  health: TagsHealth
  untaggedCards: { id: string; title: string; mtime: number }[]
  // Cards that ARE tagged but miss one or more tiers (H/M/S). Surfaced in the health
  // block so the user can drill in and add the missing tier(s).
  incompleteCards: { id: string; title: string; missing: ('H' | 'M' | 'S')[] }[]
}

export async function computeTagIndex(cardsDir: string): Promise<TagsIndexData> {
  const files = await listMdFiles(cardsDir, '', 'all')
  const buckets = new Map<string, { id: string; title: string; mtime: number }[]>()
  const cardTags = new Map<string, Set<string>>() // cardId -> tag set
  const untagged: { id: string; title: string; mtime: number }[] = []
  // Prefer .html over .md when both siblings exist (legacy .md is fallback now).
  const seenBaseIds = new Set<string>()
  const sorted = [...files].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'html' ? -1 : 1
    return 0
  })
  let totalCards = 0
  for (const f of sorted) {
    if (seenBaseIds.has(f.id)) continue
    if (f.id === 'tags-index') continue // don't index the index itself
    seenBaseIds.add(f.id)
    totalCards++
    let content = ''
    try {
      content = await readFile(f.path, 'utf-8')
    } catch {
      continue
    }
    const tags = extractTags(content)
    const title = deriveTitle(content, f.id)
    if (tags.length === 0) {
      untagged.push({ id: f.id, title, mtime: f.mtime })
      continue
    }
    cardTags.set(f.id, new Set(tags))
    for (const tag of tags) {
      const arr = buckets.get(tag) ?? []
      arr.push({ id: f.id, title, mtime: f.mtime })
      buckets.set(tag, arr)
    }
  }
  const out: TagBucket[] = []
  for (const [tag, cards] of buckets) {
    cards.sort((a, b) => b.mtime - a.mtime)
    out.push({ tag, count: cards.length, cards })
  }
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))

  const taggedCards = cardTags.size
  const tiers = { H: 0, M: 0, S: 0 }
  // Per-tier: set of card IDs covered by AT LEAST one tag of that tier.
  const coveredBy: Record<'H' | 'M' | 'S', Set<string>> = {
    H: new Set(),
    M: new Set(),
    S: new Set()
  }
  // Map cardId → set of tier letters that the card touches. Used to find cards missing
  // any of H/M/L — the "each card needs ≥1 of each tier" rule.
  const cardTierCoverage = new Map<string, Set<'H' | 'M' | 'S'>>()
  for (const b of out) {
    const t = tier(b.count)
    tiers[t]++
    for (const c of b.cards) {
      coveredBy[t].add(c.id)
      const set = cardTierCoverage.get(c.id) ?? new Set<'H' | 'M' | 'S'>()
      set.add(t)
      cardTierCoverage.set(c.id, set)
    }
  }
  const safeRatio = (a: number, b: number): number => (b > 0 ? a / b : 0)
  const coverage = {
    H: safeRatio(coveredBy.H.size, taggedCards),
    M: safeRatio(coveredBy.M.size, taggedCards),
    S: safeRatio(coveredBy.S.size, taggedCards)
  }
  const largestBucketFraction = safeRatio(out[0]?.count ?? 0, taggedCards)
  const singletons = out.filter((b) => b.count === 1).length
  const singletonsFraction = safeRatio(singletons, out.length)

  // Cards taggeados mas que faltam em pelo menos um tier — a regra "todo card precisa de
  // H + M + L". Resolve card id back to title for the warning list.
  const titleById = new Map<string, string>()
  for (const b of out) for (const c of b.cards) titleById.set(c.id, c.title)
  const incompleteCards: { id: string; title: string; missing: ('H' | 'M' | 'S')[] }[] = []
  for (const [cid, tset] of cardTierCoverage) {
    const missing: ('H' | 'M' | 'S')[] = []
    if (!tset.has('H')) missing.push('H')
    if (!tset.has('M')) missing.push('M')
    if (!tset.has('S')) missing.push('S')
    if (missing.length > 0) {
      incompleteCards.push({ id: cid, title: titleById.get(cid) ?? cid, missing })
    }
  }

  const warnings: string[] = []
  if (untagged.length > 0) {
    warnings.push(
      `${untagged.length} cards sem nenhuma tag — todo card precisa de pelo menos 3 (1 HIGH + 1 MED + 1 LOW).`
    )
  }
  if (incompleteCards.length > 0) {
    warnings.push(
      `${incompleteCards.length} cards taggeados mas faltam um ou mais tiers (lista abaixo).`
    )
  }
  if (tiers.H === 0 && taggedCards > 6) {
    warnings.push(
      'Nenhuma tag HIGH (≥7 cards) — falta uma tag "domínio" que cubra a maior parte do workspace.'
    )
  }
  if (singletonsFraction > 0.5 && out.length > 8) {
    warnings.push(
      `${Math.round(singletonsFraction * 100)}% das tags têm só 1 card — pulverizada demais, considere mergir similares.`
    )
  }

  return {
    buckets: out,
    health: {
      totalCards,
      taggedCards,
      untaggedCards: untagged.length,
      totalTags: out.length,
      tiers,
      coverage,
      largestBucketFraction,
      singletonsFraction,
      warnings
    },
    untaggedCards: untagged,
    incompleteCards
  }
}

// Map a bucket count to a cardinality tier — HIGH/MED/LOW — drives both the bento cell
// `grid-column`/`grid-row` spans AND the health indicator at the top of the page.
function tier(count: number): 'H' | 'M' | 'S' {
  if (count >= 7) return 'H'
  if (count >= 3) return 'M'
  return 'S'
}

function renderHealthBlock(
  health: TagsHealth,
  untaggedCards: { id: string; title: string; mtime: number }[],
  incompleteCards: { id: string; title: string; missing: ('H' | 'M' | 'S')[] }[]
): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  const untaggedList =
    untaggedCards.length > 0
      ? `<details class="health-untagged"><summary>${untaggedCards.length} card${untaggedCards.length === 1 ? '' : 's'} sem nenhuma tag</summary><ul>${untaggedCards
          .map(
            (c) =>
              `<li><a href="${esc(c.id)}.html">${esc(c.title)}</a> <code>${esc(c.id)}</code></li>`
          )
          .join('')}</ul></details>`
      : ''
  const incompleteList =
    incompleteCards.length > 0
      ? `<details class="health-untagged"><summary>${incompleteCards.length} card${incompleteCards.length === 1 ? '' : 's'} taggeados mas faltam tiers (H/M/L)</summary><ul>${incompleteCards
          .map(
            (c) =>
              `<li><a href="${esc(c.id)}.html">${esc(c.title)}</a> <code>${esc(c.id)}</code> <span class="missing-tiers">falta: ${c.missing.join(' ')}</span></li>`
          )
          .join('')}</ul></details>`
      : ''
  const warnings = health.warnings
    .map((w) => `<li>${esc(w)}</li>`)
    .join('')
  return `<section class="health">
  <div class="health-bars">
    <div class="health-bar" title="Tags HIGH: ≥7 cards">
      <span class="health-label">HIGH</span>
      <span class="health-num">${health.tiers.H} tag${health.tiers.H === 1 ? '' : 's'}</span>
      <span class="health-meter h-tier-H"><span style="width:${pct(health.coverage.H)}"></span></span>
      <span class="health-pct">${pct(health.coverage.H)}</span>
    </div>
    <div class="health-bar" title="Tags MEDIUM: 3-6 cards">
      <span class="health-label">MED</span>
      <span class="health-num">${health.tiers.M} tag${health.tiers.M === 1 ? '' : 's'}</span>
      <span class="health-meter h-tier-M"><span style="width:${pct(health.coverage.M)}"></span></span>
      <span class="health-pct">${pct(health.coverage.M)}</span>
    </div>
    <div class="health-bar" title="Tags LOW: 1-2 cards">
      <span class="health-label">LOW</span>
      <span class="health-num">${health.tiers.S} tag${health.tiers.S === 1 ? '' : 's'}</span>
      <span class="health-meter h-tier-S"><span style="width:${pct(health.coverage.S)}"></span></span>
      <span class="health-pct">${pct(health.coverage.S)}</span>
    </div>
  </div>
  ${
    warnings
      ? `<ul class="health-warnings">${warnings}</ul>`
      : '<div class="health-ok">Distribuição saudável ✓</div>'
  }
  ${untaggedList}
  ${incompleteList}
</section>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderTagsIndexHtml(data: TagsIndexData): string {
  const { buckets, health, untaggedCards, incompleteCards } = data
  const cells = buckets
    .map((b) => {
      const t = tier(b.count)
      const visibleCount = t === 'H' ? 6 : t === 'M' ? 4 : 2
      const visible = b.cards.slice(0, visibleCount)
      const list = visible
        .map(
          (c) =>
            `<li class="bento-item"><a href="${esc(c.id)}.html" data-card-id="${esc(c.id)}">${esc(c.title)}</a><button type="button" class="bento-item-del" data-id="${esc(c.id)}" title="Deletar este card" aria-label="Deletar">×</button></li>`
        )
        .join('')
      const more =
        b.count > visible.length
          ? `<button type="button" class="bento-more" data-tag="${esc(b.tag)}">+${b.count - visible.length} mais</button>`
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

  // JSON island: byTag (full list per tag) + cards (with each card's full tag set). Used
  // by the JS for: dialog "+N mais", filter-by-tag scope (recompute buckets within cards
  // that have the filter tag), and re-render on filter change.
  const cardTagsMap = new Map<string, { title: string; mtime: number; tags: string[] }>()
  for (const b of buckets) {
    for (const c of b.cards) {
      const ent = cardTagsMap.get(c.id) ?? { title: c.title, mtime: c.mtime, tags: [] }
      ent.tags.push(b.tag)
      cardTagsMap.set(c.id, ent)
    }
  }
  const cardsArr = [...cardTagsMap.entries()].map(([id, v]) => ({
    id,
    title: v.title,
    mtime: v.mtime,
    tags: v.tags
  }))
  const fullPayload = JSON.stringify({
    byTag: Object.fromEntries(buckets.map((b) => [b.tag, b.cards])),
    cards: cardsArr
  }).replace(/<\/script/gi, '<\\/script')

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
  .health {
    margin-bottom: 18px;
    padding: 12px 14px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .health-bars {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .health-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 11px;
    flex: 1;
    min-width: 200px;
  }
  .health-label {
    color: var(--text-2);
    font-weight: 600;
    letter-spacing: 0.5px;
    width: 36px;
    flex-shrink: 0;
  }
  .health-num {
    color: var(--text-3);
    width: 56px;
    flex-shrink: 0;
  }
  .health-meter {
    flex: 1;
    height: 6px;
    background: var(--bg-0);
    border-radius: 3px;
    overflow: hidden;
    min-width: 40px;
  }
  .health-meter > span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 200ms;
  }
  .h-tier-H > span { background: var(--accent); }
  .h-tier-M > span { background: #5dd7c9; }
  .h-tier-S > span { background: var(--text-3); }
  .health-pct {
    color: var(--text-2);
    width: 38px;
    text-align: right;
    flex-shrink: 0;
  }
  .health-warnings {
    margin: 10px 0 0;
    padding: 0 0 0 18px;
    color: #ffc56c;
    font-size: 12px;
    line-height: 1.5;
  }
  .health-warnings li {
    margin: 2px 0;
  }
  .health-ok {
    margin-top: 10px;
    color: #6cd96c;
    font-family: var(--mono);
    font-size: 11px;
  }
  .health-untagged {
    margin-top: 10px;
    font-family: var(--mono);
    font-size: 11px;
  }
  .health-untagged summary {
    color: #ffc56c;
    cursor: pointer;
  }
  .health-untagged ul {
    margin: 6px 0 0;
    padding: 6px 12px;
    list-style: none;
    background: var(--bg-0);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
  }
  .health-untagged li {
    padding: 2px 0;
  }
  .health-untagged a {
    color: var(--text-1);
    text-decoration: none;
  }
  .health-untagged a:hover {
    color: var(--accent);
  }
  .health-untagged code {
    color: var(--text-3);
    background: transparent;
    padding: 0;
    font-size: 10px;
  }
  .missing-tiers {
    color: #ffc56c;
    margin-left: 6px;
    font-size: 10px;
    letter-spacing: 0.5px;
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
    /* Tier-specific hover handled below — only the count chip lifts here. */
    filter: brightness(1.15);
  }
  .tier-H {
    grid-column: span 2;
    grid-row: span 2;
    background: linear-gradient(180deg, rgba(138, 92, 246, 0.18) 0%, rgba(138, 92, 246, 0.06) 100%);
    border-color: rgba(138, 92, 246, 0.4);
  }
  .tier-H .bento-tag { color: var(--accent); }
  .tier-H .bento-count {
    background: rgba(138, 92, 246, 0.25);
    color: var(--accent);
  }
  .tier-M {
    grid-column: span 2;
    background: linear-gradient(180deg, rgba(93, 215, 201, 0.14) 0%, rgba(93, 215, 201, 0.04) 100%);
    border-color: rgba(93, 215, 201, 0.35);
  }
  .tier-M .bento-tag { color: #5dd7c9; }
  .tier-M .bento-count {
    background: rgba(93, 215, 201, 0.22);
    color: #5dd7c9;
  }
  .tier-S {
    background: var(--bg-1);
    border-color: var(--border);
  }
  .tier-S .bento-tag { color: var(--text-2); }
  .tier-S .bento-count {
    background: var(--bg-2);
    color: var(--text-3);
  }
  /* Hover keeps the tier color but bumps saturation. */
  .tier-H:hover { border-color: var(--accent); }
  .tier-M:hover { border-color: #5dd7c9; }
  .tier-S:hover { border-color: var(--text-3); }
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
    cursor: pointer;
    transition: opacity 120ms;
  }
  .bento-tag:hover { opacity: 0.75; }

  /* Filter bar: shows when a tag was clicked. ESC or "× limpar" exits. */
  #filter-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: rgba(138, 92, 246, 0.10);
    border: 1px solid rgba(138, 92, 246, 0.3);
    border-radius: 8px;
    margin-bottom: 18px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
  }
  #filter-bar[hidden] { display: none; }
  #filter-bar-tag {
    color: var(--accent);
    font-weight: 600;
  }
  #filter-bar-clear {
    margin-left: auto;
    background: transparent;
    border: 1px solid rgba(138, 92, 246, 0.4);
    color: var(--accent);
    cursor: pointer;
    padding: 3px 10px;
    border-radius: 5px;
    font-family: var(--mono);
    font-size: 11px;
    transition: background 120ms;
  }
  #filter-bar-clear:hover {
    background: rgba(138, 92, 246, 0.2);
  }

  /* Filtering rebuilds the grid HTML in place — no special styles needed for cells. */
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
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .bento-list a {
    color: var(--text-2);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: color 120ms, border-color 120ms;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bento-list a:hover {
    color: var(--text-1);
    border-bottom-color: var(--text-3);
  }
  .bento-item-del {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0 4px;
    border-radius: 3px;
    opacity: 0;
    transition: opacity 120ms, color 120ms, background 120ms;
    flex-shrink: 0;
  }
  .bento-item:hover .bento-item-del,
  .bento-dialog-list li:hover .bento-item-del {
    opacity: 1;
  }
  .bento-item-del:hover {
    color: #ff7676;
    background: var(--bg-2);
  }
  .bento-dialog-list li {
    display: flex;
    align-items: center;
  }
  .bento-dialog-list a {
    flex: 1;
  }
  .bento-more {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-3);
    margin-top: 6px;
    background: transparent;
    border: none;
    padding: 2px 0;
    cursor: pointer;
    text-align: left;
    transition: color 120ms;
  }
  .bento-more:hover {
    color: var(--accent);
  }
  /* Native <dialog> for "+N mais": full card list for one tag, centered, dim backdrop. */
  .bento-dialog {
    background: var(--bg-1);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0;
    max-width: 520px;
    width: calc(100% - 40px);
    max-height: 80vh;
    overflow: hidden;
    flex-direction: column;
  }
  /* Keep the browser default display:none when closed; only flex when open. Otherwise
     the dialog shell (header "#" + close button) renders inline at the bottom of the page. */
  .bento-dialog:not([open]) {
    display: none;
  }
  .bento-dialog[open] {
    display: flex;
  }
  .bento-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }
  .bento-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .bento-dialog-tag {
    font-family: var(--mono);
    color: var(--accent);
    font-weight: 600;
    font-size: 14px;
  }
  .bento-dialog-close {
    background: transparent;
    border: none;
    color: var(--text-3);
    cursor: pointer;
    font-size: 18px;
    padding: 0 6px;
    line-height: 1;
  }
  .bento-dialog-close:hover {
    color: var(--text-1);
  }
  .bento-dialog-list {
    list-style: none;
    margin: 0;
    padding: 8px 0;
    overflow-y: auto;
    flex: 1;
  }
  .bento-dialog-list li {
    margin: 0;
    padding: 0;
  }
  .bento-dialog-list a {
    display: block;
    padding: 8px 16px;
    color: var(--text-1);
    text-decoration: none;
    transition: background 100ms;
    font-size: 13px;
  }
  .bento-dialog-list a:hover {
    background: var(--bg-2);
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
  <span class="bento-meta">${health.totalTags} tags · ${health.taggedCards}/${health.totalCards} cards taggeados</span>
</div>
${renderHealthBlock(health, untaggedCards, incompleteCards)}
<div id="filter-bar" hidden>
  Filtrando <span id="filter-bar-tag">#</span>
  <span id="filter-bar-count" style="color: var(--text-3);"></span>
  <button type="button" id="filter-bar-clear" title="Esc">× limpar filtro</button>
</div>
${
  buckets.length === 0
    ? '<div class="bento-empty">Nenhum card com <code>&lt;meta name="tags"&gt;</code> ainda.</div>'
    : `<section class="bento-grid">${cells}</section>`
}
<dialog class="bento-dialog" id="bento-dialog">
  <div class="bento-dialog-head">
    <span class="bento-dialog-tag" id="bento-dialog-tag">#</span>
    <button type="button" class="bento-dialog-close" aria-label="Fechar">×</button>
  </div>
  <ul class="bento-dialog-list" id="bento-dialog-list"></ul>
</dialog>
<script type="application/json" id="bento-buckets">${fullPayload}</script>
<script>
  (() => {
    const data = JSON.parse(document.getElementById('bento-buckets').textContent);
    // data.byTag: { tag -> [{id,title,mtime}] }, data.cards: [{id,title,tags:[...]}]
    const dlg = document.getElementById('bento-dialog');
    const tagEl = document.getElementById('bento-dialog-tag');
    const listEl = document.getElementById('bento-dialog-list');
    const grid = document.querySelector('.bento-grid');
    // Capture original markup so we can restore when filter is cleared (avoids a reload).
    const originalGridHtml = grid ? grid.innerHTML : '';
    function escHtml(s) {
      return String(s).replace(/[&<>"]/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
      });
    }
    function open(tag) {
      const cards = (data.byTag && data.byTag[tag]) || [];
      tagEl.textContent = '#' + tag;
      listEl.innerHTML = cards
        .map(function (c) {
          const id = escHtml(c.id);
          const title = escHtml(c.title);
          return '<li><a href="' + id + '.html">' + title + '</a><button type="button" class="bento-item-del" data-id="' + id + '" title="Deletar este card" aria-label="Deletar">×</button></li>';
        })
        .join('');
      dlg.showModal();
    }
    async function deleteCard(id) {
      if (!id) return;
      // Confirm to avoid an accidental click — the file is gitignored so undo isn't trivial.
      if (!window.confirm('Deletar o card "' + id + '"? Não dá pra desfazer.')) return;
      try {
        const res = await fetch('/__decky/cards/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id })
        });
        if (!res.ok) throw new Error(await res.text());
        // Watcher regenerates tags-index.html within ~300ms; reload picks up the new content.
        setTimeout(function () { location.reload(); }, 350);
      } catch (err) {
        alert('Falha ao deletar: ' + (err && err.message ? err.message : err));
      }
    }
    document.querySelectorAll('.bento-more').forEach(function (btn) {
      btn.addEventListener('click', function () {
        open(btn.getAttribute('data-tag'));
      });
    });

    // ── Scope filter: click #X → rebuild bento with ONLY tags shared by cards-that-have-X.
    // Each visible cell's count is recomputed inside the scope, so you see how many of the
    // X cards also carry each other tag. Click another #Y from there → narrows to X∩Y.
    const bar = document.getElementById('filter-bar');
    const barTag = document.getElementById('filter-bar-tag');
    const barCount = document.getElementById('filter-bar-count');
    const barClear = document.getElementById('filter-bar-clear');
    let activeFilters = []; // chain of tags, e.g. ['decky'] then ['decky','widget']
    function tierFor(count) {
      if (count >= 7) return 'H';
      if (count >= 3) return 'M';
      return 'S';
    }
    function renderCell(tag, cards) {
      const t = tierFor(cards.length);
      const visibleCount = t === 'H' ? 6 : t === 'M' ? 4 : 2;
      const visible = cards.slice(0, visibleCount);
      const list = visible
        .map(function (c) {
          const id = escHtml(c.id);
          const title = escHtml(c.title);
          return '<li class="bento-item"><a href="' + id + '.html" data-card-id="' + id + '">' + title + '</a><button type="button" class="bento-item-del" data-id="' + id + '" title="Deletar este card" aria-label="Deletar">×</button></li>';
        })
        .join('');
      const more = cards.length > visible.length
        ? '<button type="button" class="bento-more" data-tag="' + escHtml(tag) + '">+' + (cards.length - visible.length) + ' mais</button>'
        : '';
      return '<article class="bento-cell tier-' + t + '" data-tag="' + escHtml(tag) + '">'
        + '<header class="bento-head"><span class="bento-tag">#' + escHtml(tag) + '</span><span class="bento-count">' + cards.length + '</span></header>'
        + '<ul class="bento-list">' + list + '</ul>'
        + more
        + '</article>';
    }
    function rebuildGrid() {
      if (!grid) return;
      if (activeFilters.length === 0) {
        grid.innerHTML = originalGridHtml;
        document.body.classList.remove('filtering');
        bar.hidden = true;
        return;
      }
      // Cards in scope = cards that have ALL active filter tags.
      const scopeCards = data.cards.filter(function (c) {
        return activeFilters.every(function (f) { return c.tags.indexOf(f) >= 0; });
      });
      // Recompute buckets across scopeCards, excluding the filter tags themselves.
      const scopeBuckets = {};
      for (let i = 0; i < scopeCards.length; i++) {
        const c = scopeCards[i];
        for (let j = 0; j < c.tags.length; j++) {
          const t = c.tags[j];
          if (activeFilters.indexOf(t) >= 0) continue;
          (scopeBuckets[t] = scopeBuckets[t] || []).push({ id: c.id, title: c.title, mtime: c.mtime });
        }
      }
      // Sort buckets desc by count, tiebreak by name. Sort each card list desc by mtime.
      const tags = Object.keys(scopeBuckets).sort(function (a, b) {
        return (scopeBuckets[b].length - scopeBuckets[a].length) || a.localeCompare(b);
      });
      for (const t of tags) scopeBuckets[t].sort(function (a, b) { return b.mtime - a.mtime; });
      grid.innerHTML = tags.map(function (t) { return renderCell(t, scopeBuckets[t]); }).join('');
      // Bar reflects the scope.
      barTag.textContent = activeFilters.map(function (f) { return '#' + f; }).join(' + ');
      barCount.textContent = ' · ' + scopeCards.length + ' card' + (scopeCards.length === 1 ? '' : 's') + ' no escopo';
      bar.hidden = false;
      document.body.classList.add('filtering');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function clearFilter() {
      activeFilters = [];
      rebuildGrid();
    }
    // Event delegation on the grid: clicks on a #tag inside any cell push it onto the
    // filter chain. Re-attached automatically because we listen on the static parent.
    if (grid) {
      grid.addEventListener('click', function (e) {
        const el = e.target;
        if (el && el.classList && el.classList.contains('bento-tag')) {
          const cell = el.closest('.bento-cell');
          if (cell) {
            const tag = cell.getAttribute('data-tag');
            if (activeFilters.indexOf(tag) < 0) {
              activeFilters.push(tag);
              rebuildGrid();
            }
          }
        }
      });
    }
    barClear.addEventListener('click', clearFilter);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeFilters.length > 0) {
        e.preventDefault();
        clearFilter();
      }
    });
    // Delegate delete clicks for BOTH the bento cells and the dialog list — dialog content
    // is rendered on demand so a static listener wouldn't catch its buttons.
    document.body.addEventListener('click', function (e) {
      const t = e.target;
      if (t && t.classList && t.classList.contains('bento-item-del')) {
        e.preventDefault();
        e.stopPropagation();
        deleteCard(t.getAttribute('data-id'));
      }
    });
    dlg.querySelector('.bento-dialog-close').addEventListener('click', function () {
      dlg.close();
    });
    dlg.addEventListener('click', function (e) {
      // Click outside the dialog content (i.e. on the ::backdrop) closes — <dialog> reports
      // the click target as the <dialog> itself when the user clicks the backdrop.
      if (e.target === dlg) dlg.close();
    });
  })();
</script>
</body>
</html>
`
}

const INDEX_NAME = 'tags-index.html'

export async function writeTagsIndex(cardsDir: string): Promise<string | null> {
  try {
    const data = await computeTagIndex(cardsDir)
    const html = renderTagsIndexHtml(data)
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
