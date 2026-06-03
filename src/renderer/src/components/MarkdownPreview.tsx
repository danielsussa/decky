import { memo, useEffect, useMemo, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import 'highlight.js/styles/github-dark.css'
import MermaidBlock from './MermaidBlock'
import FlowBlock from './FlowBlock'
import ChecklistBlock from './ChecklistBlock'
import { splitIntoBlocks } from '../lib/markdown-blocks'

// Resolve <img src> against the .md file's directory. ReactMarkdown alone treats relative
// src as relative to the renderer page URL (http://localhost:xxxx in dev, file://app/... in
// prod), neither of which knows where the card .md lives. We rewrite relative srcs to the
// decky-asset:// protocol (see main/asset-protocol.ts) so they resolve to the actual file
// on disk under the card's directory.
function resolveAssetSrc(src: string | undefined, cardPath: string | undefined): string | undefined {
  if (!src) return src
  if (/^(https?:|data:|decky-asset:|blob:|file:)/i.test(src)) return src
  if (!cardPath) return src
  const lastSlash = cardPath.lastIndexOf('/')
  const baseDir = lastSlash >= 0 ? cardPath.slice(0, lastSlash) : ''
  const joined = src.startsWith('/') ? src : `${baseDir}/${src}`
  const parts = joined.split('/').reduce<string[]>((acc, part) => {
    if (part === '..') acc.pop()
    else if (part !== '.' && part !== '') acc.push(part)
    return acc
  }, [])
  // Authority 'card' is arbitrary but non-empty — Chromium silently drops <img>
  // requests for custom-scheme URLs with empty authority. Path segments are
  // encoded individually so slashes between them stay as path separators.
  const encoded = parts.map(encodeURIComponent).join('/')
  return `decky-asset://card/${encoded}`
}

// rehype-highlight runs BEFORE this component override and wraps code content in nested
// <span> elements for syntax highlighting. By the time `code()` receives `children`, it's
// no longer the raw source — it's a React tree. `String(tree)` returns "[object Object]",
// which mermaid can't parse. Walk the tree and concatenate every text leaf to recover
// the original source.
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}

// Intercept fenced widget blocks. Other code blocks fall through to rehype-highlight.
// The img override rewrites relative <img src> against the card's path (see resolveAssetSrc).
function makeComponents(cardPath: string | undefined, cardId: string | undefined): Components {
  return {
    code(props) {
      const { className, children, ...rest } = props
      const classes = className?.split(/\s+/) ?? []
      if (classes.includes('language-mermaid')) {
        return <MermaidBlock code={extractText(children).replace(/\n$/, '')} />
      }
      if (classes.includes('language-flow')) {
        return (
          <FlowBlock code={extractText(children).replace(/\n$/, '')} cardId={cardId ?? ''} />
        )
      }
      if (classes.includes('language-checklist')) {
        return (
          <ChecklistBlock
            code={extractText(children).replace(/\n$/, '')}
            cardId={cardId ?? ''}
          />
        )
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    },
    img(props) {
      const src = typeof props.src === 'string' ? props.src : undefined
      const resolved = resolveAssetSrc(src, cardPath)
      return <img {...props} src={resolved} />
    }
  }
}

interface MarkdownPreviewProps {
  content: string
  cardId?: string
  path?: string
}

// Module-level so they survive component unmount/remount (tab switch).
//   - scrollByCard: restore per-card scroll position when remounting
//   - seenBlockKeys: a block key that has been rendered at least once skips its fade-in animation
//     on subsequent appearances (closing/reopening a card, re-render after sibling edit).
const scrollByCard = new Map<string, number>()
const seenBlockKeys = new Set<string>()

// Each top-level markdown block (heading, paragraph, list, fence, table, ...) renders inside
// its own keyed `<div className="md-block">`. The key is a hash of the block's source text:
// same content → same key → React preserves the same DOM → no animation. Different content
// at the same position (an edit) → new key → React mounts a fresh element → `.md-block-enter`
// fires the fade-in keyframes. Siblings stay untouched. Widgets (FlowBlock/ChecklistBlock)
// keep their internal state because the fence's source text is unchanged.
//
// memo()ed because App.tsx ticks a heartbeat state every ~600ms (collapsed-tab spinner). Without
// memo, this component re-renders unnecessarily and ReactMarkdown does pointless work, which
// would remount fence widgets (MermaidBlock re-runs mermaid.render, etc.).
function MarkdownPreviewInner({
  content,
  cardId,
  path
}: MarkdownPreviewProps): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const blocks = useMemo(() => splitIntoBlocks(content), [content])

  // Stable identity so ReactMarkdown doesn't see a "new" components prop on every render.
  const components = useMemo(() => makeComponents(path, cardId), [path, cardId])

  // Restore the saved scroll position when this card mounts/refocuses. Runs whenever the
  // block list changes — the card may grow over several renders, so we re-check until the
  // scrollable area has caught up to the saved offset.
  useEffect(() => {
    if (!cardId) return
    const el = bodyRef.current
    if (!el) return
    const saved = scrollByCard.get(cardId) ?? 0
    if (saved > 0 && Math.abs(el.scrollTop - saved) > 1 && el.scrollHeight >= saved) {
      el.scrollTop = saved
    }
  }, [cardId, blocks])

  const onScroll = (): void => {
    if (!cardId) return
    const el = bodyRef.current
    if (el) scrollByCard.set(cardId, el.scrollTop)
  }

  return (
    <div className="md-preview">
      <div className="md-body" ref={bodyRef} onScroll={onScroll}>
        {blocks.map((block) => {
          const isNew = !seenBlockKeys.has(block.key)
          // Mark this key as seen synchronously so that an immediate re-render of the same
          // block (e.g. heartbeat tick) doesn't repeat the entry animation.
          seenBlockKeys.add(block.key)
          return (
            <div
              key={block.key}
              className={`md-block${isNew ? ' md-block-enter' : ''}`}
              data-block-type={block.type}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw, rehypeHighlight]}
                components={components}
              >
                {block.text}
              </ReactMarkdown>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const MarkdownPreview = memo(MarkdownPreviewInner)
export default MarkdownPreview
