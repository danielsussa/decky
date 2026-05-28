import { useEffect, useRef, useState } from 'react'
import ResizableSplit from './components/ResizableSplit'
import Terminal from './components/Terminal'
import Preview from './components/Preview'
import DeckGrid from './components/DeckGrid'
import DeckTabs from './components/DeckTabs'
import SessionStack, { type Session } from './components/SessionStack'
import type { PreviewSource } from '../../shared/preview'

// Experimento: alterna o layout do painel central entre 'grid' (gridstack) e 'tabs'.
const DECK_LAYOUT: 'grid' | 'tabs' = 'tabs'

const HOME = '/Users/danielkanczuk'
const LAST_WORKSPACE_KEY = 'lastWorkspace'

const DECK_SESSION_PROMPT = [
  'You are running INSIDE the deck IDE: a 2-panel UI (sessions left, deck-grid center with cards) paired with an MCP server named "deck".',
  '',
  'Available deck tools (PREFER these over plain terminal output whenever the user wants to *see* or *read* something):',
  '- mcp__deck__session_set_title(title): label this tab. CALL this immediately at the start of any NEW conversation with 1-3 short words (e.g. "fixing auth bug"). Skip in continued conversations unless focus shifts.',
  '- mcp__deck__preview_show(path): render a .md/.json file in a deck card. USE THIS — NOT `Read` or `cat` — when the user asks to *show/view/open* a file. Read brings content into your context; preview_show actually displays it to them.',
  '- mcp__deck__preview_markdown(content, title?): render inline markdown content in a deck card.',
  '- mcp__deck__preview_json(value): render a JSON tree in a deck card (better than cat-ing JSON to terminal).',
  '- mcp__deck__preview_me(url?): route a deck card to the me browser daemon\'s Live View (embedded iframe). USE THIS — NEVER `open <url>` or `open -a Chrome` — when the user asks to see what `me` (browser automation) is doing or to open a 127.0.0.1:6789/tab/... URL.',
  '- mcp__deck__preview_hide(): clear the active card.',
  '',
  'IMPORTANT — Cards as the default surface for content:',
  'Whenever your response is STRUCTURED CONTENT the user will want to read or keep visible (lists, tables, markdown, JSON, file contents, examples, summaries, plans), CALL preview_markdown or preview_json — the deck routes it to the user\'s focused card automatically. Then give a short one-line confirmation in the terminal ("listed in card", "shown in preview").',
  'Reserve raw terminal text for: short answers, confirmations, asking the user a question, status updates while you work.',
  '',
  'Examples:',
  '- "create a list of 10 names" → preview_markdown("# Names\\n- Ana\\n- Bruno\\n…") + short "listed in card" confirmation. NOT a one-line CSV in the terminal.',
  '- "show me the pendencies file" → preview_show(path) NOT Read.',
  '- "give me a quick yes/no" → plain terminal answer (no card needed).',
  '',
  'Rule of thumb: if the answer would benefit from being formatted/scrollable/kept visible, it goes in a card. Plain conversation stays in the terminal.'
].join('\n')

interface WorkspaceState {
  sessions: Session[]
  activeId?: string
  cardsBySession?: Record<string, string[]>
  focusedCardBySession?: Record<string, string | null>
  previews?: Record<string, Record<string, PreviewSource>>
  titles?: Record<string, string>
}

function pickTitles(
  sessions: Session[],
  titles: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of sessions) if (titles[s.id]) out[s.id] = titles[s.id]
  return out
}

function freshClaudeId(): string {
  return crypto.randomUUID()
}

