import { useEffect, useMemo, useRef, useState } from 'react'
import ResizableSplit from './components/ResizableSplit'
import Terminal from './components/Terminal'
import Preview from './components/Preview'
import SessionStack, { type Session } from './components/SessionStack'

const HOME = '/Users/danielkanczuk'

const DECK_SESSION_PROMPT =
  'You are running inside the deck IDE — a terminal session paired with an MCP server named "deck" that exposes UI tools (mcp__deck__session_set_title, mcp__deck__preview_show, etc). ' +
  'At the start of any NEW conversation, after understanding the user\'s first message, CALL mcp__deck__session_set_title with 1-3 short words describing the task (e.g. "fixing auth bug", "review PR 42") BEFORE doing other work. ' +
  'It is session bootstrap — do not ask permission. ' +
  'Skip the rename in continued conversations unless the focus shifts noticeably.'

function freshClaudeId(): string {
  return crypto.randomUUID()
}

function defaultClaudeSession(cwd: string): Session {
  return {
    id: `claude-${Date.now().toString(36)}`,
    label: 'claude',
    project: projectFromCwd(cwd),
    cwd,
    kind: 'claude',
    claudeSessionId: freshClaudeId()
  }
}

const SESSIONS_KEY = 'sessions'
const ACTIVE_KEY = 'activeId'
const WORKSPACE_KEY = 'workspace'

function isInWorkspace(cwd: string, workspace: string | null): boolean {
  if (!workspace) return true
  return cwd === workspace || cwd.startsWith(workspace + '/')
}

function expandTilde(p: string): string {
  if (p === '~') return HOME
  if (p.startsWith('~/')) return HOME + p.slice(1)
  return p
}

function projectFromCwd(cwd: string): string {
  if (cwd === HOME) return '~'
  if (cwd.startsWith(HOME + '/')) {
    const tail = cwd.slice(HOME.length + 1)
    return tail.split('/').pop() || '~'
  }
  return cwd.replace(/\/+$/, '').split('/').pop() || cwd
}

