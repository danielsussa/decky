import { useCallback, useEffect, useRef, useState } from 'react'
import ResizableSplit from './components/ResizableSplit'
import Preview from './components/Preview'
import DeckGrid from './components/DeckGrid'
import DeckTabs from './components/DeckTabs'
import WorkspaceTree, { type TreeSession } from './components/WorkspaceTree'
import TerminalHost from './components/TerminalHost'
import type { Session } from './types'
import ShortcutsPanel from './components/ShortcutsPanel'
import CommandPalette, { type Command } from './components/CommandPalette'
import type { PreviewSource } from '../../shared/preview'
import { applyTheme, themeForWorkspace } from '../../shared/themes'
import {
  ACTIONS,
  accelLabel,
  eventToAccel,
  isMac,
  matchesAccel,
  resolveKeymap,
  type ActionId,
  type Keymap
} from '../../shared/keymap'

// Experimento: alterna o layout do painel central entre 'grid' (gridstack) e 'tabs'.
const DECKY_LAYOUT: 'grid' | 'tabs' = 'tabs'

// Browser-tab model: sessions are always LISTED, but only this many keep a live pty
// (claude process). Opening one beyond the cap suspends the least-recently-used; reopening
// resumes it (--resume keeps the conversation). Keeps idle workspaces from spawning N claudes.
const MAX_LIVE_SESSIONS = 6

// System (session-independent) panels that open as center tabs from the command
// palette. Their card ids are prefixed so they never collide with bot cards.
type PanelId = 'shortcuts'
const PANEL_PREFIX = '__panel:'
const PANELS: { id: PanelId; title: string; paletteLabel: string }[] = [
  { id: 'shortcuts', title: 'Atalhos', paletteLabel: 'Atalhos de teclado' }
]

const HOME = '/Users/danielkanczuk'
const LAST_WORKSPACE_KEY = 'lastWorkspace'

const DECKY_SESSION_PROMPT = [
  'You are running INSIDE the decky IDE: a 2-panel UI (sessions left, decky-grid center with cards) paired with an MCP server named "decky".',
  '',
  'Available decky tools (PREFER these over plain terminal output whenever the user wants to *see* or *read* something):',
  '- mcp__decky__session_set_title(title): label this tab. CALL this immediately at the start of any NEW conversation with 1-3 short words (e.g. "fixing auth bug"). Skip in continued conversations unless focus shifts.',
  '- mcp__decky__preview_show(path): render a .md/.json file in a decky card. USE THIS — NOT `Read` or `cat` — when the user asks to *show/view/open* a file. Read brings content into your context; preview_show actually displays it to them.',
  '- mcp__decky__preview_markdown(content, title?): render inline markdown content in a decky card.',
  '- mcp__decky__preview_json(value): render a JSON tree in a decky card (better than cat-ing JSON to terminal).',
  '- mcp__decky__preview_diff(content, title?): render a unified diff (raw `git diff`/`git show`/`diff -u` output) as a STRUCTURED diff card (per-file headers, +/- counts, line-number gutter, green/red lines). ALWAYS use this for code changes — never a ```diff markdown fence. Pass the diff text verbatim.',
  "- mcp__decky__preview_me(url?): route a decky card to the me browser daemon's Live View (embedded iframe). USE THIS — NEVER `open <url>` or `open -a Chrome` — when the user asks to see what `me` (browser automation) is doing or to open a 127.0.0.1:6789/tab/... URL.",
  '- mcp__decky__preview_hide(): clear the active card.',
  '',
  'IMPORTANT — Cards as the default surface for content:',
  'Whenever your response is STRUCTURED CONTENT the user will want to read or keep visible (lists, tables, markdown, JSON, file contents, examples, summaries, plans), CALL preview_markdown or preview_json — decky routes it to the user\'s focused card automatically. Then give a short one-line confirmation in the terminal ("listed in card", "shown in preview").',
  'Reserve raw terminal text for: short answers, confirmations, asking the user a question, status updates while you work.',
  '',
  'Examples:',
  '- "create a list of 10 names" → preview_markdown("# Names\\n- Ana\\n- Bruno\\n…") + short "listed in card" confirmation. NOT a one-line CSV in the terminal.',
  '- "show me the pendencies file" → preview_show(path) NOT Read.',
  '- "what changed?" / showing a git diff → run `git diff`, pass its output to preview_diff(content). NOT a ```diff markdown block.',
  '- "give me a quick yes/no" → plain terminal answer (no card needed).',
  '',
  'Rule of thumb: if the answer would benefit from being formatted/scrollable/kept visible, it goes in a card. Plain conversation stays in the terminal.',
  '',
  'IMPORTANT — Keep an open card in sync after you act:',
  'A card does NOT update from your reasoning — only a file-backed card auto-reloads, and only when its file changes on disk.',
  '- preview_show(path): live-reloads on every save — just keep editing the file, no re-render needed.',
  '- preview_markdown / preview_json: a SNAPSHOT of what you passed. After you change anything it shows (finished a step, revised a list/plan/table, recomputed a value), CALL THE SAME TOOL AGAIN with the updated content. A stale card is worse than none.',
  "- Showing something you'll keep revising (a running plan/checklist/status table)? Write it to a real file and preview_show(path) so your edits auto-refresh it.",
  '',
  "SHARED CARD LIBRARY — the cards you create are real .md files in this project's `.decky/cards/` (the env var `$DECKY_CARDS_DIR` holds the absolute path), SHARED across all sessions of this workspace. A doc one session produced is often useful to another.",
  '- Use SEMANTIC `card` ids so files are findable, and "/" for subfolders: card:"saude/carol-agua", card:"pr/42-resumo". Avoid generic ids.',
  '- BEFORE generating a doc from scratch, check what already exists: Glob `$DECKY_CARDS_DIR/**/*.md` (run `echo "$DECKY_CARDS_DIR"` if you need the literal path), then Read/Grep the relevant ones and build on them instead of duplicating.',
  '- To revise an existing card, reuse the same `card` id (overwrites the file) or just edit the .md directly (the card live-updates via file-watch).',
  '',
  'PINNED CONTEXT — `$DECKY_CARDS_DIR/PINNED.md` lists cards the user pinned. Pinned cards are shown in EVERY session and are meant as shared, always-relevant context. At the start of a task, read PINNED.md and the files it points to.'
].join('\n')

