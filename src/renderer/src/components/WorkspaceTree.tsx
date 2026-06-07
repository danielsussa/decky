import { ChevronRight, ChevronDown, FolderPlus, Plus, X } from 'lucide-react'
import type { Mode, Theme } from '../../../shared/themes'
import { t } from '../lib/i18n'

export interface TreeSession {
  id: string
  label: string
  kind: 'claude' | 'shell'
}

interface WorkspaceTreeProps {
  isFocused?: boolean
  workspaces: string[]
  activeWorkspace: string | null
  activeSessionId?: string
  // Cmd+Arrow nav cursor parked in another workspace; renders as a "hover" highlight
  // that won't switch workspace until Enter commits.
  previewedSession?: { ws: string; id: string } | null
  expanded: string[]
  sessionsByWorkspace: Record<string, TreeSession[]>
  activity: Record<string, { status: string; active: boolean; done: boolean }>
  mode: Mode
  // Resolves each workspace path to its assigned theme (drives the color-coded chip per row).
  themeFor: (path: string | null | undefined) => Theme
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
  isFocused,
  workspaces,
  activeWorkspace,
  activeSessionId,
  previewedSession,
  expanded,
  sessionsByWorkspace,
  activity,
  mode,
  themeFor,
  nameOf,
  onToggleExpand,
  onSelectSession,
  onNewSession,
  onCloseSession,
  onCloseWorkspace,
  onAddFolder
}: WorkspaceTreeProps): React.JSX.Element {
  // Force-show children of the previewed workspace so the highlighted session is visible,
  // without mutating the user's persistent expanded state.
  const visualExpanded =
    previewedSession && !expanded.includes(previewedSession.ws)
      ? [...expanded, previewedSession.ws]
      : expanded
  return (
    <div
      className="wstree panel-focusable"
      data-panel="tree"
      data-focused={isFocused}
    >
      <div className="wstree-title">workspaces</div>
      {workspaces.map((ws) => {
        const isOpen = visualExpanded.includes(ws)
        const isActiveWs = ws === activeWorkspace
        const isPreviewWs = previewedSession?.ws === ws
        const sessions = sessionsByWorkspace[ws] ?? []
        // Each workspace title carries its OWN hue (from the persisted assignment, same as the
        // surface theme when that workspace is active), so the list reads as a color-coded legend.
        const wsAccent = themeFor(ws)[mode].vars['--accent']
        return (
          <div className="wstree-ws" key={ws}>
            <div
              className={`wstree-row ${isActiveWs ? 'wstree-row-active' : ''} ${isPreviewWs ? 'wstree-row-previewed' : ''}`}
            >
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
                style={{ color: wsAccent }}
                onClick={() => onToggleExpand(ws)}
              >
                {nameOf(ws)}
              </button>
              <button
                type="button"
                className="wstree-x"
                title={t('ws.closeWorkspace')}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseWorkspace(ws)
                }}
              >
                <X size={12} />
              </button>
            </div>
            {isOpen && (
              <div
                className="wstree-children"
                style={{ ['--ws-tint' as string]: wsAccent }}
              >
                {sessions.map((s) => {
                  const isActiveSession = isActiveWs && s.id === activeSessionId
                  const isPreviewedSession =
                    !!previewedSession &&
                    previewedSession.ws === ws &&
                    previewedSession.id === s.id
                  // Show activity for ANY session (the live pool keeps cross-workspace sessions
                  // running), so a session working in another workspace still pulses.
                  const act = activity[s.id]
                  return (
                    <div
                      className={`wstree-session ${isActiveSession ? 'wstree-session-active' : ''} ${isPreviewedSession ? 'wstree-session-previewed' : ''}`}
                      key={s.id}
                    >
                      <button
                        type="button"
                        className="wstree-session-btn"
                        title={s.label}
                        onClick={() => onSelectSession(ws, s.id)}
                      >
                        <span
                          className={`wstree-dot ${act?.active ? 'wstree-dot-on' : ''} ${act?.done ? 'wstree-dot-done' : ''}`}
                        />
                        <span className="wstree-session-name">{s.label}</span>
                      </button>
                      {isActiveWs && (
                        <button
                          type="button"
                          className="wstree-x"
                          title={t('ws.closeSession')}
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
                  <span>{t('ws.newSession')}</span>
                </button>
              </div>
            )}
          </div>
        )
      })}
      <button type="button" className="wstree-add" onClick={onAddFolder}>
        <FolderPlus size={13} />
        <span>{t('ws.addFolder')}</span>
      </button>
    </div>
  )
}
