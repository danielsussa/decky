import {
  ChevronRight,
  ChevronDown,
  FolderPlus,
  Plus,
  X,
  Bookmark,
  Clock,
  Server
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Mode, Theme } from '@decky/shared'
import type { StashEntry } from '@decky/shared'
import { t } from '../lib/i18n'

export interface TreeSession {
  id: string
  label: string
  kind: 'claude' | 'shell'
}

export type CloseSessionMode = 'save' | 'discard'

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
  // # of "own" cards in each session (cards that would be saved by "stash"). 0 = no popover.
  ownCardCount: (sessionId: string) => number
  // Workspace-scoped stash entries for the ACTIVE workspace. Non-active workspaces don't
  // surface their stash in the tree yet — would need a second IPC read.
  stash: StashEntry[]
  onToggleExpand: (ws: string) => void
  onSelectSession: (ws: string, sessionId: string) => void
  onNewSession: (ws: string) => void
  onCloseSession: (ws: string, sessionId: string, mode: CloseSessionMode) => void
  onCloseWorkspace: (ws: string) => void
  onAddFolder: () => void
  onAddServer: () => void
  onRestoreStash: (entryId: string, opts: { revive: boolean; keep: boolean }) => void
  onDiscardStash: (entryId: string) => void
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
  onAddFolder,
  onAddServer,
  ownCardCount,
  stash,
  onRestoreStash,
  onDiscardStash
}: WorkspaceTreeProps): React.JSX.Element {
  // Tracks which session's X is showing its "save vs discard" popover. null = none open.
  const [closeMenuFor, setCloseMenuFor] = useState<string | null>(null)
  // Per-workspace toggle for the stash list — hidden by default; clicking the count chip
  // in the workspace header expands it. Local state because it's pure UI affordance, no
  // need to round-trip through workspace.json.
  const [stashOpenFor, setStashOpenFor] = useState<Record<string, boolean>>({})
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
              {isActiveWs && stash.length > 0 && (
                <button
                  type="button"
                  className="wstree-stash-chip"
                  title={t('ws.stashRestoreHint')}
                  onClick={(e) => {
                    e.stopPropagation()
                    setStashOpenFor((prev) => ({ ...prev, [ws]: !prev[ws] }))
                    // Force the workspace open so the user actually sees the list appear.
                    if (!isOpen) onToggleExpand(ws)
                  }}
                >
                  {stash.length} {stash.length === 1 ? t('ws.stashChipOne') : t('ws.stashChipMany')}
                </button>
              )}
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
                      <button
                        type="button"
                        className="wstree-x"
                        title={t('ws.closeSession')}
                        onClick={(e) => {
                          e.stopPropagation()
                          // Shift-click OR sessions with no own cards bypass the popover —
                          // nothing meaningful to save.
                          if (e.shiftKey || ownCardCount(s.id) === 0) {
                            setCloseMenuFor(null)
                            onCloseSession(ws, s.id, 'discard')
                            return
                          }
                          setCloseMenuFor((cur) => (cur === s.id ? null : s.id))
                        }}
                      >
                        <X size={11} />
                      </button>
                      {closeMenuFor === s.id && (
                        <CloseSessionMenu
                          onSave={() => {
                            setCloseMenuFor(null)
                            onCloseSession(ws, s.id, 'save')
                          }}
                          onDiscard={() => {
                            setCloseMenuFor(null)
                            onCloseSession(ws, s.id, 'discard')
                          }}
                          onDismiss={() => setCloseMenuFor(null)}
                        />
                      )}
                    </div>
                  )
                })}
                {isActiveWs && stash.length > 0 && stashOpenFor[ws] && (
                  <StashSection
                    entries={stash}
                    onRestore={onRestoreStash}
                    onDiscard={onDiscardStash}
                  />
                )}
                <button type="button" className="wstree-new" onClick={() => onNewSession(ws)}>
                  <Plus size={12} />
                  <span>{t('ws.newSession')}</span>
                </button>
              </div>
            )}
          </div>
        )
      })}
      <div className="wstree-add-row">
        <button type="button" className="wstree-add" onClick={onAddFolder}>
          <FolderPlus size={13} />
          <span>{t('ws.addFolder')}</span>
        </button>
        <button type="button" className="wstree-add" onClick={onAddServer}>
          <Server size={13} />
          <span>{t('ws.addServer')}</span>
        </button>
      </div>
    </div>
  )
}

// Inline popover anchored next to the session row. Dismisses on Esc or click outside.
// Enter activates save (primary); Shift+Enter activates discard.
function CloseSessionMenu({
  onSave,
  onDiscard,
  onDismiss
}: {
  onSave: () => void
  onDiscard: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const saveBtnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    saveBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDismiss()
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onDismiss()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onDismiss])
  return (
    <div className="wstree-close-menu" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        ref={saveBtnRef}
        className="wstree-close-menu-save"
        onClick={onSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault()
            onDiscard()
          }
        }}
      >
        <Bookmark size={12} />
        <span>{t('ws.saveForLater')}</span>
      </button>
      <button type="button" className="wstree-close-menu-discard" onClick={onDiscard}>
        <X size={12} />
        <span>{t('ws.closeForReal')}</span>
      </button>
    </div>
  )
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'agora'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

function StashSection({
  entries,
  onRestore,
  onDiscard
}: {
  entries: StashEntry[]
  onRestore: (entryId: string, opts: { revive: boolean; keep: boolean }) => void
  onDiscard: (entryId: string) => void
}): React.JSX.Element {
  return (
    <div className="wstree-stash">
      <div className="wstree-stash-list">
        {entries.map((entry) => (
          <div className="wstree-stash-row" key={entry.id}>
            <button
              type="button"
              className="wstree-stash-btn"
              title={t('ws.stashRestoreHint')}
              onClick={(e) => {
                e.stopPropagation()
                onRestore(entry.id, { revive: !e.shiftKey, keep: e.metaKey || e.ctrlKey })
              }}
            >
              <Clock size={10} className="wstree-stash-icon" />
              <span className="wstree-stash-name">{entry.title}</span>
              <span className="wstree-stash-meta">
                {entry.cards.length} {t('ws.stashCardCount')} · {relativeTime(entry.savedAt)}
              </span>
            </button>
            <button
              type="button"
              className="wstree-x"
              title={t('ws.stashDiscard')}
              onClick={(e) => {
                e.stopPropagation()
                onDiscard(entry.id)
              }}
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
