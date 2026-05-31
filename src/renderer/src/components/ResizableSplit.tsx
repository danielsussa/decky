import { Children, useCallback, useEffect, useRef, useState } from 'react'

interface ResizableSplitProps {
  /** Initial percentage sizes — must sum to 100, length must match children. */
  defaultSizes: number[]
  /** Minimum percentage per pane (defaults to 5). */
  minSizes?: number[]
  /** localStorage key for persisting layout. */
  storageKey?: string
  /** Split axis. Defaults to horizontal (panes side-by-side, handle resizes width). */
  direction?: 'horizontal' | 'vertical'
  children: React.ReactNode
}

export default function ResizableSplit({
  defaultSizes,
  minSizes,
  storageKey,
  direction = 'horizontal',
  children
}: ResizableSplitProps): React.JSX.Element {
  const isVertical = direction === 'vertical'
  const panes = Children.toArray(children)
  const n = panes.length

  const [sizes, setSizes] = useState<number[]>(() => {
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed) && parsed.length === n) return parsed
        }
      } catch {
        // bad JSON, fall through
      }
    }
    return defaultSizes
  })

  useEffect(() => {
    if (!storageKey) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(sizes))
    } catch {
      // quota or sandbox
    }
  }, [sizes, storageKey])

  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const mins = minSizes ?? new Array(n).fill(5)

  const startDrag = useCallback(
    (handleIdx: number, e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const containerSize = isVertical ? rect.height : rect.width
      const startCoord = isVertical ? e.clientY : e.clientX
      const startSizes = [...sizes]
      setDragging(true)

      const onMove = (ev: MouseEvent): void => {
        const coord = isVertical ? ev.clientY : ev.clientX
        const deltaPx = coord - startCoord
        const deltaPct = (deltaPx / containerSize) * 100

        // adjust the two panes adjacent to this handle
        const a = handleIdx
        const b = handleIdx + 1
        const newA = startSizes[a] + deltaPct
        const newB = startSizes[b] - deltaPct

        if (newA < mins[a] || newB < mins[b]) return

        const next = [...startSizes]
        next[a] = newA
        next[b] = newB
        setSizes(next)
      }

      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setDragging(false)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [sizes, mins, isVertical]
  )

  const rootClass = `rsplit ${isVertical ? 'rsplit-v' : ''}`.trim()
  const overlayClass = `rsplit-overlay ${isVertical ? 'rsplit-overlay-v' : ''}`.trim()

  return (
    <div className={rootClass} ref={containerRef}>
      {panes.map((child, i) => (
        <div
          key={i}
          className="rsplit-pane"
          style={isVertical ? { height: `${sizes[i]}%` } : { width: `${sizes[i]}%` }}
        >
          {child}
          {i < n - 1 && (
            <div
              className="rsplit-handle"
              onMouseDown={(e) => startDrag(i, e)}
              role="separator"
              aria-orientation={isVertical ? 'horizontal' : 'vertical'}
            />
          )}
        </div>
      ))}
      {dragging && <div className={overlayClass} />}
    </div>
  )
}
