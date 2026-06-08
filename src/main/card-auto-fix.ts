import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// Cards in `<ws>/.decky/cards/...` often grow image refs that don't actually exist at the
// path written — typical pattern is off-by-one `..` when the card lives in a subfolder
// (`<ws>/.decky/cards/<sub>/x.md` needs `../../../` to reach `<ws>`, but authors commonly
// write `../../` thinking 2 levels suffices). Hand-fixing every .md doesn't scale, and we
// also want the .md to stay filesystem-correct so VSCode/GitHub render it too.
//
// On every card change, we re-derive the path filesystem-side: for each `![](src)` whose
// target file doesn't exist, search the workspace for files whose absolute path ends with
// the same trailing segments. Exactly one match → rewrite the .md with the correct relative
// path. Zero or multiple matches → leave alone, log so the author can fix manually.

const IMG_REF_RE = /(!\[[^\]]*\]\()([^)\s]+)(\s*(?:"[^"]*"|'[^']*')?\s*\))/g

// Skip noisy directories during the workspace scan so big repos don't take forever.
const SKIP_DIRS = new Set([
  '.decky',
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '.turbo',
  'out',
  '.venv',
  '__pycache__'
])

function workspaceFromCard(mdPath: string): string | null {
  const idx = mdPath.indexOf('/.decky/cards/')
  return idx > 0 ? mdPath.slice(0, idx) : null
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const s = await stat(abs)
    return s.isFile()
  } catch {
    return false
  }
}

async function walkWorkspace(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.decky') {
        // Allow `.decky` (we filter it via SKIP_DIRS) but skip other hidden dirs entirely.
        if (e.isDirectory()) continue
      }
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        await visit(full)
      } else if (e.isFile()) {
        out.push(full)
      }
    }
  }
  await visit(root)
  return out
}

// Find files whose absolute path ends with the longest suffix of `srcParts` that yields
// matches. Try the longest specificity first; if no match, drop the leading segment and try
// again. Returns matches at the most specific level we found anything at.
function findBySuffix(allFiles: string[], srcParts: string[]): string[] {
  for (let n = Math.min(srcParts.length, 5); n >= 1; n--) {
    const want = '/' + srcParts.slice(-n).join('/')
    const matches = allFiles.filter((f) => f.endsWith(want))
    if (matches.length > 0) return matches
  }
  return []
}

interface FixResult {
  content: string
  fixes: Array<{ from: string; to: string }>
}

export async function computeAutoFix(mdPath: string): Promise<FixResult | null> {
  const workspace = workspaceFromCard(mdPath)
  if (!workspace) return null
  let content: string
  try {
    content = await readFile(mdPath, 'utf-8')
  } catch {
    return null
  }
  const cardDir = dirname(mdPath)

  // First pass: collect refs that need fixing (existence check only). Bail early if all
  // refs resolve — avoids the workspace scan in the common case.
  interface Pending {
    match: string
    pre: string
    src: string
    post: string
  }
  const pending: Pending[] = []
  for (const m of content.matchAll(IMG_REF_RE)) {
    const src = m[2]
    if (!src) continue
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue // external (http, data, etc.)
    const abs = src.startsWith('/') ? src : resolve(cardDir, src)
    if (await fileExists(abs)) continue
    pending.push({ match: m[0], pre: m[1], src, post: m[3] })
  }
  if (pending.length === 0) return null

  // Now do the expensive workspace scan once and resolve all pending refs against it.
  const allFiles = await walkWorkspace(workspace)
  const fixes: Array<{ from: string; to: string }> = []
  const replacements = new Map<string, string>()
  for (const p of pending) {
    const parts = p.src.split('/').filter((s) => s && s !== '.' && s !== '..')
    if (parts.length === 0) continue
    const candidates = findBySuffix(allFiles, parts)
    if (candidates.length !== 1) {
      console.warn(
        `[card-auto-fix] ${candidates.length === 0 ? 'no match' : `${candidates.length} matches`} for "${p.src}" in ${mdPath}`
      )
      continue
    }
    const fixedRel = relative(cardDir, candidates[0])
    if (fixedRel === p.src) continue
    const newRef = `${p.pre}${fixedRel}${p.post}`
    replacements.set(p.match, newRef)
    fixes.push({ from: p.src, to: fixedRel })
  }
  if (replacements.size === 0) return null

  let next = content
  for (const [from, to] of replacements) {
    next = next.split(from).join(to)
  }
  return { content: next, fixes }
}

export async function applyAutoFix(mdPath: string): Promise<boolean> {
  let result: FixResult | null
  try {
    result = await computeAutoFix(mdPath)
  } catch (err) {
    console.error('[card-auto-fix] failed:', mdPath, err)
    return false
  }
  if (!result) return false
  try {
    await writeFile(mdPath, result.content, 'utf-8')
  } catch (err) {
    console.error('[card-auto-fix] write failed:', mdPath, err)
    return false
  }
  for (const f of result.fixes) {
    console.log(`[card-auto-fix] ${mdPath}: ${f.from} → ${f.to}`)
  }
  return true
}
