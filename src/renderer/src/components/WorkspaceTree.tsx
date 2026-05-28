import { ChevronRight, ChevronDown, FolderPlus, Plus, X } from 'lucide-react'

export interface TreeSession {
  id: string
  label: string
  kind: 'claude' | 'shell'
}

interface WorkspaceTreeProps {
  workspaces: string[]
  activeWorkspace: string | null
  activeSessionId?: string
  expanded: string[]
  sessionsByWorkspace: Record<string, TreeSession[]>
  activity: Record<string, { status: string; active: boolean }>
  nameOf: (path: string) => string
  onToggleExpand: (ws: string) => void
  onSelectSession: (ws: string, sessionId: string) => void
  onNewSession: (ws: string) => void
  onCloseSession: (sessionId: string) => void
  onCloseWorkspace: (ws: string) => void
  onAddFolder: () => void
}

// The left-panel navigation: a collapsible tree of workspaces, each expanding to its sessions.
// Selecting a session switches workspace if needed; the terminal renders in TerminalHost below.
export default function WorkspaceTree({
  workspaces,
  activeWorkspace,
  activeSessionId,
  expanded,
  sessionsByWorkspace,
  activity,
  nameOf,
  onToggleExpand,
  onSelectSession,
  onNewSession,
  onCloseSession,
  onCloseWorkspace,
  onAddFolder
}: WorkspaceTreeProps): React.JSX.Element {
  return (
    <div className="wstree">
      <div className="wstree-title">workspaces</div>
      {workspaces.map((ws) => {
        const isOpen = expanded.includes(ws)
        const isActiveWs = ws === activeWorkspace
        const sessions = sessionsByWorkspace[ws] ?? []
        return (
          <div className="wstree-ws" key={ws}>
            <div className={`wstree-row ${isActiveWs ? 'wstree-row-active' : ''}`}>
              <button
                type="button"
                className="wstree-caret"
                onClick={() => onToggleExpand(ws)}
                aria-label={isOpen ? 'colapsar' : 'expandir'}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              <button
                type="button"
                className="wstree-name"
                title={ws}
                onClick={() => onToggleExpand(ws)}
              >
                {nameOf(ws)}
              </button>
              <button
                type="button"
                className="wstree-x"
                title="fechar workspace"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseWorkspace(ws)
                }}
              >
                <X size={12} />
              </button>
            </div>
            {isOpen && (
              <div className="wstree-children">
                {sessions.map((s) => {
                  const isActiveSession = isActiveWs && s.id === activeSessionId
                  const act = isActiveWs ? activity[s.id] : undefined
                  return (
                    <div
                      className={`wstree-session ${isActiveSession ? 'wstree-session-active' : ''}`}
                      key={s.id}
                    >
                      <button
                        type="button"
                        className="wstree-session-btn"
                        title={s.label}
                        onClick={() => onSelectSession(ws, s.id)}
                      >
                        <span className={`wstree-dot ${act?.active ? 'wstree-dot-on' : ''}`} />
                        <span className="wstree-session-name">{s.label}</span>
                      </button>
                      {isActiveWs && (
                        <button
                          type="button"
                          className="wstree-x"
                          title="fechar sessão"
                          onClick={(e) => {
                            e.stopPropagation()
                            onCloseSession(s.id)
                          }}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>
                  )
                })}
                <button type="button" className="wstree-new" onClick={() => onNewSession(ws)}>
                  <Plus size={12} />
                  <span>nova sessão</span>
                </button>
              </div>
            )}
          </div>
        )
      })}
      <button type="button" className="wstree-add" onClick={onAddFolder}>
        <FolderPlus size={13} />
        <span>Adicionar pasta…</span>
      </button>
    </div>
  )
}
