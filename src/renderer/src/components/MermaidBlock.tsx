import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'

// Single global init — mermaid.initialize is a module-level setter, calling it per-block
// would race with concurrent render() calls. Theme reads the renderer's current background
// to follow decky's light/dark mode.
let initialized = false
function ensureInit(): void {
  if (initialized) return
  initialized = true
  const isDark = matchMedia('(prefers-color-scheme: dark)').matches
  const root = getComputedStyle(document.documentElement)
  const bg = root.getPropertyValue('--bg-0').trim() || (isDark ? '#1e2330' : '#fff')
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit',
    themeVariables: { background: bg }
  })
}

interface MermaidBlockProps {
  code: string
}

export default function MermaidBlock({ code }: MermaidBlockProps): React.JSX.Element {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ensureInit()
    let cancelled = false
    const id = `m${reactId}`
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setSvg(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [code, reactId])

  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-msg">mermaid: {error}</div>
        <pre className="mermaid-error-src">
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="mermaid-block" dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
  )
}
