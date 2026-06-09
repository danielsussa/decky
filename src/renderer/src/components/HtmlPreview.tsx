import { useEffect, useState } from 'react'
import WebPreview from './WebPreview'

interface HtmlPreviewProps {
  cardId: string
  path: string
  workspaceCwd?: string | null
  onMetaChange?: (meta: { url?: string; title?: string; favicon?: string | null }) => void
}

// Thin wrapper that resolves a local .html path to an http://127.0.0.1:<port> URL (main spins
// up an ephemeral server per directory) and then renders a regular WebPreview at that URL —
// so html cards get the full address bar / back / reload / devtools chrome for free.
//
// The persisted PreviewSource stores the path only (not the URL) — the port is reassigned each
// app start, so we re-resolve on every mount and the card always points at a live server.
export default function HtmlPreview({
  cardId,
  path,
  workspaceCwd,
  onMetaChange
}: HtmlPreviewProps): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setError(null)
    void window.deck.html
      .resolve(path)
      .then((u) => {
        if (cancelled) return
        setUrl(u)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e?.message ?? e))
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (error) {
    return (
      <div className="preview-empty">
        <p>
          falha ao servir HTML: <code>{error}</code>
        </p>
      </div>
    )
  }
  if (!url) {
    return <div className="preview-empty" />
  }
  return (
    <WebPreview
      cardId={cardId}
      url={url}
      workspaceCwd={workspaceCwd ?? null}
      onMetaChange={onMetaChange}
    />
  )
}
