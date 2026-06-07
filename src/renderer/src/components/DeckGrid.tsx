import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GridStack, type GridStackOptions, type GridStackWidget } from 'gridstack'
import { Focus, Maximize2, Minimize2, Pin } from 'lucide-react'
import 'gridstack/dist/gridstack.min.css'
import { t } from '../lib/i18n'

export interface DeckCard {
  id: string
  x?: number
  y?: number
  w?: number
  h?: number
  minW?: number
  minH?: number
  title?: string
  pinned?: boolean
  render: () => ReactNode
}

interface DeckGridProps {
  cards: DeckCard[]
  focusedId: string | null
  onFocusChange: (id: string | null) => void
  onTogglePin?: (id: string) => void
}

const GRID_OPTS: GridStackOptions = {
  column: 12,
  cellHeight: 60,
  margin: 6,
  animate: true,
  float: true,
  disableResize: false,
  disableDrag: false,
  draggable: { handle: '.deck-card-header' },
  resizable: { handles: 'se, sw, ne, nw, n, s, e, w' }
}

export default function DeckGrid({
  cards,
  focusedId,
  onFocusChange,
  onTogglePin
}: DeckGridProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const gridRef = useRef<GridStack | null>(null)
  const [fullscreenId, setFullscreenId] = useState<string | null>(null)

  const toggleFocus = (id: string): void => {
    onFocusChange(focusedId === id ? null : id)
  }

  const toggleFullscreen = (id: string): void => {
    setFullscreenId((cur) => (cur === id ? null : id))
  }

  useEffect(() => {
    if (!ref.current) return
    if (fullscreenId) return // gridstack stays in DOM but hidden; skip init/destroy here
    const grid = GridStack.init(GRID_OPTS, ref.current)
    gridRef.current = grid

    grid.batchUpdate()
    grid.removeAll(false)
    cards.forEach((c) => {
      const el = ref.current?.querySelector<HTMLElement>(`.grid-stack-item[gs-id="${c.id}"]`)
      if (!el) return
      const widget: GridStackWidget = {
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        minW: c.minW,
        minH: c.minH,
        id: c.id
      }
      grid.makeWidget(el, widget)
    })
    grid.batchUpdate(false)

    return () => {
      grid.destroy(false)
      gridRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.map((c) => c.id).join('|'), fullscreenId])

  const renderCardChrome = (c: DeckCard, isFullscreen: boolean): ReactNode => {
    const isFocused = focusedId === c.id
    return (
      <div
        className={`grid-stack-item-content deck-card ${isFocused ? 'deck-card-focused' : ''} ${isFullscreen ? 'deck-card-fullscreen' : ''}`}
      >
        <div className="deck-card-header">
          <span className="deck-card-title">{c.title ?? c.id}</span>
          {onTogglePin && (
            <button
              type="button"
              className={`deck-card-icon ${c.pinned ? 'deck-card-pinned' : ''}`}
              title={c.pinned ? t('grid.unpin') : t('grid.pinAll')}
              onClick={(e) => {
                e.stopPropagation()
                onTogglePin(c.id)
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <Pin size={13} strokeWidth={1.75} fill={c.pinned ? 'currentColor' : 'none'} />
            </button>
          )}
          <button
            type="button"
            className="deck-card-icon"
            title={isFocused ? t('grid.unfocus') : t('grid.focus')}
            onClick={(e) => {
              e.stopPropagation()
              toggleFocus(c.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Focus size={13} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="deck-card-icon"
            title={isFullscreen ? t('grid.exitFullscreen') : t('grid.fullscreen')}
            onClick={(e) => {
              e.stopPropagation()
              toggleFullscreen(c.id)
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {isFullscreen ? (
              <Minimize2 size={13} strokeWidth={1.75} />
            ) : (
              <Maximize2 size={13} strokeWidth={1.75} />
            )}
          </button>
        </div>
        <div className="deck-card-body">{c.render()}</div>
      </div>
    )
  }

  const fullscreenCard = fullscreenId ? cards.find((c) => c.id === fullscreenId) : null

  if (fullscreenCard) {
    return (
      <div className="deck-grid-root">
        <div className="deck-fullscreen-wrap">{renderCardChrome(fullscreenCard, true)}</div>
      </div>
    )
  }

  return (
    <div className="deck-grid-root">
      <div className="grid-stack" ref={ref}>
        {cards.map((c) => (
          <div
            key={c.id}
            className="grid-stack-item"
            gs-id={c.id}
            gs-x={c.x}
            gs-y={c.y}
            gs-w={c.w}
            gs-h={c.h}
            gs-min-w={c.minW}
            gs-min-h={c.minH}
          >
            {renderCardChrome(c, false)}
          </div>
        ))}
      </div>
    </div>
  )
}
