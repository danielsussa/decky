import { useState } from 'react'
import { Pin } from 'lucide-react'
import type { DeckCard } from './DeckGrid'

interface DeckTabsProps {
  cards: DeckCard[]
  focusedId: string | null
  onFocusChange: (id: string | null) => void
  onClose?: (id: string) => void
  onTogglePin?: (id: string) => void
  onReorder?: (orderedIds: string[]) => void
}

export default function DeckTabs({
  cards,
  focusedId,
  onFocusChange,
  onClose,
  onTogglePin,
  onReorder
}: DeckTabsProps): React.JSX.Element {
  const activeId = focusedId && cards.some((c) => c.id === focusedId) ? focusedId : cards[0]?.id
  const active = cards.find((c) => c.id === activeId)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const endDrag = (): void => {
    setDragId(null)
    setOverId(null)
  }

  const dropOn = (targetId: string): void => {
    if (!onReorder || !dragId || dragId === targetId) return endDrag()
    const ids = cards.map((c) => c.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return endDrag()
    ids.splice(from, 1)
    ids.splice(to, 0, dragId)
    onReorder(ids)
    endDrag()
  }

  if (cards.length === 0) {
    return (
      <div className="preview-empty">
        <p>
          nenhum card ainda. o claude desta sessão cria cards conforme renderiza (markdown, json,
          live view).
        </p>
      </div>
    )
  }

  return (
    <div className="deck-tabs">
      <div className="deck-tabs-bar">
        {cards.map((c) => (
          <div
            key={c.id}
            className={`deck-tab ${c.id === activeId ? 'deck-tab-active' : ''} ${c.pinned ? 'deck-tab-ispinned' : ''} ${overId === c.id && dragId !== c.id ? 'deck-tab-dragover' : ''} ${dragId === c.id ? 'deck-tab-dragging' : ''}`}
            role="button"
            tabIndex={0}
            title={
              onTogglePin ? 'duplo-clique pra fixar/desafixar · arraste pra reordenar' : undefined
            }
            draggable={!!onReorder}
            onDragStart={() => setDragId(c.id)}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              setOverId(c.id)
            }}
            onDragEnd={endDrag}
            onDrop={(e) => {
              e.preventDefault()
              dropOn(c.id)
            }}
            onClick={() => onFocusChange(c.id)}
            onDoubleClick={() => onTogglePin?.(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onFocusChange(c.id)
            }}
          >
            {c.pinned && <Pin size={10} fill="currentColor" className="deck-tab-pinmark" />}
            <span className="deck-tab-label">{c.title ?? c.id}</span>
            {onClose && (
              <button
                type="button"
                className="deck-tab-close"
                title="fechar card"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(c.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="deck-tabs-body" key={active?.id ?? '__empty'}>
        {active?.render()}
      </div>
    </div>
  )
}
