import { visit, SKIP } from 'unist-util-visit'
import type { Root, Text, Link, PhrasingContent, Parent } from 'mdast'

// Tiny remark plugin that turns `[[name]]` text into clickable links. The link's URL is
// the synthetic scheme `wikilink:<name>` — the renderer's `a` override resolves the name
// to an absolute card path via IPC and dispatches `decky:open-path`.
//
// Visiting `text` nodes naturally skips fenced code (`code` nodes) and inline code
// (`inlineCode` nodes), whose content lives in `.value` rather than child text nodes.
// Names allow letters, digits, dashes, underscores, dots, slashes (for folder ids).

const WIKILINK_RE = /\[\[([\w./-]+)\]\]/g

export default function remarkWikilinks() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (index === undefined || !parent) return
      const value = node.value
      if (!value.includes('[[')) return
      WIKILINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      let last = 0
      const out: PhrasingContent[] = []
      while ((m = WIKILINK_RE.exec(value)) !== null) {
        if (m.index > last) {
          out.push({ type: 'text', value: value.slice(last, m.index) } satisfies Text)
        }
        const name = m[1]
        const link: Link = {
          type: 'link',
          url: `wikilink:${name}`,
          title: null,
          children: [{ type: 'text', value: name } satisfies Text]
        }
        out.push(link)
        last = m.index + m[0].length
      }
      if (out.length === 0) return
      if (last < value.length) {
        out.push({ type: 'text', value: value.slice(last) } satisfies Text)
      }
      ;(parent as Parent).children.splice(index, 1, ...out)
      // Skip the newly-inserted nodes; next visit picks up after them.
      return [SKIP, index + out.length]
    })
  }
}
