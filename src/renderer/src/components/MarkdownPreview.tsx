import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'

interface MarkdownPreviewProps {
  content: string
}

// Cheap signature of a content string to remember what we've already streamed in — so a card
// streams its FIRST appearance (and each new append), but re-showing it (tab switch, workspace
// switch) renders instantly instead of re-animating. Module-level so it survives remounts.
const streamedSigs = new Set<string>()
const sigOf = (s: string): string => `${s.length}|${s.slice(-24)}`

// Draw the preview "streaming": on first appearance reveal from empty → full; on an append
// reveal just the new tail; a re-show (already streamed) or a tiny delta renders instantly.
// Duration is capped so big content doesn't re-parse markdown for too long.
export default function MarkdownPreview({ content }: MarkdownPreviewProps): React.JSX.Element {
  const [shown, setShown] = useState(() => (streamedSigs.has(sigOf(content)) ? content : ''))
  const prevRef = useRef(shown)
  const rafRef = useRef<number | null>(null)

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
      <div className="md-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {shown}
        </ReactMarkdown>
      </div>
    </div>
  )
}