function projectFromCwd(cwd: string): string {
  if (cwd === HOME) return '~'
  if (cwd.startsWith(HOME + '/')) {
    const tail = cwd.slice(HOME.length + 1)
    return tail.split('/').pop() || '~'
  }
  return cwd.replace(/\/+$/, '').split('/').pop() || cwd
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

function migrateSessions(list: Session[]): Session[] {
  return list.map((s) =>
    s.kind === 'claude' && !s.claudeSessionId ? { ...s, claudeSessionId: freshClaudeId() } : s
  )
}

function cardTitle(source: PreviewSource | undefined, fallback: string): string {
  if (!source || source.type === 'none') return fallback
  if (source.type === 'me') return 'live view'
  if (source.type === 'json') return 'json'
  if (source.type === 'markdown') {
    if (source.title) return source.title
    // any heading level
    const h = source.content.match(/^#{1,6}\s+(.+)$/m)
    if (h) return h[1].trim()
    // else first non-empty line, stripped of leading markdown punctuation, truncated
    const firstLine = source.content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    if (firstLine) {
      const clean = firstLine.replace(/^[#>*\-`\s]+/, '').trim().slice(0, 40)
      if (clean) return clean
    }
  }
  return fallback
}

// On persist, drop markdown content when we have a path (re-read on load).
function serializePreviews(
  byCard: Record<string, Record<string, PreviewSource>>
): Record<string, Record<string, PreviewSource>> {
  const out: Record<string, Record<string, PreviewSource>> = {}
  for (const [sid, cards] of Object.entries(byCard)) {
    out[sid] = {}
    for (const [cid, src] of Object.entries(cards)) {
      out[sid][cid] =
        src.type === 'markdown' && src.path
          ? { type: 'markdown', content: '', path: src.path, title: src.title }
          : src
    }
  }
  return out
}

function App(): React.JSX.Element {
  const [claudeBin, setClaudeBin] = useState<string | null>(null)
  const [startupCwd, setStartupCwd] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  // Cards are created on-demand by the session's bot (via preview_*); a session starts empty.
  const [cardsBySession, setCardsBySession] = useState<Record<string, string[]>>({})
  const [focusedCardBySession, setFocusedCardBySession] = useState<
    Record<string, string | null>
  >({})
  const [previewsByCard, setPreviewsByCard] = useState<
    Record<string, Record<string, PreviewSource>>
  >({})
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [wsLoaded, setWsLoaded] = useState(false)
  const [lastWorkspaceResolved, setLastWorkspaceResolved] = useState(false)

  const loadedWorkspaceRef = useRef<string | null>(null)
  const stateRef = useRef({ sessions, activeId, workspace, startupCwd, cardsBySession, focusedCardBySession })
  stateRef.current = {
    sessions,
    activeId,
    workspace,
    startupCwd,
    cardsBySession,
    focusedCardBySession
  }

  // Mount: resolve env + subscriptions.
  useEffect(() => {
    void window.deck.claude.getBin().then(setClaudeBin)
    void window.deck.app.getStartupCwd().then(setStartupCwd)
    void window.deck.sessions.getTitles().then(setTitles)
    void window.deck.state.get<string>(LAST_WORKSPACE_KEY).then((ws) => {
      if (ws) setWorkspace(ws)
      setLastWorkspaceResolved(true)
    })

    const unsubPreview = window.deck.preview.onSourceChange(({ sessionId, cardId, source }) => {
      const { cardsBySession: cm, focusedCardBySession: fm, workspace: ws } = stateRef.current
      const existing = cm[sessionId] ?? []
      // Target card: explicit cardId from the bot, else the focused card, else create one.
      let target = cardId || fm[sessionId] || existing[0]
      if (!target || !existing.includes(target)) {
        target = cardId || `card-${Date.now().toString(36)}`
        setCardsBySession((prev) => {
          const list = prev[sessionId] ?? []
          if (list.includes(target!)) return prev
          return { ...prev, [sessionId]: [...list, target!] }
        })
      }
      setFocusedCardBySession((prev) => ({ ...prev, [sessionId]: target! }))

      const apply = (s: PreviewSource): void => {
        setPreviewsByCard((prev) => ({
          ...prev,
          [sessionId]: { ...(prev[sessionId] ?? {}), [target!]: s }
        }))
      }

      // Materialize inline markdown into a real file → editable, versionable, live-watched.
      if (source.type === 'markdown' && !source.path && ws) {
        const safe = target.replace(/[^a-zA-Z0-9._-]/g, '-')
        const filePath = `${ws}/.deck/cards/${safe}.md`
        void window.deck.file.write(filePath, source.content).then((ok) => {
          apply(
            ok
              ? { type: 'markdown', content: source.content, title: source.title, path: filePath }
              : source
          )
        })
      } else {
        apply(source)
      }
    })
    const unsubTitle = window.deck.sessions.onTitleChange(({ id, title }) => {
      setTitles((prev) => ({ ...prev, [id]: title }))
    })
    const unsubAdd = window.deck.sessions.onAdd(({ cwd }) => {
      // Open Folder semantics: just switch workspace — its .deck/ state loads (or resurrects).
      setWorkspace(cwd)
    })
    const unsubConflict = window.deck.sessions.onUuidConflict(({ id }) => {
      // Do NOT regenerate the UUID here — that would start a fresh empty claude and
      // permanently lose the conversation. A conflict on restart is usually a stale lock
      // from the just-killed claude; the session id stays stable so the conversation can
      // resume once the lock clears (reopen the tab if it shows "[process exited]").
      console.warn(`[deck] claude session ${id} reported a UUID conflict (lock not yet released)`)
    })
    const unsubNewSession = window.deck.app.onMenuNewSession(() => {
      const { workspace: ws, startupCwd: scwd } = stateRef.current
      const cwd = ws || scwd
      if (!cwd) return
      const def = defaultClaudeSession(cwd)
      setSessions((prev) => [...prev, def])
      setActiveId(def.id)
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
      unsubPreview()
      unsubTitle()
      unsubAdd()
      unsubConflict()
      unsubNewSession()
      unsubCloseTab()
    }
  }, [])

  // Adopt startup cwd ONLY after we've checked lastWorkspace and it was empty.
  // (Avoids a race where startupCwd loads first and flashes the wrong workspace.)
  useEffect(() => {
    if (!lastWorkspaceResolved) return
    if (workspace) return
    if (!startupCwd) return
    setWorkspace(startupCwd)
  }, [lastWorkspaceResolved, workspace, startupCwd])

  // Load <workspace>/.deck/workspace.json whenever the active workspace changes.
  useEffect(() => {
    if (!workspace) return
    const prevWs = loadedWorkspaceRef.current
    if (prevWs === workspace) return

    // Flush the previous workspace's current state before switching away.
    if (prevWs && wsLoaded) {
      void window.deck.workspace.write(prevWs, {
        sessions,
        activeId,
        cardsBySession,
        focusedCardBySession,
        previews: serializePreviews(previewsByCard),
        titles: pickTitles(sessions, titles)
      })
    }

    let cancelled = false
    setWsLoaded(false)
    void (async () => {
      const data = await window.deck.workspace.read<WorkspaceState>(workspace)
      if (cancelled) return
      if (data && Array.isArray(data.sessions) && data.sessions.length > 0) {
        const sess = migrateSessions(data.sessions)
        const previews = await window.deck.preview.rehydrate(data.previews ?? {})
        if (cancelled) return
        setSessions(sess)
        setActiveId(
          data.activeId && sess.some((s) => s.id === data.activeId)
            ? data.activeId
            : sess[0]?.id
        )
        setCardsBySession(data.cardsBySession ?? {})
        setFocusedCardBySession(data.focusedCardBySession ?? {})
        setPreviewsByCard(previews)
        if (data.titles) setTitles((prev) => ({ ...prev, ...data.titles }))
      } else {
        const def = defaultClaudeSession(workspace)
        setSessions([def])
        setActiveId(def.id)
        setCardsBySession({})
        setFocusedCardBySession({})
        setPreviewsByCard({})
      }
      loadedWorkspaceRef.current = workspace
      void window.deck.state.set(LAST_WORKSPACE_KEY, workspace)
      setWsLoaded(true)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  // Debounced save of the current workspace state.
  useEffect(() => {
    if (!wsLoaded || !workspace || loadedWorkspaceRef.current !== workspace) return
    const t = setTimeout(() => {
      void window.deck.workspace.write(workspace, {
        sessions,
        activeId,
        cardsBySession,
        focusedCardBySession,
        previews: serializePreviews(previewsByCard),
        titles: pickTitles(sessions, titles)
      })
    }, 400)
    return () => clearTimeout(t)
  }, [
    wsLoaded,
    workspace,
    sessions,
    activeId,
    cardsBySession,
    focusedCardBySession,
    previewsByCard,
    titles
  ])

  useEffect(() => {
    const workspaceName = workspace ? projectFromCwd(workspace) : ''
    document.title = workspaceName ? `${workspaceName} — deck` : 'deck'
  }, [workspace])

  // Keep fs watchers in sync with the file-backed cards (markdown sources with a path).
  const watchedPathsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const paths = new Set<string>()
    for (const cards of Object.values(previewsByCard)) {
      for (const src of Object.values(cards)) {
        if (src.type === 'markdown' && src.path) paths.add(src.path)
      }
    }
    const prev = watchedPathsRef.current
    for (const p of paths) if (!prev.has(p)) void window.deck.file.watch(p)
    for (const p of prev) if (!paths.has(p)) void window.deck.file.unwatch(p)
    watchedPathsRef.current = paths
  }, [previewsByCard])

  // Live refresh: when a watched file changes on disk, re-read and update every card on that path.
  useEffect(() => {
    return window.deck.file.onChanged(({ path }) => {
      void window.deck.file.readText(path).then((content) => {
        if (content == null) return
        setPreviewsByCard((prev) => {
          let changed = false
          const next: Record<string, Record<string, PreviewSource>> = {}
          for (const [sid, cards] of Object.entries(prev)) {
            next[sid] = {}
            for (const [cid, src] of Object.entries(cards)) {
              if (src.type === 'markdown' && src.path === path) {
                next[sid][cid] = { ...src, content }
                changed = true
              } else {
                next[sid][cid] = src
              }
            }
          }
          return changed ? next : prev
        })
      })
    })
  }, [])

  const sessionsWithTitles = sessions.map((s) =>
    titles[s.id] ? { ...s, label: titles[s.id] } : s
  )

  const cardPreviews: Record<string, PreviewSource> = activeId
    ? previewsByCard[activeId] ?? {}
    : {}

  const focusedCardId = activeId ? focusedCardBySession[activeId] ?? null : null

  const setFocusedCard = (id: string | null): void => {
    if (!activeId) return
    setFocusedCardBySession((prev) => ({ ...prev, [activeId]: id }))
  }

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
    const def = defaultClaudeSession(cwd)
    setSessions((prev) => [...prev, def])
    setActiveId(def.id)
  }

  const closeCard = (id: string): void => {
    if (!activeId) return
    setCardsBySession((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).filter((c) => c !== id)
    }))
    setPreviewsByCard((prev) => {
      const cards = { ...(prev[activeId] ?? {}) }
      delete cards[id]
      return { ...prev, [activeId]: cards }
    })
  }

  const footer = (
    <button type="button" className="sstack-add" onClick={newClaudeSession}>
      + nova sessão
    </button>
  )

  const activeCardIds = activeId ? cardsBySession[activeId] ?? [] : []
  const deckCards = activeCardIds.map((id, i) => ({
    id,
    title: cardTitle(cardPreviews[id], `card ${i + 1}`),
    render: () => <Preview source={cardPreviews[id] ?? { type: 'none' }} />
  }))

  return (
    <div className="deck">
      <main className="deck-main">
        <ResizableSplit
          defaultSizes={[30, 70]}
          minSizes={[15, 25]}
          storageKey="deck-layout-2col-v0"
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
                  return <Terminal id={s.id} cwd={s.cwd} command={cmd} visible={isActive} />
                }}
              />
            </div>
          </section>

          <section className="panel panel-preview">
            <div className="panel-header">
              <span>deck</span>
            </div>
            <div className="panel-body panel-body-flush">
              {DECK_LAYOUT === 'tabs' ? (
                <DeckTabs
                  focusedId={focusedCardId}
                  onFocusChange={setFocusedCard}
                  onClose={closeCard}
                  cards={deckCards}
                />
              ) : (
                <DeckGrid
                  focusedId={focusedCardId}
                  onFocusChange={setFocusedCard}
                  cards={deckCards}
                />
              )}
            </div>
          </section>
        </ResizableSplit>
      </main>
    </div>
  )
}

export default App
