import { Children, useCallback, useEffect, useRef, useState } from 'react'

interface ResizableSplitProps {
  /** Initial percentage sizes — must sum to 100, length must match children. */
  defaultSizes: number[]
  /** Minimum percentage per pane (defaults to 5). */
  minSizes?: number[]
  /** localStorage key for persisting layout. */
  storageKey?: string
  children: React.ReactNode
}

export default function ResizableSplit({
  defaultSizes,
  minSizes,
  storageKey,
  children
}: ResizableSplitProps): React.JSX.Element {
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

      const containerWidth = container.getBoundingClientRect().width
      const startX = e.clientX
      const startSizes = [...sizes]
      setDragging(true)

      const onMove = (ev: MouseEvent): void => {
        const deltaPx = ev.clientX - startX
        const deltaPct = (deltaPx / containerWidth) * 100

        // adjust the two panes adjacent to this handle
        const left = handleIdx
        const right = handleIdx + 1
        const newLeft = startSizes[left] + deltaPct
        const newRight = startSizes[right] - deltaPct

        if (newLeft < mins[left] || newRight < mins[right]) return

        const next = [...startSizes]
        next[left] = newLeft
        next[right] = newRight
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
    [sizes, mins]
  )

  return (
    <div className="rsplit" ref={containerRef}>
      {panes.map((child, i) => (
        <div key={i} className="rsplit-pane" style={{ width: `${sizes[i]}%` }}>
          {child}
          {i < n - 1 && (
            <div
              className="rsplit-handle"
              onMouseDown={(e) => startDrag(i, e)}
              role="separator"
              aria-orientation="vertical"
            />
          )}
        </div>
      ))}
      {dragging && <div className="rsplit-overlay" />}
    </div>
  )
}
