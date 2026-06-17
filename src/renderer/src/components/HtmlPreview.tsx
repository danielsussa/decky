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

  // Push-based live reload: when something mutates this card's source file (e.g. `decky
  // add-widget`/`title` editing the manifest .json), main broadcasts `card:reload { path }` and
  // we reload just this card's WebContentsView — no dependency on the fs watcher firing.
  useEffect(() => {
    return window.deck.web.onReload((msg) => {
      if (msg.path === path) window.deck.web.reload(cardId)
    })
  }, [path, cardId])

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
  // Basename do .html original — usado pelo WebPreview pra esconder o ruído da URL
  // local-server (`http://127.0.0.1:<porta>/xxx.html`) e mostrar só `xxx.html` quando
  // o address bar está blur. Ao focar, a URL real reaparece.
  const basename = (path.split('/').pop() ?? path).replace(/\.json$/i, '')
  return (
    <WebPreview
      cardId={cardId}
      url={url}
      workspaceCwd={workspaceCwd ?? null}
      onMetaChange={onMetaChange}
      displayAlias={basename}
    />
  )
}
