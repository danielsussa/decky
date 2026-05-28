import { useState, type ReactNode } from 'react'

export interface Session {
  id: string
  label: string
  project?: string
  cwd: string
  kind: 'claude' | 'shell'
  /** UUID passed to `claude --session-id` for kind=claude — persists conversation across deck restarts. */
  claudeSessionId?: string
}

interface SessionStackProps {
  sessions: Session[]
  activeId?: string
  onActiveChange?: (id: string) => void
  /** Renders the body of each session. Inactive bodies stay mounted but hidden to preserve state. */
  renderBody: (session: Session, ctx: { isActive: boolean }) => ReactNode
  /** Per-session short status (running/thinking/writing) + whether output is flowing now. */
  activity?: Record<string, { status: string; active: boolean }>
  /** Custom footer (e.g. add-session button or inline form). */
  footer?: ReactNode
  onClose?: (id: string) => void
  onReorder?: (orderedIds: string[]) => void
}

export default function SessionStack({
  sessions,
  activeId: activeIdProp,
  onActiveChange,
  renderBody,
  activity,
  footer,
  onClose,
  onReorder
}: SessionStackProps): React.JSX.Element {
  const [internalActive, setInternalActive] = useState<string | undefined>(
    activeIdProp ?? sessions[0]?.id
  )
  const activeId = activeIdProp ?? internalActive
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const setActive = (id: string): void => {
    if (onActiveChange) onActiveChange(id)
    else setInternalActive(id)
  }

  const endDrag = (): void => {
    setDragId(null)
    setOverId(null)
  }

  const dropOn = (targetId: string): void => {
    if (!onReorder || !dragId || dragId === targetId) return endDrag()
    const ids = sessions.map((s) => s.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return endDrag()
    ids.splice(from, 1)
    ids.splice(to, 0, dragId)
    onReorder(ids)
    endDrag()
  }

  return (
    <div className="sstack">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        const act = activity?.[s.id]
        return (
          <div
            key={s.id}
            className={`sstack-item ${isActive ? 'sstack-item-active' : ''} ${overId === s.id && dragId !== s.id ? 'sstack-dragover' : ''} ${dragId === s.id ? 'sstack-dragging' : ''}`}
          >
            <div
              className={`sstack-header ${act?.active ? 'sstack-working' : ''}`}
              role="button"
              tabIndex={0}
              draggable={!!onReorder}
              onDragStart={() => setDragId(s.id)}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                setOverId(s.id)
              }}
              onDragEnd={endDrag}
              onDrop={(e) => {
                e.preventDefault()
                dropOn(s.id)
              }}
              onClick={() => !isActive && setActive(s.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !isActive) setActive(s.id)
              }}
            >
              <span className="sstack-caret">{isActive ? '▾' : '▸'}</span>
              <span className="sstack-label">{s.label}</span>
              {!isActive && act?.active && act.status && (
                <span className="sstack-status">{act.status}…</span>
              )}
              {onClose && (
                <button
                  type="button"
                  className="sstack-close"
                  title="fechar sessão"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(s.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
            {/* body fica sempre montado pra preservar estado (PTY/scroll/etc); esconde via CSS */}
            <div className={`sstack-body ${isActive ? '' : 'sstack-body-hidden'}`}>
              {renderBody(s, { isActive })}
            </div>
          </div>
        )
      })}
      {footer}
    </div>
  )
}
