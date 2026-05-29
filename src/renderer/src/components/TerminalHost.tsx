import Terminal from './Terminal'
import type { Session } from '../types'

interface TerminalHostProps {
  // The GLOBAL pool of live sessions (across workspaces). Every one mounts a terminal that
  // keeps running; only the active one is visible. Switching workspace doesn't unmount these,
  // so the session you leave isn't stopped.
  sessions: Session[]
  activeId?: string
  claudeBin: string | null
  commandFor: (s: Session) => string[] | undefined
  onUserInput: (id: string) => void
}

export default function TerminalHost({
  sessions,
  activeId,
  claudeBin,
  commandFor,
  onUserInput
}: TerminalHostProps): React.JSX.Element {
  return (
    <div className="termhost">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        return (
          <div key={s.id} className={`termhost-body ${isActive ? 'termhost-body-active' : ''}`}>
            {s.kind === 'claude' && !claudeBin ? (
              <div className="panel-placeholder">
                <p className="muted">resolvendo claude…</p>
              </div>
            ) : (
              <Terminal
                id={s.id}
                cwd={s.cwd}
                command={commandFor(s)}
                visible={isActive}
                onUserInput={() => onUserInput(s.id)}
              />
            )}
          </div>
        )
      })}
      {sessions.length === 0 && (
        <div className="panel-placeholder">
          <p className="muted">nenhuma sessão — abra uma no workspace acima</p>
        </div>
      )}
    </div>
  )
}