function App(): React.JSX.Element {
  const [claudeBin, setClaudeBin] = useState<string | null>(null)
  const [startupCwd, setStartupCwd] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [stateLoaded, setStateLoaded] = useState(false)
  const [titles, setTitles] = useState<Record<string, string>>({})

  const [adding, setAdding] = useState(false)
  const [newKind, setNewKind] = useState<'claude' | 'shell'>('claude')
  const [newCwd, setNewCwd] = useState('')

  // Live state ref for menu callbacks (which are registered once on mount).
  const stateRef = useRef({ sessions, activeId })
  stateRef.current = { sessions, activeId }

  useEffect(() => {
    void window.deck.claude.getBin().then(setClaudeBin)
    void window.deck.app.getStartupCwd().then(setStartupCwd)
    void window.deck.sessions.getTitles().then(setTitles)
    // Load persisted state from main process file store (survives Vite port bumps).
    void Promise.all([
      window.deck.state.get<Session[]>(SESSIONS_KEY),
      window.deck.state.get<string>(ACTIVE_KEY),
      window.deck.state.get<string>(WORKSPACE_KEY)
    ]).then(([sess, active, ws]) => {
      const list = Array.isArray(sess)
        ? sess.map((s) =>
            s.kind === 'claude' && !s.claudeSessionId
              ? { ...s, claudeSessionId: freshClaudeId() }
              : s
          )
        : []
      setSessions(list)
      setWorkspace(ws ?? null)
      const visible = list.filter((s) => isInWorkspace(s.cwd, ws ?? null))
      setActiveId(
        active && visible.some((s) => s.id === active) ? active : visible[0]?.id
      )
      setStateLoaded(true)
    })
    const unsubTitle = window.deck.sessions.onTitleChange(({ id, title }) => {
      setTitles((prev) => ({ ...prev, [id]: title }))
    })
    const unsubAdd = window.deck.sessions.onAdd(({ cwd, kind }) => {
      const id = `${kind}-${Date.now().toString(36)}`
      const session: Session = {
        id,
        label: kind,
        project: projectFromCwd(cwd),
        cwd,
        kind,
        ...(kind === 'claude' ? { claudeSessionId: freshClaudeId() } : {})
      }
      // Open Folder semantics: switch workspace to this cwd. Sessions outside it become hidden.
      setWorkspace(cwd)
      setSessions((prev) => {
        const existing = prev.find((s) => s.cwd === cwd && s.kind === kind)
        if (existing) {
          setActiveId(existing.id)
          return prev
        }
        setActiveId(id)
        return [...prev, session]
      })
    })
    const unsubConflict = window.deck.sessions.onUuidConflict(({ id }) => {
      console.warn(`[deck] claude session ${id} hit a UUID conflict; regenerating`)
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id && s.kind === 'claude'
            ? { ...s, claudeSessionId: freshClaudeId() }
            : s
        )
      )
    })
    const unsubNewSession = window.deck.app.onMenuNewSession(() => {
      setAdding(true)
    })
    const unsubCloseTab = window.deck.app.onMenuCloseTab(() => {
      const { sessions: prev, activeId: cur } = stateRef.current
      if (!cur) return
      const idx = prev.findIndex((s) => s.id === cur)
      if (idx === -1) return
      const next = prev.filter((s) => s.id !== cur)
      const replacement = next[idx] ?? next[idx - 1] ?? next[0]
      setSessions(next)
      setActiveId(replacement?.id)
    })
    return () => {
      unsubTitle()
      unsubAdd()
      unsubConflict()
      unsubNewSession()
      unsubCloseTab()
    }
  }, [])

  const visibleSessions = useMemo(
    () => sessions.filter((s) => isInWorkspace(s.cwd, workspace)),
    [sessions, workspace]
  )

  // Auto-resurrect: only after state has loaded. If no workspace yet, use startupCwd.
  // If workspace exists but has no visible session, create a default in the workspace cwd.
  useEffect(() => {
    if (!stateLoaded) return
    if (!startupCwd) return
    if (!workspace) {
      setWorkspace(startupCwd)
      return
    }
    if (visibleSessions.length > 0) return
    const def = defaultClaudeSession(workspace)
    setSessions((prev) => [...prev, def])
    setActiveId(def.id)
  }, [stateLoaded, workspace, visibleSessions.length, startupCwd])

  // If the active session is hidden by the current workspace filter, switch to a visible one.
  useEffect(() => {
    if (!stateLoaded) return
    if (!activeId) return
    if (visibleSessions.some((s) => s.id === activeId)) return
    setActiveId(visibleSessions[0]?.id)
  }, [stateLoaded, activeId, visibleSessions])

  useEffect(() => {
    if (!stateLoaded) return
    void window.deck.state.set(SESSIONS_KEY, sessions)
  }, [sessions, stateLoaded])

  useEffect(() => {
    if (!stateLoaded) return
    void window.deck.state.set(ACTIVE_KEY, activeId ?? null)
  }, [activeId, stateLoaded])

  useEffect(() => {
    if (!stateLoaded) return
    void window.deck.state.set(WORKSPACE_KEY, workspace)
  }, [workspace, stateLoaded])

  // Reflect the active workspace in the window title.
  useEffect(() => {
    const workspaceName = workspace ? projectFromCwd(workspace) : ''
    document.title = workspaceName ? `${workspaceName} — deck` : 'deck'
  }, [workspace])

  const sessionsWithTitles = useMemo(
    () => visibleSessions.map((s) => (titles[s.id] ? { ...s, label: titles[s.id] } : s)),
    [visibleSessions, titles]
  )

  const handleClose = (id: string): void => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id)
      if (idx === -1) return prev
      const next = prev.filter((s) => s.id !== id)
      if (id === activeId) {
        const replacement = next[idx] ?? next[idx - 1] ?? next[0]
        setActiveId(replacement?.id)
      }
      return next
    })
  }

  const cancelAdd = (): void => {
    setAdding(false)
    setNewCwd('')
    setNewKind('claude')
  }

  const createSession = (): void => {
    const cwd = expandTilde(newCwd.trim() || '~')
    const id = `${newKind}-${Date.now().toString(36)}`
    const project = projectFromCwd(cwd)
    const session: Session = {
      id,
      label: newKind,
      project,
      cwd,
      kind: newKind,
      ...(newKind === 'claude' ? { claudeSessionId: freshClaudeId() } : {})
    }
    setSessions((prev) => [...prev, session])
    setActiveId(id)
    cancelAdd()
  }

  const footer = adding ? (
    <div className="sstack-add-form">
      <div className="sstack-add-kind-row">
        {(['claude', 'shell'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`sstack-add-kind ${newKind === k ? 'active' : ''}`}
            onClick={() => setNewKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <input
        className="sstack-add-input"
        placeholder="path do projeto (default ~)"
        value={newCwd}
        onChange={(e) => setNewCwd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') createSession()
          if (e.key === 'Escape') cancelAdd()
        }}
        spellCheck={false}
        autoFocus
      />
      <div className="sstack-add-actions">
        <button type="button" className="sstack-add-btn primary" onClick={createSession}>
          criar
        </button>
        <button type="button" className="sstack-add-btn" onClick={cancelAdd}>
          cancelar
        </button>
      </div>
    </div>
  ) : (
    <button type="button" className="sstack-add" onClick={() => setAdding(true)}>
      + nova sessão
    </button>
  )

  return (
    <div className="deck">
      <main className="deck-main">
        <ResizableSplit
          defaultSizes={[26, 52, 22]}
          minSizes={[15, 20, 12]}
          storageKey="deck-layout-v0"
        >
          <section className="panel panel-terminal">
            <div className="panel-body panel-body-flush">
              <SessionStack
                sessions={sessionsWithTitles}
                activeId={activeId}
                onActiveChange={setActiveId}
                onClose={handleClose}
                footer={footer}
                renderBody={(s, { isActive }) => {
                  if (s.kind === 'claude' && !claudeBin) {
                    return (
                      <div className="panel-placeholder">
                        <p className="muted">resolvendo claude…</p>
                      </div>
                    )
                  }
                  const cmd =
                    s.kind === 'claude'
                      ? s.claudeSessionId
                        ? [
                            claudeBin!,
                            '--session-id',
                            s.claudeSessionId,
                            '--append-system-prompt',
                            DECK_SESSION_PROMPT
                          ]
                        : [claudeBin!, '--append-system-prompt', DECK_SESSION_PROMPT]
                      : undefined
                  return (
                    <Terminal id={s.id} cwd={s.cwd} command={cmd} visible={isActive} />
                  )
                }}
              />
            </div>
          </section>

          <section className="panel panel-preview">
            <div className="panel-header">
              <span>preview</span>
            </div>
            <div className="panel-body panel-body-flush">
              <Preview />
            </div>
          </section>

          <section className="panel panel-side">
            <div className="panel-header">pendências</div>
            <div className="panel-body panel-placeholder">
              <p>
                parser de <code>pendencias.md</code> em breve.
              </p>
              <p className="muted">próximo PR.</p>
            </div>
          </section>
        </ResizableSplit>
      </main>
    </div>
  )
}

export default App
