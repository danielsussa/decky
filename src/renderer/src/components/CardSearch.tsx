import { useEffect, useRef, useState } from 'react'

export interface CardSearchHit {
  id: string
  path: string
  title: string
  snippet: string
  line: number
  score: number
  mtime: number
}

interface CardSearchProps {
  workspace: string
  onPick: (hit: CardSearchHit) => void
  onClose: () => void
}

// "Find in cards" palette — full-text search across <workspace>/.decky/cards/.
// Reuses .palette-* styles. Bound to Cmd+Shift+F in App.tsx.
export default function CardSearch({
  workspace,
  onPick,
  onClose
}: CardSearchProps): React.JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [hits, setHits] = useState<CardSearchHit[]>([])
  const reqRef = useRef(0)

  // Debounce + race-guard: only apply results from the latest request.
  useEffect(() => {
    const myReq = ++reqRef.current
    const t = setTimeout(async () => {
      const res = await window.deck.cards.search(workspace, q, 20).catch(() => [])
      if (reqRef.current !== myReq) return
      setHits(res)
      setSel(0)
    }, 120)
    return () => clearTimeout(t)
  }, [workspace, q])

  const pick = (h: CardSearchHit | undefined): void => {
    if (!h) return
    onPick(h)
    onClose()
  }

  const placeholder = 'buscar nos cards…'

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, hits.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(hits[sel])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="palette-list">
          {hits.length === 0 && (
            <div className="palette-empty">
              {q.trim() ? 'nenhum card' : 'nenhum card neste workspace'}
            </div>
          )}
          {hits.map((h, i) => {
            const isSel = i === sel
            return (
              <div
                key={h.id}
                className={`palette-item card-search-item ${isSel ? 'palette-item-sel' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(h)}
              >
                <div className="card-search-row">
                  <div className="card-search-head">
                    <span className="palette-item-label">{h.title}</span>
                    <span className="palette-item-hint">{h.id}</span>
                  </div>
                  {h.snippet && <div className="card-search-snippet">{h.snippet}</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
