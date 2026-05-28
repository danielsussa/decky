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
  /** Custom footer (e.g. add-session button or inline form). */
  footer?: ReactNode
  onClose?: (id: string) => void
}

export default function SessionStack({
  sessions,
  activeId: activeIdProp,
  onActiveChange,
  renderBody,
  footer,
  onClose
}: SessionStackProps): React.JSX.Element {
  const [internalActive, setInternalActive] = useState<string | undefined>(
    activeIdProp ?? sessions[0]?.id
  )
  const activeId = activeIdProp ?? internalActive

  const setActive = (id: string): void => {
    if (onActiveChange) onActiveChange(id)
    else setInternalActive(id)
  }

  return (
    <div className="sstack">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        return (
          <div
            key={s.id}
            className={`sstack-item ${isActive ? 'sstack-item-active' : ''}`}
          >
            <div
              className="sstack-header"
              role="button"
              tabIndex={0}
              onClick={() => !isActive && setActive(s.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !isActive) setActive(s.id)
              }}
            >
              <span className="sstack-caret">{isActive ? '▾' : '▸'}</span>
              <span className="sstack-label">{s.label}</span>
              {s.project && <span className="sstack-project">· {s.project}</span>}
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
