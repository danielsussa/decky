import { unified, type Processor } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'

// Parse markdown to mdast, then slice the SOURCE TEXT by each top-level child's position. We
// render each slice independently in MarkdownPreview so block identity is content-derived (the
// React `key`) instead of position-derived — that way editing one block doesn't unmount/remount
// the others, and entering blocks can animate via CSS without affecting siblings.

let parser: Processor<Root> | null = null
function getParser(): Processor<Root> {
  if (!parser) parser = unified().use(remarkParse).use(remarkGfm) as unknown as Processor<Root>
  return parser
}

export interface MarkdownBlock {
  text: string
  type: string
  key: string
}

// FNV-1a 32-bit. Non-crypto — collisions just mean "no entry animation when content reappears
// with the same hash elsewhere", which is harmless. Keeps keys short and the loop tight.
function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}

export function splitIntoBlocks(content: string): MarkdownBlock[] {
  if (!content) return []
  const tree = getParser().parse(content) as Root
  const blocks: MarkdownBlock[] = []
  for (const child of tree.children) {
    const pos = child.position
    if (!pos) continue
    const startOffset = pos.start.offset ?? 0
    const endOffset = pos.end.offset ?? content.length
    const text = content.slice(startOffset, endOffset)
    if (!text.trim()) continue
    blocks.push({ text, type: child.type, key: hash(text) })
  }
  return blocks
}
