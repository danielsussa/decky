import Terminal from './Terminal'
import type { Session } from '../types'

interface TerminalHostProps {
  // Sessions of the ACTIVE workspace; their terminals mount here (active visible, rest hidden).
  sessions: Session[]
  activeId?: string
  liveIds: string[]
  claudeBin: string | null
  commandFor: (s: Session) => string[] | undefined
  onUserInput: (id: string) => void
}

// Hosts the live session terminals for the active workspace. Navigation (which session is
// active) lives in WorkspaceTree; this only renders the terminal bodies, keeping inactive-but-
// live ones mounted (hidden) so their pty/scroll state survives tab switches.
export default function TerminalHost({
  sessions,
  activeId,
  liveIds,
  claudeBin,
  commandFor,
  onUserInput
}: TerminalHostProps): React.JSX.Element {
  return (
    <div className="termhost">
      {sessions.map((s) => {
        const isActive = s.id === activeId
        const live = isActive || liveIds.includes(s.id)
        return (
          <div key={s.id} className={`termhost-body ${isActive ? 'termhost-body-active' : ''}`}>
            {s.kind === 'claude' && !claudeBin ? (
              <div className="panel-placeholder">
                <p className="muted">resolvendo claude…</p>
              </div>
            ) : !live ? (
              <div className="panel-placeholder">
                <p className="muted">sessão suspensa — clique pra retomar</p>
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
