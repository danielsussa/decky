import { useEffect, useState } from 'react'

// Card paths live under `<workspace>/.decky/cards/...`. Reused here (not imported from
// MarkdownPreview) because BacklinksFooter is rendered as its own block at the end of
// MarkdownPreview's body — we need the workspace root to call the backlinks IPC.
function workspaceFromCardPath(cardPath: string): string | undefined {
  const idx = cardPath.indexOf('/.decky/cards/')
  return idx > 0 ? cardPath.slice(0, idx) : undefined
}

interface BacklinkHit {
  id: string
  path: string
  title: string
  snippet: string
  line: number
  mtime: number
}

interface BacklinksFooterProps {
  cardPath: string
  sessionId: string
}

// "Referenciado por: N cards" pill that lives at the bottom of every markdown card. Hidden
// when zero backlinks so unconnected cards stay clean. Re-fetches when the path changes
// (tab switch) but NOT on content change — wikilinks in a card don't usually flip on the
// fly, and we don't want the footer flickering on every keystroke-like file watcher event.
export default function BacklinksFooter({
  cardPath,
  sessionId
}: BacklinksFooterProps): React.JSX.Element | null {
  const workspace = workspaceFromCardPath(cardPath)
  const [hits, setHits] = useState<BacklinkHit[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    void window.deck.cards.backlinks(workspace, cardPath).then((res) => {
      if (!cancelled) setHits(res)
    })
    return () => {
      cancelled = true
    }
  }, [workspace, cardPath])

  if (!workspace || hits.length === 0) return null

  const openHit = (hit: BacklinkHit): void => {
    window.dispatchEvent(
      new CustomEvent('decky:open-path', { detail: { path: hit.path, sessionId } })
    )
  }

  return (
    <div className="backlinks-footer">
      <button
        type="button"
        className="backlinks-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="backlinks-caret">{open ? '▾' : '▸'}</span>
        <span className="backlinks-label">
          Referenciado por {hits.length} {hits.length === 1 ? 'card' : 'cards'}
        </span>
      </button>
      {open && (
        <ul className="backlinks-list">
          {hits.map((hit) => (
            <li key={hit.id} className="backlinks-item">
              <button type="button" className="backlinks-item-button" onClick={() => openHit(hit)}>
                <span className="backlinks-item-title">{hit.title}</span>
                <span className="backlinks-item-id">{hit.id}</span>
                {hit.snippet && <span className="backlinks-item-snippet">{hit.snippet}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
