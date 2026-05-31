import { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import 'highlight.js/styles/github-dark.css'
import MermaidBlock from './MermaidBlock'

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

// Intercept ```mermaid fenced blocks and render them as diagrams instead of code.
// Other code blocks fall through to rehype-highlight's default. The img override rewrites
// relative <img src> against the card's path (see resolveAssetSrc).
function makeComponents(cardPath: string | undefined): Components {
  return {
    code(props) {
      const { className, children, ...rest } = props
      const classes = className?.split(/\s+/) ?? []
      if (classes.includes('language-mermaid')) {
        return <MermaidBlock code={String(children).replace(/\n$/, '')} />
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

// Cheap signature of a content string to remember what we've already streamed in — so a card
// streams its FIRST appearance (and each new append), but re-showing it (tab switch, workspace
// switch) renders instantly instead of re-animating. Module-level so it survives remounts.
const streamedSigs = new Set<string>()
const sigOf = (s: string): string => `${s.length}|${s.slice(-24)}`

// Remember where each card was scrolled to, by card id — restores on remount after
// session/tab switch. Module-level so it survives unmounts.
const scrollByCard = new Map<string, number>()

// Draw the preview "streaming": on first appearance reveal from empty → full; on an append
// reveal just the new tail; a re-show (already streamed) or a tiny delta renders instantly.
// Duration is capped so big content doesn't re-parse markdown for too long.
export default function MarkdownPreview({
  content,
  cardId,
  path
}: MarkdownPreviewProps): React.JSX.Element {
  const [shown, setShown] = useState(() => (streamedSigs.has(sigOf(content)) ? content : ''))
  const prevRef = useRef(shown)
  const rafRef = useRef<number | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Restore the saved scroll position when this card mounts/refocuses. Runs whenever the
  // mounted content has caught up enough to fit the prior scrollTop (the card may streamline
  // in over several frames, so layoutEffect on first mount alone wouldn't always have height).
  useEffect(() => {
    if (!cardId) return
    const el = bodyRef.current
    if (!el) return
    const saved = scrollByCard.get(cardId) ?? 0
    if (saved > 0 && Math.abs(el.scrollTop - saved) > 1 && el.scrollHeight >= saved) {
      el.scrollTop = saved
    }
  }, [cardId, shown])

  const onScroll = (): void => {
    if (!cardId) return
    const el = bodyRef.current
    if (el) scrollByCard.set(cardId, el.scrollTop)
  }

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = content
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)

    if (streamedSigs.has(sigOf(content))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown(content) // already streamed once — re-show instantly
      return
    }

    // Reveal from the longest matching prefix (the appended case) or from empty (fresh/rewrite).
    const from = content.startsWith(prev) ? prev.length : 0
    const to = content.length
    if (to <= from) {
      setShown(content)
      streamedSigs.add(sigOf(content))
      return
    }

    const duration = Math.min(700, Math.max(150, (to - from) * 4))
    let start: number | null = null
    const tick = (now: number): void => {
      if (start === null) start = now
      const t = Math.min(1, (now - start) / duration)
      setShown(content.slice(0, Math.floor(from + (to - from) * t)))
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setShown(content)
        streamedSigs.add(sigOf(content))
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [content])

  return (
    <div className="md-preview">
      <div className="md-body" ref={bodyRef} onScroll={onScroll}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeHighlight]}
          components={makeComponents(path)}
        >
          {shown}
        </ReactMarkdown>
      </div>
    </div>
  )
}
