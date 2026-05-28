import { useEffect, useMemo, useRef, useState } from 'react'
import ResizableSplit from './components/ResizableSplit'
import Terminal from './components/Terminal'
import Preview from './components/Preview'
import SessionStack, { type Session } from './components/SessionStack'
import type { PreviewSource } from '../../shared/preview'

const HOME = '/Users/danielkanczuk'

const DECK_SESSION_PROMPT = [
  'You are running INSIDE the deck IDE: a 3-panel UI (sessions left, preview center, sidebar right) paired with an MCP server named "deck".',
  '',
  'Available deck tools (PREFER these over generic alternatives whenever the user wants to *see* or *organize* something):',
  '- mcp__deck__session_set_title(title): label this tab. CALL this immediately at the start of any NEW conversation with 1-3 short words (e.g. "fixing auth bug"). Skip in continued conversations unless focus shifts.',
  '- mcp__deck__preview_show(path): render a .md/.json file in the center preview panel. USE THIS — NOT `Read` or `cat` — when the user asks to *show/view/open* a file. Read brings content into your context; preview_show actually displays it to them.',
  '- mcp__deck__preview_markdown(content, title?): render inline markdown content.',
  '- mcp__deck__preview_json(value): render a JSON tree (better than cat-ing JSON to terminal).',
  '- mcp__deck__preview_me(url?): route the center preview to the me browser daemon\'s Live View (embedded iframe). USE THIS — NEVER `open <url>` or `open -a Chrome` — when the user asks to see what `me` (browser automation) is doing or to open a 127.0.0.1:6789/tab/... URL. The deck embeds it; external browser is the wrong path.',
  '- mcp__deck__preview_hide(): clear the preview panel.',
  '',
  'Rule of thumb: if the user said "show" / "mostra" / "abre no preview" / "mostra no painel" — reach for a preview_* tool first. `open`, `Read`, `cat` are fallbacks only when the deck tools are not applicable.'
].join('\n')

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
  const [previews, setPreviews] = useState<Record<string, PreviewSource>>({})

  // Live state ref for menu callbacks (which are registered once on mount).
  const stateRef = useRef({ sessions, activeId, workspace, startupCwd })
  stateRef.current = { sessions, activeId, workspace, startupCwd }

  useEffect(() => {
    void window.deck.claude.getBin().then(setClaudeBin)
    void window.deck.app.getStartupCwd().then(setStartupCwd)
    void window.deck.sessions.getTitles().then(setTitles)
    void window.deck.preview.getAll().then(setPreviews)
    const unsubPreview = window.deck.preview.onSourceChange(({ sessionId, source }) => {
      setPreviews((prev) => ({ ...prev, [sessionId]: source }))
    })
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
      const { workspace: ws, startupCwd: scwd } = stateRef.current
      const cwd = ws || scwd
      if (!cwd) return
      const id = `claude-${Date.now().toString(36)}`
      setSessions((prev) => [
        ...prev,
        {
          id,
          label: 'claude',
          project: projectFromCwd(cwd),
          cwd,
          kind: 'claude',
          claudeSessionId: freshClaudeId()
        }
      ])
      setActiveId(id)
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
      unsubPreview()
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

  const activePreview: PreviewSource = useMemo(() => {
    if (!activeId) return previews.global ?? { type: 'none' }
    return previews[activeId] ?? previews.global ?? { type: 'none' }
  }, [activeId, previews])

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

  const newClaudeSession = (): void => {
    const cwd = workspace || startupCwd
    if (!cwd) return
    const id = `claude-${Date.now().toString(36)}`
    const session: Session = {
      id,
      label: 'claude',
      project: projectFromCwd(cwd),
      cwd,
      kind: 'claude',
      claudeSessionId: freshClaudeId()
    }
    setSessions((prev) => [...prev, session])
    setActiveId(id)
  }

  const footer = (
    <button type="button" className="sstack-add" onClick={newClaudeSession}>
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
          <section className="panel panel-sessions">
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
              <Preview source={activePreview} />
            </div>
          </section>

          <section className="panel panel-sidebar">
            <div className="panel-header">sidebar</div>
            <div className="panel-body panel-placeholder">
              <p>vai abrigar pendências, notes, etc.</p>
              <p className="muted">próximo PR.</p>
            </div>
          </section>
        </ResizableSplit>
      </main>
    </div>
  )
}

export default App
