import type { DeckCard } from './DeckGrid'

interface DeckTabsProps {
  cards: DeckCard[]
  focusedId: string | null
  onFocusChange: (id: string | null) => void
  onClose?: (id: string) => void
}

export default function DeckTabs({
  cards,
  focusedId,
  onFocusChange,
  onClose
}: DeckTabsProps): React.JSX.Element {
  const activeId = focusedId && cards.some((c) => c.id === focusedId) ? focusedId : cards[0]?.id
  const active = cards.find((c) => c.id === activeId)

  if (cards.length === 0) {
    return (
      <div className="preview-empty">
        <p>
          nenhum card ainda. o claude desta sessão cria cards conforme renderiza
          (markdown, json, live view).
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
            className={`deck-tab ${c.id === activeId ? 'deck-tab-active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onFocusChange(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onFocusChange(c.id)
            }}
          >
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
      <div className="deck-tabs-body">{active?.render()}</div>
    </div>
  )
}