interface WorkspaceState {
  sessions: Session[]
  activeId?: string
  cardsBySession?: Record<string, string[]>
  focusedCardBySession?: Record<string, string | null>
  previews?: Record<string, Record<string, PreviewSource>>
  titles?: Record<string, string>
  pinned?: Record<string, PreviewSource>
}

function pickTitles(sessions: Session[], titles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of sessions) if (titles[s.id]) out[s.id] = titles[s.id]
  return out
}

function freshClaudeId(): string {
  return crypto.randomUUID()
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f]/g

// Classify a chunk of terminal output into a short status the bot is doing.
function deriveStatus(text: string): string | null {
  const clean = text.replace(ANSI_RE, '')
  const tool =
    /[⏺●▶]\s*(Bash|Read|Edit|Write|MultiEdit|Grep|Glob|Task|Update|WebFetch|WebSearch|NotebookEdit)\b/.test(
      clean
    )
  if (tool) return 'running'
  if (/esc to interrupt/i.test(clean)) return 'thinking'
  if (/\p{L}{4,}/u.test(clean)) return 'writing'
  return null
}

// Strong "the bot is actively processing" signals from claude's status line
// ("✢ Composing… (3m 51s · ↓ 12.3k tokens)", "esc to interrupt"). While one of these is seen
// recently, the session is working (purple dot) even if repaints have gaps > the idle window.
function isWorkingSignal(text: string): boolean {
  const clean = text.replace(ANSI_RE, '')
  return /esc to interrupt|[↓↑]\s*[\d.,]+\s*k?\s*tokens|\b\d+m\s*\d+s\b|\(\s*\d+s\b/i.test(clean)
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function projectFromCwd(cwd: string): string {
  if (cwd === HOME) return '~'
  if (cwd.startsWith(HOME + '/')) {
    const tail = cwd.slice(HOME.length + 1)
    return tail.split('/').pop() || '~'
  }
  return cwd.replace(/\/+$/, '').split('/').pop() || cwd
}

// Placeholder session name (animal + gender-neutral adjective, so it reads right with any
// animal) shown until the bot titles the session via session_set_title / aiTitle.
const SESSION_ANIMALS = [
  'lontra',
  'tatu',
  'coruja',
  'raposa',
  'lobo',
  'gato',
  'pardal',
  'onça',
  'jaguar',
  'lince',
  'tucano',
  'golfinho',
  'polvo',
  'texugo',
  'furão',
  'esquilo',
  'castor',
  'lebre',
  'falcão',
  'gavião',
  'garça',
  'sabiá',
  'quati',
  'capivara'
]
const SESSION_ADJS = [
  'veloz',
  'ágil',
  'feroz',
  'audaz',
  'voraz',
  'tenaz',
  'fugaz',
  'sutil',
  'sagaz',
  'vivaz',
  'gentil',
  'hábil',
  'nobre',
  'livre',
  'célere',
  'errante',
  'elegante',
  'brilhante',
  'vigilante',
  'radiante',
  'valente',
  'ardente',
  'prudente',
  'silente'
]
function randomSessionName(): string {
  const a = SESSION_ANIMALS[Math.floor(Math.random() * SESSION_ANIMALS.length)]
  const j = SESSION_ADJS[Math.floor(Math.random() * SESSION_ADJS.length)]
  return `${a}-${j}`
}

function defaultClaudeSession(cwd: string): Session {
  return {
    id: `claude-${Date.now().toString(36)}`,
    label: randomSessionName(),
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
  if (source.type === 'web') {
    if (source.title) return source.title
    try {
      return new URL(source.url).host || 'browser'
    } catch {
      return 'browser'
    }
  }
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
      const clean = firstLine
        .replace(/^[#>*\-`\s]+/, '')
        .trim()
        .slice(0, 40)
      if (clean) return clean
    }
  }
  if (source.type === 'diff') {
    if (source.title) return source.title
    const m = source.content.match(/^diff --git a\/.+? b\/(.+)$/m)
    if (m) {
      const base = m[1].split('/').pop() ?? m[1]
      const count = (source.content.match(/^diff --git /gm) ?? []).length
      return count > 1 ? `diff (${count} arquivos)` : `diff: ${base}`
    }
    return 'diff'
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
  // Registry of folders opened as workspaces (global, ~/.decky/state.json) — drives the switcher.
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  // GLOBAL pool of sessions with a live pty (most-recent at the end), ACROSS workspaces — so
  // switching workspace doesn't kill the one you left. LRU-capped at MAX_LIVE_SESSIONS; each
  // holds its own cwd/claudeSessionId so its terminal keeps running while hidden.
  const [liveSessions, setLiveSessions] = useState<Session[]>([])
  // Which workspaces are expanded in the tree, and a display-only cache of the session
  // lists of NON-active workspaces (read lazily from their workspace.json).
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<string[]>([])
  const [wsSessionsCache, setWsSessionsCache] = useState<Record<string, TreeSession[]>>({})
  // Cards are created on-demand by the session's bot (via preview_*); a session starts empty.
  const [cardsBySession, setCardsBySession] = useState<Record<string, string[]>>({})
  const [focusedCardBySession, setFocusedCardBySession] = useState<Record<string, string | null>>(
    {}
  )
  const [previewsByCard, setPreviewsByCard] = useState<
    Record<string, Record<string, PreviewSource>>
  >({})
  // Pinned cards are workspace-global: shown in every session, source kept here.
  const [pinned, setPinned] = useState<Record<string, PreviewSource>>({})
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [wsLoaded, setWsLoaded] = useState(false)
  const [lastWorkspaceResolved, setLastWorkspaceResolved] = useState(false)
  const [activity, setActivity] = useState<
    Record<string, { status: string; at: number; workingAt: number }>
  >({})
  // When you last "saw" each session (focused it / left it). Activity after this is unseen →
  // drives the green "done while you were away" dot until you return.
  const [seenAt, setSeenAt] = useState<Record<string, number>>({})
  const [aiTitles, setAiTitles] = useState<Record<string, string>>({})
  const [now, setNow] = useState(Date.now())
  // Keyboard bindings: stored overrides (global, ~/.decky/state.json).
  const [keymapOverrides, setKeymapOverrides] = useState<Keymap>({})
  // Command palette (Cmd/Ctrl+P) + which system panels are open as center tabs.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [openPanels, setOpenPanels] = useState<PanelId[]>([])
  // Dev-only rebuild button (packaged macOS app + ~/.decky/dev.json marker). See dev-rebuild.ts.
  const [devInfo, setDevInfo] = useState<{ enabled: boolean; accel: string }>({
    enabled: false,
    accel: ''
  })
  const [rebuildState, setRebuildState] = useState<'idle' | 'running' | 'error'>('idle')
  const [rebuildLog, setRebuildLog] = useState('')
  const rebuildStateRef = useRef(rebuildState)
  rebuildStateRef.current = rebuildState

  const loadedWorkspaceRef = useRef<string | null>(null)
  // When selecting a session (or "nova sessão") in a workspace that isn't active yet, we
  // switch workspace first; these tell the load effect what to do once its sessions land.
  const pendingActiveRef = useRef<string | null>(null)
  const pendingNewRef = useRef(false)
  const userInputAtRef = useRef<Record<string, number>>({})
  const prevActiveIdRef = useRef<string | undefined>(undefined)
  // Latest nav state for the global keyboard shortcuts (Ctrl+Arrows). Assigned
  // each render below; the listener (registered once) reads through this ref.
  const navRef = useRef<{
    // Flat session list across ALL workspaces (tree order), for Cmd+Arrow navigation.
    navSessions: { ws: string; id: string }[]
    activeWorkspace: string | null
    cardIds: string[]
    activeId?: string
    focusedCardId: string | null
  }>({
    navSessions: [],
    activeWorkspace: null,
    cardIds: [],
    activeId: undefined,
    focusedCardId: null
  })
  const keymapRef = useRef<Record<ActionId, string>>(resolveKeymap({}))
  const paletteOpenRef = useRef(false)
  // Set true while ShortcutsPanel records a chord, so the global nav handler
  // stands down and lets the panel's own capture listener grab the keys.
  const captureLockRef = useRef(false)
  const stateRef = useRef({
    sessions,
    activeId,
    workspace,
    startupCwd,
    cardsBySession,
    focusedCardBySession,
    previewsByCard,
    titles,
    pinned,
    wsLoaded
  })
  stateRef.current = {
    sessions,
    activeId,
    workspace,
    startupCwd,
    cardsBySession,
    focusedCardBySession,
    previewsByCard,
    titles,
    pinned,
    wsLoaded
  }

  const doRebuild = useCallback(async () => {
    if (rebuildStateRef.current === 'running') return
    setRebuildLog('')
    setRebuildState('running')
    const res = await window.deck.dev.rebuild()
    // On success the app relaunches, so this component is torn down before we'd update state.
    if (!res.ok) setRebuildState('error')
  }, [])

  // Dev rebuild: resolve availability + stream build output; bind the keyboard shortcut.
  useEffect(() => {
    void window.deck.dev.getInfo().then((info) => setDevInfo({ enabled: info.enabled, accel: info.accel }))
    return window.deck.dev.onOutput((line) => {
      setRebuildLog((prev) => (prev + line).slice(-6000))
    })
  }, [])

  useEffect(() => {
    if (!devInfo.enabled || !devInfo.accel) return
    const onKey = (e: KeyboardEvent): void => {
      if (!matchesAccel(e, devInfo.accel)) return
      e.preventDefault()
      e.stopPropagation()
      void doRebuild()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [devInfo.enabled, devInfo.accel, doRebuild])

  // Mount: resolve env + subscriptions.
  useEffect(() => {
    void window.deck.claude.getBin().then(setClaudeBin)
    void window.deck.app.getStartupCwd().then(setStartupCwd)
    void window.deck.sessions.getTitles().then(setTitles)
    void window.deck.state.get<string[]>('workspaces').then((ws) => {
      if (Array.isArray(ws)) setWorkspaces(ws)
    })
    void window.deck.state.get<string>(LAST_WORKSPACE_KEY).then((ws) => {
      if (ws) setWorkspace(ws)
      setLastWorkspaceResolved(true)
    })

    // Track per-session output activity (in parallel with the terminal) for the
    // border animation + last-line preview. Output that's an echo of recent user
    // typing doesn't count as "bot active" (so typing doesn't trigger the animation).
    const unsubData = window.deck.pty.onData(({ id, data }) => {
      const t = Date.now()
      // ignore output that's just an echo of recent user typing
      if (t - (userInputAtRef.current[id] ?? 0) < 700) return
      // ANY output means the session is doing something — the thinking spinner/timer
      // ("Composing… 2m 43s"), tool output, streamed text. Bump the timestamp on every chunk so
      // it stays "active" (pulsing) and only goes "done" (green) when output TRULY stops; the
      // earlier version only counted deriveStatus-matched chunks, so a long think went stale →
      // false green. Keep the status label when the chunk matches a known pattern.
      const status = deriveStatus(data)
      const working = isWorkingSignal(data)
      setActivity((prev) => {
        const p = prev[id]
        return {
          ...prev,
          [id]: {
            status: status ?? p?.status ?? '',
            at: t,
            workingAt: working ? t : (p?.workingAt ?? 0)
          }
        }
      })
    })

    const unsubPreview = window.deck.preview.onSourceChange(({ sessionId, cardId, source }) => {
      const {
        cardsBySession: cm,
        focusedCardBySession: fm,
        workspace: ws,
        pinned: pin
      } = stateRef.current
      const existing = cm[sessionId] ?? []
      // Target card: explicit cardId from the bot, else the focused card, else create one
      // with a semantic name (slug of the content title) so the file is discoverable.
      let target = cardId || fm[sessionId] || existing[0]
      const targetIsPinned = !!target && !!pin[target]
      if (!target || (!existing.includes(target) && !targetIsPinned)) {
        const slug = cardId ? '' : slugify(cardTitle(source, ''))
        target = cardId || slug || `card-${Date.now().toString(36)}`
        if (existing.includes(target)) target += `-${Date.now().toString(36).slice(-4)}`
        const finalTarget = target
        setCardsBySession((prev) => {
          const list = prev[sessionId] ?? []
          if (list.includes(finalTarget)) return prev
          return { ...prev, [sessionId]: [...list, finalTarget] }
        })
      }
      setFocusedCardBySession((prev) => ({ ...prev, [sessionId]: target! }))

      const apply = (s: PreviewSource): void => {
        if (pin[target!]) {
          setPinned((prev) => ({ ...prev, [target!]: s }))
        } else {
          setPreviewsByCard((prev) => ({
            ...prev,
            [sessionId]: { ...(prev[sessionId] ?? {}), [target!]: s }
          }))
        }
      }

      // Materialize inline markdown into a real file (main owns the path, in <workspace>/.decky) →
      // editable, live-watched, discoverable by other sessions. target may contain "/".
      if (source.type === 'markdown' && !source.path && ws) {
        void window.deck.cards.write(ws, target!, source.content).then((filePath) => {
          apply(
            filePath
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
      // Open Folder semantics: just switch workspace — its state (~/.decky) loads (or resurrects).
      setWorkspace(cwd)
    })
    const unsubConflict = window.deck.sessions.onUuidConflict(({ id }) => {
      // Do NOT regenerate the UUID here — that would start a fresh empty claude and
      // permanently lose the conversation. A conflict on restart is usually a stale lock
      // from the just-killed claude; the session id stays stable so the conversation can
      // resume once the lock clears (reopen the tab if it shows "[process exited]").
      console.warn(`[decky] claude session ${id} reported a UUID conflict (lock not yet released)`)
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
    // The debounced save (400ms) loses the tail on quit — a session created moments before
    // closing never reaches disk. On quit, main blocks the actual exit until we flush the
    // CURRENT state (read from refs, not a stale closure) and ack via flushDone().
    const unsubFlush = window.deck.app.onFlush(() => {
      const s = stateRef.current
      const ws = s.workspace
      if (!ws || !s.wsLoaded || loadedWorkspaceRef.current !== ws) {
        void window.deck.app.flushDone()
        return
      }
      void window.deck.workspace
        .write(ws, {
          sessions: s.sessions,
          activeId: s.activeId,
          cardsBySession: s.cardsBySession,
          focusedCardBySession: s.focusedCardBySession,
          previews: serializePreviews(s.previewsByCard),
          titles: pickTitles(s.sessions, s.titles),
          pinned: serializePreviews({ p: s.pinned }).p
        })
        .finally(() => void window.deck.app.flushDone())
    })
    return () => {
      unsubData()
      unsubPreview()
      unsubTitle()
      unsubAdd()
      unsubConflict()
      unsubNewSession()
      unsubCloseTab()
      unsubFlush()
    }
  }, [])

  // Liveness tick for the collapsed-tab spinner (re-evaluates "active" every 600ms).
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 600)
    return () => clearInterval(iv)
  }, [])

  // Pull claude's auto-generated session title (aiTitle in the .jsonl) as the tab name.
  // Persisted on disk → survives restarts, no dependency on the bot calling a tool.
  useEffect(() => {
    if (!wsLoaded) return
    let cancelled = false
    const fetchTitles = async (): Promise<void> => {
      // Parallel (was sequential → slow to fill with many sessions, showing the random
      // placeholder for a while on launch).
      await Promise.all(
        sessions.map(async (s) => {
          if (s.kind !== 'claude' || !s.claudeSessionId) return
          const t = await window.deck.claude.aiTitle(s.cwd, s.claudeSessionId)
          if (cancelled || !t) return
          setAiTitles((prev) => (prev[s.id] === t ? prev : { ...prev, [s.id]: t }))
        })
      )
    }
    void fetchTitles()
    const iv = setInterval(fetchTitles, 12000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [wsLoaded, sessions])

  // Adopt startup cwd ONLY after we've checked lastWorkspace and it was empty.
  // (Avoids a race where startupCwd loads first and flashes the wrong workspace.)
  useEffect(() => {
    if (!lastWorkspaceResolved) return
    if (workspace) return
    if (!startupCwd) return
    setWorkspace(startupCwd)
  }, [lastWorkspaceResolved, workspace, startupCwd])

  // Load the workspace's persisted state (~/.decky/workspaces/<slug>/workspace.json) on switch.
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
        titles: pickTitles(sessions, titles),
        pinned: serializePreviews({ p: pinned }).p
      })
    }
    // Drop the previous workspace's cached session list so the tree re-reads it fresh next expand.
    if (prevWs) {
      const stale = prevWs
      setWsSessionsCache((c) => {
        if (!(stale in c)) return c
        const n = { ...c }
        delete n[stale]
        return n
      })
    }

    let cancelled = false
    setWsLoaded(false)
    void (async () => {
      const data = await window.deck.workspace.read<WorkspaceState>(workspace)
      if (cancelled) return
      if (data && Array.isArray(data.sessions) && data.sessions.length > 0) {
        let sess = migrateSessions(data.sessions)
        const previews = await window.deck.preview.rehydrate(data.previews ?? {})
        if (cancelled) return
        let initial =
          data.activeId && sess.some((s) => s.id === data.activeId) ? data.activeId : sess[0]?.id
        // Honor a session picked in the tree before this workspace was active.
        if (pendingActiveRef.current && sess.some((s) => s.id === pendingActiveRef.current)) {
          initial = pendingActiveRef.current
        }
        if (pendingNewRef.current) {
          const def = defaultClaudeSession(workspace)
          sess = [...sess, def]
          initial = def.id
        }
        pendingActiveRef.current = null
        pendingNewRef.current = false
        setSessions(sess)
        setActiveId(initial)
        setCardsBySession(data.cardsBySession ?? {})
        setFocusedCardBySession(data.focusedCardBySession ?? {})
        setPreviewsByCard(previews)
        if (data.titles) setTitles((prev) => ({ ...prev, ...data.titles }))
        const pinnedRe = data.pinned
          ? ((await window.deck.preview.rehydrate({ p: data.pinned })).p ?? {})
          : {}
        if (!cancelled) setPinned(pinnedRe)
      } else {
        const def = defaultClaudeSession(workspace)
        pendingActiveRef.current = null
        pendingNewRef.current = false
        setSessions([def])
        setActiveId(def.id)
        setCardsBySession({})
        setFocusedCardBySession({})
        setPreviewsByCard({})
        setPinned({})
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
        titles: pickTitles(sessions, titles),
        pinned: serializePreviews({ p: pinned }).p
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
    titles,
    pinned
  ])

  useEffect(() => {
    const workspaceName = workspace ? projectFromCwd(workspace) : ''
    document.title = workspaceName || 'decky'
  }, [workspace])

  // Each workspace gets a deterministic color identity (hash of its path → 1 of 7 themes), so
  // the whole UI tints differently per workspace. Applied to :root; terminals tint themselves.
  useEffect(() => {
    applyTheme(themeForWorkspace(workspace))
  }, [workspace])

  // Register every opened workspace in the switcher list, and persist the registry.
  useEffect(() => {
    if (!workspace) return
    setWorkspaces((prev) => (prev.includes(workspace) ? prev : [...prev, workspace]))
  }, [workspace])
  useEffect(() => {
    if (workspaces.length) void window.deck.state.set('workspaces', workspaces)
  }, [workspaces])

  // Auto-expand the active workspace so its sessions show in the tree.
  useEffect(() => {
    if (!workspace) return
    setExpandedWorkspaces((e) => (e.includes(workspace) ? e : [...e, workspace]))
  }, [workspace])

  // Read the session lists of ALL non-active workspaces (display-only labels) — also feeds
  // cross-workspace Cmd+Arrow navigation, so it can't be gated on expand state.
  useEffect(() => {
    for (const ws of workspaces) {
      if (ws === workspace) continue // active workspace uses live `sessions`
      void window.deck.workspace.read<WorkspaceState>(ws).then(async (data) => {
        const sess = data?.sessions ?? []
        // Label fallback chain matches the active workspace: session_set_title (persisted
        // `titles`) → claude's aiTitle (read from the .jsonl) → the random placeholder. Without
        // the aiTitle step, sessions without an explicit title showed the random name until you
        // opened them (which made them active and triggered the aiTitle fetch).
        const list: TreeSession[] = await Promise.all(
          sess.map(async (s) => {
            let label = data?.titles?.[s.id]
            if (!label && s.kind === 'claude' && s.claudeSessionId) {
              label = (await window.deck.claude.aiTitle(s.cwd ?? ws, s.claudeSessionId)) ?? undefined
            }
            return { id: s.id, label: label || s.label, kind: s.kind }
          })
        )
        setWsSessionsCache((c) => (c[ws] ? c : { ...c, [ws]: list }))
      })
    }
  }, [workspaces, workspace])

  // Promote the active session to most-recently-used; evict the LRU past the cap.
  useEffect(() => {
    if (!activeId) return
    setLiveSessions((prev) => {
      const sess = sessions.find((s) => s.id === activeId) ?? prev.find((s) => s.id === activeId)
      if (!sess) return prev
      const next = [...prev.filter((s) => s.id !== activeId), sess]
      while (next.length > MAX_LIVE_SESSIONS) next.shift() // drop oldest (never the active, it's last)
      return next
    })
  }, [activeId, sessions])

  // Mark "seen up to now": the session you just left (you saw it until leaving) and the one you
  // opened. Activity AFTER this counts as unseen → the green "done while away" dot.
  useEffect(() => {
    const prev = prevActiveIdRef.current
    prevActiveIdRef.current = activeId
    const t = Date.now()
    setSeenAt((s) => {
      const n = { ...s }
      if (prev) n[prev] = t
      if (activeId) n[activeId] = t
      return n
    })
  }, [activeId])

  // Drop only sessions CLOSED in the workspace `sessions` currently represents; keep other
  // workspaces' sessions alive. Key off loadedWorkspaceRef (the workspace `sessions` actually
  // belongs to) — NOT `workspace`, which updates synchronously on switch while `sessions` lags
  // the async load. Using `workspace` here mis-pruned (and killed) the session you switched
  // back to during that gap. Deps are [sessions] only, so a transient workspace change alone
  // can't trigger a prune.
  useEffect(() => {
    const loadedWs = loadedWorkspaceRef.current
    setLiveSessions((prev) => {
      const activeIds = new Set(sessions.map((s) => s.id))
      const next = prev.filter((s) => s.cwd !== loadedWs || activeIds.has(s.id))
      return next.length === prev.length ? prev : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions])

  // Load global key bindings once on mount.
  useEffect(() => {
    void window.deck.state.get<Keymap>('keymap').then((km) => {
      if (km) setKeymapOverrides(km)
    })
  }, [])

  // Global keyboard handler (capture phase, so it wins over xterm). Cmd/Ctrl+P
  // toggles the command palette (fixed); everything else is matched against the
  // current keymap, read through refs so this stays registered once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const openMod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (openMod && !e.altKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen((v) => !v)
        return
      }
      // Let the palette / a recording shortcut field handle their own keys.
      if (captureLockRef.current || paletteOpenRef.current) return
      // Cmd/Ctrl+N → nova sessão no workspace ativo; Cmd/Ctrl+K → deleta a sessão ativa.
      // Handled here (capture phase, hot-reloadable) rather than via menu accelerators, which
      // the focused xterm/<webview> can swallow and which only refresh on a main-process restart.
      if (openMod && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        e.stopPropagation()
        const { workspace: ws, startupCwd: scwd } = stateRef.current
        const cwd = ws || scwd
        if (cwd) {
          const def = defaultClaudeSession(cwd)
          setSessions((prev) => [...prev, def])
          setActiveId(def.id)
        }
        return
      }
      if (openMod && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        e.stopPropagation()
        const { sessions: prev, activeId: cur } = stateRef.current
        if (!cur) return
        const idx = prev.findIndex((s) => s.id === cur)
        if (idx === -1) return
        const next = prev.filter((s) => s.id !== cur)
        const replacement = next[idx] ?? next[idx - 1] ?? next[0]
        setSessions(next)
        setActiveId(replacement?.id)
        return
      }
      // Typing a plain character while a preview card is focused (e.g. reading a markdown card)
      // snaps focus back to the active terminal and delivers the keystroke to its session.
      const t = e.target as HTMLElement | null
      if (
        t &&
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        t.closest('.panel-preview') &&
        !t.closest('button') &&
        t.tagName !== 'INPUT' &&
        t.tagName !== 'TEXTAREA' &&
        !t.isContentEditable
      ) {
        const aId = stateRef.current.activeId
        const ta = document.querySelector(
          '.termhost-body-active .xterm-helper-textarea'
        ) as HTMLElement | null
        if (aId && ta) {
          ta.focus()
          window.deck.pty.write(aId, e.key)
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }
      const accel = eventToAccel(e)
      if (!accel) return
      const km = keymapRef.current
      const action = (ACTIONS.find((a) => km[a.id] === accel)?.id ?? null) as ActionId | null
      if (!action) return
      e.preventDefault()
      e.stopPropagation()
      const nav = navRef.current
      if (action === 'session.prev' || action === 'session.next') {
        // Navigate the flat cross-workspace list; switch workspace when crossing a boundary.
        const list = nav.navSessions
        if (list.length < 2 || !nav.activeId) return
        const i = list.findIndex((x) => x.id === nav.activeId)
        if (i === -1) return
        const d = action === 'session.prev' ? -1 : 1
        const target = list[(i + d + list.length) % list.length]
        if (target.ws === nav.activeWorkspace) {
          setActiveId(target.id)
        } else {
          pendingActiveRef.current = target.id
          setWorkspace(target.ws)
        }
      } else {
        const ids = nav.cardIds
        if (!ids.length || !nav.activeId) return
        const cur = nav.focusedCardId
        const d = action === 'tab.prev' ? -1 : 1
        const base = cur && ids.includes(cur) ? ids.indexOf(cur) : action === 'tab.prev' ? 0 : -1
        const next = ids[(base + d + ids.length) % ids.length]
        const aId = nav.activeId
        setFocusedCardBySession((prev) => ({ ...prev, [aId]: next }))
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

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

  // Write a manifest of pinned cards so any session's bot can read it as shared context.
  useEffect(() => {
    if (!wsLoaded || !workspace) return
    const lines = [
      '# Pinned cards',
      '',
      'Contexto FIXO compartilhado entre todas as sessions deste workspace. Leia estes antes de agir.',
      ''
    ]
    for (const [id, src] of Object.entries(pinned)) {
      if (src.type === 'markdown' && src.path) lines.push(`- **${id}** — \`${src.path}\``)
      else if (src.type === 'markdown') lines.push(`- **${id}** — (markdown inline)`)
      else if (src.type === 'json') lines.push(`- **${id}** — (json)`)
      else if (src.type === 'diff') lines.push(`- **${id}** — (diff)`)
      else if (src.type === 'web') lines.push(`- **${id}** — (web: ${src.url})`)
      else if (src.type === 'me') lines.push(`- **${id}** — (live view: ${src.url ?? 'me'})`)
    }
    if (Object.keys(pinned).length === 0) lines.push('_(nenhum card fixado)_')
    void window.deck.cards.write(workspace, 'PINNED', lines.join('\n') + '\n')
  }, [pinned, workspace, wsLoaded])

  // Tab name priority: explicit session_set_title > claude's aiTitle > default label.
  const sessionsWithTitles = sessions.map((s) => {
    const label = titles[s.id] || aiTitles[s.id] || s.label
    return label !== s.label ? { ...s, label } : s
  })

  // Dot states: purple/pulsing while WORKING (recent output OR a recent "still processing"
  // signal — the latter tolerates gaps in claude's status repaints so a long "Composing…/
  // Actualizing… 3m51s" doesn't flip to green). Green = finished while you were away: produced
  // output after you last saw it, then went quiet, and you're not viewing it.
  const DONE_IDLE_MS = 3000
  const WORKING_GRACE_MS = 6000
  const sessionActivity: Record<string, { status: string; active: boolean; done: boolean }> = {}
  for (const [id, a] of Object.entries(activity)) {
    const idle = now - a.at
    const working = idle < 1500 || now - a.workingAt < WORKING_GRACE_MS
    const unseen = a.at > (seenAt[id] ?? 0)
    sessionActivity[id] = {
      status: a.status,
      active: working,
      done: !working && unseen && id !== activeId && idle >= DONE_IDLE_MS
    }
  }

  // Sessions shown in the tree: the active workspace from live state, others from the cache.
  // Only use live `sessions` once they belong to the current `workspace`. On switch, `workspace`
  // updates synchronously but `sessions` loads async — using them during that gap flashed the
  // PREVIOUS workspace's session names under the new workspace's row for a frame. Until the load
  // lands (loadedWorkspaceRef catches up), fall back to the cached list for the new workspace.
  const treeSessionsByWorkspace: Record<string, TreeSession[]> = { ...wsSessionsCache }
  if (workspace && loadedWorkspaceRef.current === workspace) {
    treeSessionsByWorkspace[workspace] = sessionsWithTitles.map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind
    }))
  }

  const activeSessionTitle =
    sessionsWithTitles.find((s) => s.id === activeId)?.label ??
    (workspace ? projectFromCwd(workspace) : 'decky')

  // Terminals to mount: the global live pool + the active session if it isn't in it yet
  // (avoids a one-frame gap before the LRU effect adds it). Active is the only visible one.
  const activeSess = sessions.find((s) => s.id === activeId)
  const hostSessions =
    activeSess && !liveSessions.some((s) => s.id === activeId)
      ? [...liveSessions, activeSess]
      : liveSessions

  const cardPreviews: Record<string, PreviewSource> = activeId
    ? (previewsByCard[activeId] ?? {})
    : {}

  const focusedCardId = activeId ? (focusedCardBySession[activeId] ?? null) : null

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

  const addFolder = async (): Promise<void> => {
    const p = await window.deck.app.pickFolder()
    if (p) setWorkspace(p)
  }

  // Open a blank browser card in the active session, focused (URL bar auto-focuses).
  const openWebTab = (): void => {
    if (!activeId) return
    const aId = activeId
    const id = `web-${Date.now().toString(36)}`
    setCardsBySession((p) => ({ ...p, [aId]: [...(p[aId] ?? []), id] }))
    setPreviewsByCard((p) => ({ ...p, [aId]: { ...(p[aId] ?? {}), [id]: { type: 'web', url: '' } } }))
    setFocusedCardBySession((p) => ({ ...p, [aId]: id }))
  }

  const toggleExpand = (ws: string): void =>
    setExpandedWorkspaces((e) => (e.includes(ws) ? e.filter((w) => w !== ws) : [...e, ws]))

  // Selecting a session in a non-active workspace switches first; the load effect then
  // activates the pending session once that workspace's sessions land.
  const selectSession = (ws: string, sid: string): void => {
    if (ws === workspace) {
      setActiveId(sid)
      return
    }
    pendingActiveRef.current = sid
    setWorkspace(ws)
  }

  const newSessionIn = (ws: string): void => {
    if (ws === workspace) {
      newClaudeSession()
      return
    }
    pendingNewRef.current = true
    setWorkspace(ws)
  }

  // Close = remove from the switcher (does NOT delete the on-disk .decky). If it's the active
  // one, fall back to another workspace (or the empty state).
  const closeWorkspace = (ws: string): void => {
    setExpandedWorkspaces((e) => e.filter((w) => w !== ws))
    setWsSessionsCache((c) => {
      if (!(ws in c)) return c
      const n = { ...c }
      delete n[ws]
      return n
    })
    setWorkspaces((prev) => prev.filter((w) => w !== ws))
    if (ws === workspace) {
      const remaining = workspaces.filter((w) => w !== ws)
      if (remaining.length) {
        setWorkspace(remaining[0])
      } else {
        loadedWorkspaceRef.current = null
        setWorkspace(null)
        setSessions([])
        setActiveId(undefined)
      }
    }
  }

  const commandFor = (s: Session): string[] | undefined => {
    if (s.kind !== 'claude') return undefined
    return s.claudeSessionId
      ? [
          claudeBin!,
          '--session-id',
          s.claudeSessionId,
          '--append-system-prompt',
          DECKY_SESSION_PROMPT
        ]
      : [claudeBin!, '--append-system-prompt', DECKY_SESSION_PROMPT]
  }

  const openPanel = (pid: PanelId): void => {
    setOpenPanels((prev) => (prev.includes(pid) ? prev : [...prev, pid]))
    if (activeId)
      setFocusedCardBySession((prev) => ({ ...prev, [activeId]: `${PANEL_PREFIX}${pid}` }))
  }

  const closeCard = (id: string): void => {
    if (id.startsWith(PANEL_PREFIX)) {
      const pid = id.slice(PANEL_PREFIX.length) as PanelId
      setOpenPanels((prev) => prev.filter((p) => p !== pid))
      return
    }
    if (pinned[id]) {
      setPinned((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }
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

  const togglePin = (id: string): void => {
    if (pinned[id]) {
      // unpin → card volta a ser próprio da session ativa
      const src = pinned[id]
      setPinned((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (activeId) {
        setPreviewsByCard((p) => ({ ...p, [activeId]: { ...(p[activeId] ?? {}), [id]: src } }))
        setCardsBySession((c) => {
          const list = c[activeId] ?? []
          return list.includes(id) ? c : { ...c, [activeId]: [...list, id] }
        })
      }
    } else {
      // pin → vira global; tira da session ativa
      const src = activeId ? previewsByCard[activeId]?.[id] : undefined
      if (!src) return
      setPinned((prev) => ({ ...prev, [id]: src }))
      if (activeId) {
        setPreviewsByCard((p) => {
          const cards = { ...(p[activeId] ?? {}) }
          delete cards[id]
          return { ...p, [activeId]: cards }
        })
        setCardsBySession((c) => ({
          ...c,
          [activeId]: (c[activeId] ?? []).filter((x) => x !== id)
        }))
      }
    }
  }

  // Reorder cards from a drag-drop: split the new sequence back into pinned
  // (workspace-global, rebuilt to preserve key order) and the active session's own.
  const reorderCards = (orderedIds: string[]): void => {
    const pinnedOrder = orderedIds.filter((id) => pinned[id])
    const ownOrder = orderedIds.filter((id) => !pinned[id] && !id.startsWith(PANEL_PREFIX))
    if (pinnedOrder.length) {
      setPinned((prev) => {
        const next: Record<string, PreviewSource> = {}
        pinnedOrder.forEach((id) => {
          if (prev[id]) next[id] = prev[id]
        })
        Object.keys(prev).forEach((id) => {
          if (!(id in next)) next[id] = prev[id]
        })
        return next
      })
    }
    if (activeId) setCardsBySession((c) => ({ ...c, [activeId]: ownOrder }))
  }

  const resolvedKeymap = resolveKeymap(keymapOverrides)
  keymapRef.current = resolvedKeymap
  paletteOpenRef.current = paletteOpen

  const persistKeymap = (next: Keymap): void => {
    setKeymapOverrides(next)
    void window.deck.state.set('keymap', next)
  }
  const setBinding = (id: ActionId, accel: string): void =>
    persistKeymap({ ...keymapOverrides, [id]: accel })
  const resetBinding = (id: ActionId): void => {
    const next = { ...keymapOverrides }
    delete next[id]
    persistKeymap(next)
  }

  const renderPanel = (pid: PanelId): React.JSX.Element => {
    // Only 'shortcuts' for now; switch here as more panels are added.
    void pid
    return (
      <ShortcutsPanel
        resolved={resolvedKeymap}
        onSet={setBinding}
        onReset={resetBinding}
        onCapturingChange={(active) => {
          captureLockRef.current = active
        }}
      />
    )
  }

  // System panel tabs (session-independent) first, then pinned (workspace-global),
  // then the active session's own cards.
  const panelCards = openPanels.map((pid) => ({
    id: `${PANEL_PREFIX}${pid}`,
    title: PANELS.find((p) => p.id === pid)?.title ?? pid,
    pinned: false,
    render: () => renderPanel(pid)
  }))
  const pinnedIds = Object.keys(pinned)
  const ownIds = (activeId ? (cardsBySession[activeId] ?? []) : []).filter((id) => !pinned[id])
  const contentCards = [...pinnedIds, ...ownIds].map((id, i) => {
    const isPinned = !!pinned[id]
    const source = isPinned ? pinned[id] : (cardPreviews[id] ?? { type: 'none' })
    return {
      id,
      title: cardTitle(source, isPinned ? 'pinned' : `card ${i + 1}`),
      pinned: isPinned,
      render: () => <Preview source={source} />
    }
  })
  const deckCards = [...panelCards, ...contentCards]

  // Flat session list across all workspaces, in tree order (workspace registry × sessions).
  const navSessions: { ws: string; id: string }[] = []
  for (const ws of workspaces) {
    for (const s of treeSessionsByWorkspace[ws] ?? []) navSessions.push({ ws, id: s.id })
  }

  navRef.current = {
    navSessions,
    activeWorkspace: workspace,
    cardIds: deckCards.map((c) => c.id),
    activeId,
    focusedCardId
  }

  const paletteCommands: Command[] = [
    { id: 'web:new', label: 'Nova aba de browser', hint: 'abre um webview', run: openWebTab },
    ...PANELS.map((p) => ({
      id: `panel:${p.id}`,
      label: p.paletteLabel,
      hint: 'painel',
      run: () => openPanel(p.id)
    }))
  ]

  return (
    <div className="deck">
      <main className="deck-main">
        <ResizableSplit
          defaultSizes={[30, 70]}
          minSizes={[15, 25]}
          storageKey="deck-layout-2col-v0"
        >
          <section className="panel panel-sessions">
            <div className="panel-header">
              <span>{activeSessionTitle}</span>
            </div>
            <div className="panel-body panel-body-flush">
              <TerminalHost
                sessions={hostSessions}
                activeId={activeId}
                claudeBin={claudeBin}
                commandFor={commandFor}
                onUserInput={(id) => {
                  userInputAtRef.current[id] = Date.now()
                }}
              />
            </div>
            <WorkspaceTree
              workspaces={workspaces}
              activeWorkspace={workspace}
              activeSessionId={activeId}
              expanded={expandedWorkspaces}
              sessionsByWorkspace={treeSessionsByWorkspace}
              activity={sessionActivity}
              nameOf={projectFromCwd}
              onToggleExpand={toggleExpand}
              onSelectSession={selectSession}
              onNewSession={newSessionIn}
              onCloseSession={handleClose}
              onCloseWorkspace={closeWorkspace}
              onAddFolder={() => void addFolder()}
            />
          </section>

          <section className="panel panel-preview">
            <div className="panel-header">
              <span>decky</span>
            </div>
            <div className="panel-body panel-body-flush">
              {DECKY_LAYOUT === 'tabs' ? (
                <DeckTabs
                  focusedId={focusedCardId}
                  onFocusChange={setFocusedCard}
                  onClose={closeCard}
                  onTogglePin={togglePin}
                  onReorder={reorderCards}
                  cards={deckCards}
                />
              ) : (
                <DeckGrid
                  focusedId={focusedCardId}
                  onFocusChange={setFocusedCard}
                  onTogglePin={togglePin}
                  cards={deckCards}
                />
              )}
            </div>
          </section>
        </ResizableSplit>
      </main>
      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      )}
      {devInfo.enabled && (
        <div className="dev-rebuild">
          {(rebuildState === 'running' || rebuildState === 'error') && rebuildLog && (
            <pre className="dev-rebuild-log">{rebuildLog}</pre>
          )}
          <button
            className={`dev-rebuild-btn dev-rebuild-${rebuildState}`}
            onClick={() => void doRebuild()}
            disabled={rebuildState === 'running'}
            title={`Rebuild & relaunch (${accelLabel(devInfo.accel)})`}
          >
            {rebuildState === 'running'
              ? 'Rebuilding…'
              : rebuildState === 'error'
                ? 'Rebuild failed — retry'
                : `⟳ Rebuild`}
          </button>
        </div>
      )}
    </div>
  )
}

export default App
