import { useCallback, useEffect, useRef, useState } from 'react'
import ResizableSplit from './components/ResizableSplit'
import Preview from './components/Preview'
import DeckGrid, { type DeckCard as DeckCardData } from './components/DeckGrid'
import DeckTabs from './components/DeckTabs'
import WorkspaceTree, { type TreeSession } from './components/WorkspaceTree'
import GitStats from './components/GitStats'
import TerminalHost from './components/TerminalHost'
import type { Session } from './types'
import ShortcutsPanel from './components/ShortcutsPanel'
import CommandPalette, { type Command } from './components/CommandPalette'
import CardSearch from './components/CardSearch'
import PagesPanel, { type WorkspacePage } from './components/PagesPanel'
import FirstRunModal from './components/FirstRunModal'
import { OverlayActiveProvider, SessionVisibleProvider } from './web-visibility'
import type { PreviewSource } from '../../shared/preview'
import { invokeWidget, getWidget, listWidgetTypes, listActiveWidgets } from './lib/widget-registry'
import { t } from './lib/i18n'
import { CLI_SPECS, buildArgs, type CliKind, type DetectedCli } from '../../shared/cli-spec'
import {
  applyTheme,
  assignNewWorkspaceTheme,
  themeFromAssignments,
  THEMES,
  type Mode,
  type Theme
} from '../../shared/themes'
import {
  ACTIONS,
  eventToAccel,
  isMac,
  resolveKeymap,
  type ActionId,
  type Keymap
} from '../../shared/keymap'

// Experimento: alterna o layout do painel central entre 'grid' (gridstack) e 'tabs'.
const DECKY_LAYOUT: 'grid' | 'tabs' = 'tabs'

// Browser-tab model: sessions are always LISTED, but only this many keep a live pty
// (claude process). Opening one beyond the cap suspends the least-recently-used; reopening
// resumes it (--resume keeps the conversation). Keeps idle workspaces from spawning N claudes.
const MAX_LIVE_SESSIONS = 20

// Switching to a session makes its hidden terminal visible → xterm refits (resize) and grabs
// focus, and claude's TUI answers both with a full-screen repaint. That repaint is real pty
// output but NOT the bot working, so we ignore a session's output for this long right after
// switching to it — otherwise opening an IDLE session flashes the working dot for ~1.5s.
const SWITCH_REPAINT_GUARD_MS = 1500

// System (session-independent) panels that open as center tabs from the command
// palette. Their card ids are prefixed so they never collide with bot cards.
type PanelId = 'shortcuts' | 'pages'
const PANEL_PREFIX = '__panel:'
const PANELS: { id: PanelId; title: string; paletteLabel: string }[] = [
  { id: 'shortcuts', title: t('panel.shortcuts'), paletteLabel: t('panel.shortcuts.paletteLabel') },
  { id: 'pages', title: t('panel.pages'), paletteLabel: t('panel.pages.paletteLabel') }
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
  'PINNED CONTEXT — `$DECKY_CARDS_DIR/PINNED.md` lists cards the user pinned. Pinned cards are shown in EVERY session and are meant as shared, always-relevant context. At the start of a task, read PINNED.md and the files it points to.',
  '',
  'CLICKABLE FILE REFS — Cmd/Ctrl+click on a path printed in the terminal opens it as a decky card (same pipeline as preview_show). The renderer detects path tokens by their FILE EXTENSION, so when you mention files to the user write them with the extension intact (e.g. "validacao/relatorio.xlsx", not "relatorio" alone). Relative paths resolve against the session cwd. For paths emitted via a `Bash` tool you control (printing to stdout from a script), you may additionally wrap them in an OSC 8 hyperlink — `printf \'\\033]8;;decky-file:///abs/path\\033\\\\visible-text\\033]8;;\\033\\\\\\n\'` — to render an underlined affordance; not needed for paths cited in your own response text (Cmd+click handles those). Skip the wrapping for paths cited inside cards (markdown links do that) and for paths already passed to a `preview_*` tool.'
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

// Per-workspace state maps (cardsBySession, focusedCardBySession, previewsByCard) are indexed
// by sessionId — globally unique — but persisted PER-WORKSPACE. A session belonging to W_A
// that emits a preview while the user is on W_B would otherwise be (a) saved into W_B's file
// and (b) wiped from memory when W_A reloads. Filter on save (only sessions in this WS) and
// merge on load (keep in-memory entries that disk doesn't know about) closes the leak.
function filterToSessionIds<T>(map: Record<string, T>, ids: Set<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(map)) if (ids.has(k)) out[k] = v
  return out
}

// Merge disk state into in-memory: keep prev (in-memory wins for sessions still active in
// other workspaces, and for THIS workspace's sessions that already have fresher state from a
// cross-workspace event). Fill in entries disk has for this workspace's sessions that prev
// doesn't (cold-load case).
function mergeSessionScopedMap<T>(
  prev: Record<string, T>,
  loaded: Record<string, T>,
  workspaceIds: Set<string>
): Record<string, T> {
  const out = { ...prev }
  for (const [k, v] of Object.entries(loaded)) {
    if (workspaceIds.has(k) && !(k in prev)) out[k] = v
  }
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

// Placeholder session name (animal + adjective) shown until the bot titles the
// session via session_set_title / aiTitle.
const SESSION_ANIMALS = [
  'otter',
  'armadillo',
  'owl',
  'fox',
  'wolf',
  'cat',
  'sparrow',
  'jaguar',
  'leopard',
  'lynx',
  'toucan',
  'dolphin',
  'octopus',
  'badger',
  'ferret',
  'squirrel',
  'beaver',
  'hare',
  'falcon',
  'hawk',
  'heron',
  'robin',
  'raccoon',
  'capybara',
  'panda',
  'tiger',
  'lion',
  'bear',
  'moose',
  'elk',
  'deer',
  'eagle',
  'raven',
  'swan',
  'seal',
  'whale',
  'shark',
  'salmon',
  'crab',
  'mantis',
  'cricket',
  'beetle',
  'mole',
  'weasel',
  'mink',
  'marten',
  'boar',
  'bison',
  'yak',
  'gazelle'
]
const SESSION_ADJS = [
  'swift',
  'agile',
  'fierce',
  'bold',
  'hungry',
  'tenacious',
  'fleeting',
  'subtle',
  'clever',
  'lively',
  'gentle',
  'deft',
  'noble',
  'free',
  'brisk',
  'roaming',
  'elegant',
  'brilliant',
  'vigilant',
  'radiant',
  'valiant',
  'ardent',
  'prudent',
  'silent',
  'nimble',
  'quick',
  'keen',
  'wise',
  'proud',
  'calm',
  'steady',
  'mighty',
  'bright',
  'dashing',
  'daring',
  'cunning',
  'crafty',
  'sly',
  'wild',
  'gallant',
  'stoic',
  'serene',
  'jolly',
  'merry',
  'plucky',
  'dapper',
  'spry',
  'lithe',
  'zealous',
  'eager'
]
function randomSessionName(): string {
  const a = SESSION_ANIMALS[Math.floor(Math.random() * SESSION_ANIMALS.length)]
  const j = SESSION_ADJS[Math.floor(Math.random() * SESSION_ADJS.length)]
  return `${a}-${j}`
}

function defaultCliSession(cwd: string, cliKind: CliKind): Session {
  const spec = CLI_SPECS[cliKind]
  return {
    id: `${cliKind}-${Date.now().toString(36)}`,
    label: randomSessionName(),
    project: projectFromCwd(cwd),
    cwd,
    kind: 'claude',
    cliKind,
    // Only CLIs that support --session-id get a stable id.
    claudeSessionId: spec.supportsResume ? freshClaudeId() : undefined
  }
}

function migrateSessions(list: Session[]): Session[] {
  return list.map((s) => {
    if (s.kind !== 'claude') return s
    // Legacy sessions had no cliKind → they were always claude.
    const cliKind: CliKind = s.cliKind ?? 'claude'
    const needsId = CLI_SPECS[cliKind].supportsResume && !s.claudeSessionId
    if (s.cliKind === cliKind && !needsId) return s
    return {
      ...s,
      cliKind,
      claudeSessionId: needsId ? freshClaudeId() : s.claudeSessionId
    }
  })
}

function sourcePath(source: PreviewSource | undefined): string | undefined {
  if (!source) return undefined
  if (source.type === 'editor' || source.type === 'xlsx') return source.path
  if ((source.type === 'markdown' || source.type === 'diff') && source.path) return source.path
  return undefined
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
  if (source.type === 'editor' || source.type === 'xlsx') {
    if (source.title) return source.title
    return source.path.split('/').pop() ?? source.path
  }
  if (source.type === 'form') return source.spec.title ?? 'form'
  return fallback
}

// On persist, drop markdown content when we have a path (re-read on load).
// Paths inside `workspace` are stored relative to it so cards survive the workspace
// folder being renamed/moved. Paths outside the workspace stay absolute.
function toWorkspaceRelative(path: string, workspace: string | null): string {
  if (!workspace) return path
  const root = workspace.endsWith('/') ? workspace : workspace + '/'
  if (path === workspace) return '.'
  if (path.startsWith(root)) return './' + path.slice(root.length)
  return path
}

function serializePreviews(
  byCard: Record<string, Record<string, PreviewSource>>,
  workspace: string | null
): Record<string, Record<string, PreviewSource>> {
  const out: Record<string, Record<string, PreviewSource>> = {}
  for (const [sid, cards] of Object.entries(byCard)) {
    out[sid] = {}
    for (const [cid, src] of Object.entries(cards)) {
      if (src.type === 'markdown' && src.path) {
        out[sid][cid] = {
          type: 'markdown',
          content: '',
          path: toWorkspaceRelative(src.path, workspace),
          title: src.title
        }
      } else if (src.type === 'editor') {
        out[sid][cid] = {
          type: 'editor',
          content: '',
          path: toWorkspaceRelative(src.path, workspace),
          title: src.title
        }
      } else if (src.type === 'xlsx') {
        out[sid][cid] = {
          type: 'xlsx',
          path: toWorkspaceRelative(src.path, workspace),
          title: src.title
        }
      } else if (src.type === 'form') {
        // Forms are tied to a live MCP await on the agent side. Persisting them across
        // reloads would leave the user with a SEND button that 404s. Drop to 'none'.
        out[sid][cid] = { type: 'none' }
      } else {
        out[sid][cid] = src
      }
    }
  }
  return out
}

function App(): React.JSX.Element {
  // List of AI CLIs found on PATH (claude/codex/cline). null = not yet fetched.
  const [detectedClis, setDetectedClis] = useState<DetectedCli[] | null>(null)
  // The user's chosen default CLI for new sessions. null = legacy state (treat as 'claude').
  const [defaultCli, setDefaultCli] = useState<CliKind | null>(null)
  // Whether to show the first-run banner asking the user to pick a default CLI.
  const [firstRunPending, setFirstRunPending] = useState(false)
  // User-triggered (re)open of the CLI picker after first-run, e.g. from the menu.
  const [cliSettingsOpen, setCliSettingsOpen] = useState(false)
  const [startupCwd, setStartupCwd] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  // Registry of folders opened as workspaces (global, ~/.decky/state.json) — drives the switcher.
  const [workspaces, setWorkspaces] = useState<string[]>([])
  // Persisted workspace→theme assignments. We compute each entry ONCE (greedy: prefer the hashed
  // theme, fall back to the nearest unused hue) when the workspace is registered, then never
  // recompute it — so removing/re-adding doesn't churn the colors of other workspaces.
  const [workspaceThemes, setWorkspaceThemes] = useState<Record<string, string>>({})
  // Gates the ensure-assigned + persist effects until the disk-read of workspaceThemes settles —
  // otherwise an empty-default ensure-assigned could fire & clobber the persisted map before
  // the read resolves.
  const [themesHydrated, setThemesHydrated] = useState(false)
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
  const [gitStats, setGitStats] = useState<{
    isRepo: boolean
    additions: number
    deletions: number
    branch?: string
  } | null>(null)
  const [now, setNow] = useState(Date.now())
  // Light/dark mode: a GLOBAL preference (the per-workspace hue is separate). Toggled from the
  // command palette, persisted in ~/.decky/state.json.
  const [mode, setMode] = useState<Mode>('dark')
  // Keyboard bindings: stored overrides (global, ~/.decky/state.json).
  const [keymapOverrides, setKeymapOverrides] = useState<Keymap>({})
  // Command palette (Cmd/Ctrl+P) + which system panels are open as center tabs.
  const [paletteOpen, setPaletteOpen] = useState(false)
  // "Find in cards" palette (Cmd/Ctrl+Shift+F) — full-text search of the workspace
  // card library at <workspace>/.decky/cards/.
  const [cardSearchOpen, setCardSearchOpen] = useState(false)
  const [openPanels, setOpenPanels] = useState<PanelId[]>([])
  // Which sub-panel (terminal / sessions tree / cards preview) currently holds focus.
  // Drives a thin accent strip on top so the user knows which area their keys land in.
  // Tracked via a global focusin + pointerdown listener (see effect below).
  const [focusedPanel, setFocusedPanel] = useState<'terminal' | 'tree' | 'preview' | null>(null)
  // Dev-only rebuild (packaged macOS app + ~/.decky/dev.json marker). Triggered from the
  // command palette (Cmd/Ctrl+P) or the dev keyboard accel. See dev-rebuild.ts.
  const [devInfo, setDevInfo] = useState<{ enabled: boolean; accel: string }>({
    enabled: false,
    accel: ''
  })
  const [rebuildState, setRebuildState] = useState<'idle' | 'running' | 'ready' | 'error'>('idle')
  const [rebuildLog, setRebuildLog] = useState('')
  const [rebuildElapsedSec, setRebuildElapsedSec] = useState(0)
  const rebuildStateRef = useRef(rebuildState)
  rebuildStateRef.current = rebuildState

  const loadedWorkspaceRef = useRef<string | null>(null)
  // When selecting a session (or "nova sessão") in a workspace that isn't active yet, we
  // switch workspace first; these tell the load effect what to do once its sessions land.
  const pendingActiveRef = useRef<string | null>(null)
  const pendingNewRef = useRef(false)
  const userInputAtRef = useRef<Record<string, number>>({})
  // When each session was last switched-to (made visible). Output within
  // SWITCH_REPAINT_GUARD_MS of this is the switch-induced repaint, not bot activity.
  const switchGuardRef = useRef<Record<string, number>>({})
  const prevActiveIdRef = useRef<string | undefined>(undefined)
  // Cmd+Arrow nav cursor when it crosses a workspace boundary: holds the "hovered"
  // target without actually switching workspace. Enter commits, Esc cancels.
  const [previewedNav, setPreviewedNav] = useState<{ ws: string; id: string } | null>(null)
  // Latest nav state for the global keyboard shortcuts (Ctrl+Arrows). Assigned
  // each render below; the listener (registered once) reads through this ref.
  const navRef = useRef<{
    // Flat session list across ALL workspaces (tree order), for Cmd+Arrow navigation.
    navSessions: { ws: string; id: string }[]
    activeWorkspace: string | null
    cardIds: string[]
    activeId?: string
    focusedCardId: string | null
    previewedNav: { ws: string; id: string } | null
  }>({
    navSessions: [],
    activeWorkspace: null,
    cardIds: [],
    activeId: undefined,
    focusedCardId: null,
    previewedNav: null
  })
  const keymapRef = useRef<Record<ActionId, string>>(resolveKeymap({}))
  // togglePin is defined further down (closes over current state); the global
  // key handler reaches it through this ref, refreshed each render.
  const togglePinRef = useRef<(id: string) => void>(() => {})
  // Per-session "was working last tick" — drives the working→idle edge that fires a desktop
  // notification (see effect below). Resets implicitly when a session goes back to working.
  const wasWorkingRef = useRef<Record<string, boolean>>({})
  // Click handler for the OS notification, refreshed each render so it closes over latest
  // sessions/wsSessionsCache (needed to switch workspace when the session lives elsewhere).
  const focusSessionRef = useRef<(id: string) => void>(() => {})
  const paletteOpenRef = useRef(false)
  const cardSearchOpenRef = useRef(false)
  // Set true while ShortcutsPanel records a chord, so the global nav handler
  // stands down and lets the panel's own capture listener grab the keys.
  const captureLockRef = useRef(false)
  const stateRef = useRef({
    sessions,
    liveSessions,
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
    liveSessions,
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
    // When a previous build is sitting at "Restart", the same affordance fires the relaunch
    // (the build is already swapped on disk — only the live process is stale).
    if (rebuildStateRef.current === 'ready') {
      void window.deck.dev.relaunch()
      return
    }
    if (rebuildStateRef.current === 'running') return
    setRebuildLog('')
    setRebuildElapsedSec(0)
    setRebuildState('running')
    const start = Date.now()
    const res = await window.deck.dev.rebuild()
    // Stamp the precise final duration (the 1s-tick interval would otherwise leave us up to
    // a second short of the real build time on the persistent ready/error label).
    setRebuildElapsedSec(Math.floor((Date.now() - start) / 1000))
    setRebuildState(res.ok ? 'ready' : 'error')
  }, [])

  // Tick a seconds counter while a rebuild is running so the user sees how long it's taking.
  useEffect(() => {
    if (rebuildState !== 'running') return
    const start = Date.now()
    setRebuildElapsedSec(0)
    const id = window.setInterval(() => {
      setRebuildElapsedSec(Math.floor((Date.now() - start) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [rebuildState])

  // Dev rebuild: resolve availability + stream build output; bind the keyboard shortcut.
  useEffect(() => {
    void window.deck.dev
      .getInfo()
      .then((info) => setDevInfo({ enabled: info.enabled, accel: info.accel }))
    return window.deck.dev.onOutput((line) => {
      setRebuildLog((prev) => (prev + line).slice(-6000))
    })
  }, [])

  // View → Rebuild & relaunch (native top menu, dev-only). The native menu owns the Cmd+Shift+B
  // accelerator now — Electron intercepts the key before it reaches webContents, so no renderer
  // keydown listener is needed. See main/menu.ts.
  useEffect(() => window.deck.app.onMenuDevRebuild(() => void doRebuild()), [doRebuild])

  // Mount: resolve env + subscriptions.
  useEffect(() => {
    void window.deck.cli.list().then(setDetectedClis)
    void window.deck.cli.getDefault().then(setDefaultCli)
    void window.deck.cli.isFirstRun().then(setFirstRunPending)
    void window.deck.app.getStartupCwd().then(setStartupCwd)
    void window.deck.sessions.getTitles().then(setTitles)
    void window.deck.state.get<string[]>('workspaces').then((ws) => {
      if (Array.isArray(ws)) setWorkspaces(ws)
    })
    void window.deck.state.get<Record<string, string>>('workspaceThemes').then((m) => {
      if (m && typeof m === 'object') setWorkspaceThemes(m)
      setThemesHydrated(true)
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
      // ignore the full-screen repaint claude emits when this session was just switched to
      // (xterm refit + focus) — otherwise opening an idle session pulses the working dot
      if (t - (switchGuardRef.current[id] ?? 0) < SWITCH_REPAINT_GUARD_MS) return
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

    const unsubPreview = window.deck.preview.onSourceChange(
      ({ sessionId, cardId, source, reqId }) => {
        const {
          cardsBySession: cm,
          focusedCardBySession: fm,
          previewsByCard: pm,
          sessions: aSess,
          liveSessions: lSess,
          pinned: pin
        } = stateRef.current
        const existing = cm[sessionId] ?? []
        // Dedupe by file path: if the bot didn't pass an explicit id and the source is a file
        // already open (pinned or own), route the update to that card so we don't spawn a
        // second tab with the same title (e.g. preview_show on a file that's already pinned).
        let matchByPath: string | undefined
        if (!cardId) {
          const srcPath = sourcePath(source)
          if (srcPath) {
            for (const [id, p] of Object.entries(pin)) {
              if (sourcePath(p) === srcPath) {
                matchByPath = id
                break
              }
            }
            if (!matchByPath) {
              const sessionCards = pm[sessionId] ?? {}
              for (const id of existing) {
                if (sourcePath(sessionCards[id]) === srcPath) {
                  matchByPath = id
                  break
                }
              }
            }
          }
        }
        // Target card: explicit cardId from the bot, else a card already showing this path,
        // else the focused card, else create one with a semantic name (slug of the content
        // title) so the file is discoverable.
        let target = cardId || matchByPath || fm[sessionId] || existing[0]
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
        if (noFocusIdsRef.current.has(target)) {
          noFocusIdsRef.current.delete(target)
        } else {
          setFocusedCardBySession((prev) => ({ ...prev, [sessionId]: target! }))
        }

        // Ack back to main so the HTTP /preview response can echo cardId+path to the MCP
        // caller. Inline markdown waits for the file write to know the real path; other types
        // ack immediately with whatever path the source already carries (none for json/web/me).
        const ack = (path?: string): void => {
          if (!reqId) return
          window.deck.preview.resolved({
            reqId,
            cardId: target!,
            path,
            title: cardTitle(source, '')
          })
        }

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
        // Use the EMITTING session's workspace, not the active one — a session in the live pool
        // can be from a different workspace than the user is currently viewing, and the card file
        // belongs with its owner session.
        const owner = aSess.find((s) => s.id === sessionId) ?? lSess.find((s) => s.id === sessionId)
        const ownerWs = owner?.cwd
        if (source.type === 'markdown' && !source.path && ownerWs) {
          void window.deck.cards.write(ownerWs, target!, source.content).then((filePath) => {
            apply(
              filePath
                ? { type: 'markdown', content: source.content, title: source.title, path: filePath }
                : source
            )
            ack(filePath ?? undefined)
          })
        } else {
          apply(source)
          ack(sourcePath(source))
        }
      }
    )
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
      const def = defaultCliSession(cwd, defaultCli ?? 'claude')
      setSessions((prev) => [...prev, def])
      setActiveId(def.id)
    })
    // A popup/new-tab opened from inside a web card's <webview> would otherwise spawn a
    // separate OS window. WebPreview blocks the native popup (no allowpopups) and re-fires the
    // URL as a 'decky:web-open' DOM event; we open it as a new web card in the active session.
    const onWebOpen = (ev: Event): void => {
      const url = (ev as CustomEvent<string>).detail
      const aId = stateRef.current.activeId
      if (!aId || !url) return
      const id = `web-${Date.now().toString(36)}`
      setCardsBySession((p) => ({ ...p, [aId]: [...(p[aId] ?? []), id] }))
      setPreviewsByCard((p) => ({
        ...p,
        [aId]: { ...(p[aId] ?? {}), [id]: { type: 'web', url } }
      }))
      setFocusedCardBySession((p) => ({ ...p, [aId]: id }))
    }
    window.addEventListener('decky:web-open', onWebOpen)
    // Cmd+click on a file ref in the terminal (or OSC 8 link with decky-file:// scheme) fires
    // here. Routing is "open in new tab unless already open": if any card (own or pinned)
    // already shows this path, focus it; otherwise POST a wire source with a fresh card id so
    // a NEW tab is created (without it, the preview-server's broadcast handler would route to
    // whichever card is focused and overwrite it — fine for `preview_show`, bad for a click).
    const onOpenPath = (ev: Event): void => {
      const detail = (
        ev as CustomEvent<{ path: string; cwd?: string; sessionId: string; focus?: boolean }>
      ).detail
      if (!detail?.path || !detail.sessionId) return
      let abs = detail.path
      if (!abs.startsWith('/') && detail.cwd) abs = detail.cwd.replace(/\/+$/, '') + '/' + abs
      const state = stateRef.current
      const sessionCards = state.previewsByCard[detail.sessionId] ?? {}
      const existing = state.cardsBySession[detail.sessionId] ?? []
      let match: string | undefined
      for (const id of existing) {
        if (sourcePath(sessionCards[id]) === abs) {
          match = id
          break
        }
      }
      if (!match) {
        for (const [id, p] of Object.entries(state.pinned)) {
          if (sourcePath(p) === abs) {
            match = id
            break
          }
        }
      }
      if (match) {
        if (detail.focus !== false) {
          setFocusedCardBySession((p) => ({ ...p, [detail.sessionId]: match! }))
        }
        return
      }
      const ext = abs.split('.').pop()?.toLowerCase() ?? ''
      let wire: { type: string; path: string }
      if (ext === 'md' || ext === 'markdown') wire = { type: 'markdown', path: abs }
      else if (ext === 'diff' || ext === 'patch') wire = { type: 'diff', path: abs }
      else if (ext === 'xlsx') wire = { type: 'xlsx', path: abs }
      else wire = { type: 'editor', path: abs }
      const newCardId = `file-${Date.now().toString(36)}`
      if (detail.focus === false) noFocusIdsRef.current.add(newCardId)
      void fetch('http://127.0.0.1:6790/preview', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-deck-session-id': detail.sessionId,
          'x-deck-card-id': newCardId
        },
        body: JSON.stringify(wire)
      }).catch((err) => console.warn('[decky:open-path] preview POST failed', err))
    }
    window.addEventListener('decky:open-path', onOpenPath)
    // Focus the card that currently shows a given path (own session or pinned). Used by
    // the "expand subject" flow once the agent has filled the placeholder file.
    const onFocusPath = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ path: string; sessionId: string }>).detail
      if (!detail?.path || !detail.sessionId) return
      const state = stateRef.current
      const sessionCards = state.previewsByCard[detail.sessionId] ?? {}
      const existing = state.cardsBySession[detail.sessionId] ?? []
      let match: string | undefined
      for (const id of existing) {
        if (sourcePath(sessionCards[id]) === detail.path) {
          match = id
          break
        }
      }
      if (!match) {
        for (const [id, p] of Object.entries(state.pinned)) {
          if (sourcePath(p) === detail.path) {
            match = id
            break
          }
        }
      }
      if (match) {
        setFocusedCardBySession((p) => ({ ...p, [detail.sessionId]: match! }))
      }
    }
    window.addEventListener('decky:focus-path', onFocusPath)
    // Main forwards any link / window.open from the renderer here (markdown card links,
    // terminal weblinks, etc.) — re-fire on the same channel a web-card popup uses.
    const unsubOpenUrl = window.deck.app.onOpenUrl((url) => {
      window.dispatchEvent(new CustomEvent('decky:web-open', { detail: url }))
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
    const unsubCliSettings = window.deck.app.onMenuOpenCliSettings(() => {
      // Make sure the latest detection is in the modal even if PATH changed since boot.
      void window.deck.cli.recheck().then(setDetectedClis)
      setCliSettingsOpen(true)
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
      const ids = new Set(s.sessions.map((x) => x.id))
      void window.deck.workspace
        .write(ws, {
          sessions: s.sessions,
          activeId: s.activeId,
          cardsBySession: filterToSessionIds(s.cardsBySession, ids),
          focusedCardBySession: filterToSessionIds(s.focusedCardBySession, ids),
          previews: serializePreviews(filterToSessionIds(s.previewsByCard, ids), ws),
          titles: pickTitles(s.sessions, s.titles),
          pinned: serializePreviews({ p: s.pinned }, ws).p
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
      window.removeEventListener('decky:web-open', onWebOpen)
      window.removeEventListener('decky:open-path', onOpenPath)
      window.removeEventListener('decky:focus-path', onFocusPath)
      unsubOpenUrl()
      unsubCloseTab()
      unsubCliSettings()
      unsubFlush()
    }
  }, [])

  // Liveness tick for the collapsed-tab spinner (re-evaluates "active" every 600ms).
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 600)
    return () => clearInterval(iv)
  }, [])

  // Track which sub-panel (terminal / tree / preview) the user is currently in. focusin handles
  // keyboard focus moves; pointerdown (capture) handles clicks that don't shift DOM focus (e.g.
  // clicking a card body that isn't a focusable element). Walks up to the nearest [data-panel]
  // ancestor — anything inside the three marked regions counts.
  useEffect(() => {
    const update = (e: Event): void => {
      const t = e.target as Element | null
      const el = t?.closest?.('[data-panel]') as HTMLElement | null
      const id = el?.dataset.panel as 'terminal' | 'tree' | 'preview' | undefined
      if (id) setFocusedPanel(id)
    }
    document.addEventListener('focusin', update)
    document.addEventListener('pointerdown', update, true)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('pointerdown', update, true)
    }
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
      const prevIds = new Set(sessions.map((s) => s.id))
      void window.deck.workspace.write(prevWs, {
        sessions,
        activeId,
        cardsBySession: filterToSessionIds(cardsBySession, prevIds),
        focusedCardBySession: filterToSessionIds(focusedCardBySession, prevIds),
        previews: serializePreviews(filterToSessionIds(previewsByCard, prevIds), prevWs),
        titles: pickTitles(sessions, titles),
        pinned: serializePreviews({ p: pinned }, prevWs).p
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
        const previews = await window.deck.preview.rehydrate(data.previews ?? {}, workspace)
        if (cancelled) return
        let initial =
          data.activeId && sess.some((s) => s.id === data.activeId) ? data.activeId : sess[0]?.id
        // Honor a session picked in the tree before this workspace was active.
        if (pendingActiveRef.current && sess.some((s) => s.id === pendingActiveRef.current)) {
          initial = pendingActiveRef.current
        }
        if (pendingNewRef.current) {
          const def = defaultCliSession(workspace, defaultCli ?? 'claude')
          sess = [...sess, def]
          initial = def.id
        }
        pendingActiveRef.current = null
        pendingNewRef.current = false
        // Mark the loaded workspace BEFORE setSessions: the prune effect keys off this ref to
        // know which workspace `sessions` represents. If we update it later, the `await
        // rehydrate({p: pinned})` below splits the microtask — React processes the setSessions
        // batch before the ref catches up, so prune sees the new WS's sessions but the old WS's
        // ref and drops every live session of the workspace we're switching AWAY from, killing
        // those ptys mid-task. `data.pinned` is `{}` (truthy) even when empty, so this fired on
        // every switch.
        loadedWorkspaceRef.current = workspace
        setSessions(sess)
        setActiveId(initial)
        // Merge (not replace): keep in-memory entries for sessions belonging to other
        // workspaces (live pool), AND for THIS workspace's sessions that have fresher state
        // from a cross-workspace preview event the disk doesn't know about.
        const wsIds = new Set(sess.map((s) => s.id))
        setCardsBySession((prev) => mergeSessionScopedMap(prev, data.cardsBySession ?? {}, wsIds))
        setFocusedCardBySession((prev) =>
          mergeSessionScopedMap(prev, data.focusedCardBySession ?? {}, wsIds)
        )
        setPreviewsByCard((prev) => mergeSessionScopedMap(prev, previews, wsIds))
        if (data.titles) setTitles((prev) => ({ ...prev, ...data.titles }))
        const pinnedRe = data.pinned
          ? ((await window.deck.preview.rehydrate({ p: data.pinned }, workspace)).p ?? {})
          : {}
        if (!cancelled) setPinned(pinnedRe)
      } else {
        const def = defaultCliSession(workspace, defaultCli ?? 'claude')
        pendingActiveRef.current = null
        pendingNewRef.current = false
        loadedWorkspaceRef.current = workspace
        setSessions([def])
        setActiveId(def.id)
        // Don't clobber other workspaces' in-memory entries; this WS has only a fresh session
        // with no cards yet, so the merge just leaves the rest of the maps alone.
        const wsIds = new Set([def.id])
        setCardsBySession((prev) => mergeSessionScopedMap(prev, {}, wsIds))
        setFocusedCardBySession((prev) => mergeSessionScopedMap(prev, {}, wsIds))
        setPreviewsByCard((prev) => mergeSessionScopedMap(prev, {}, wsIds))
        setPinned({})
      }
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
      const ids = new Set(sessions.map((s) => s.id))
      void window.deck.workspace.write(workspace, {
        sessions,
        activeId,
        cardsBySession: filterToSessionIds(cardsBySession, ids),
        focusedCardBySession: filterToSessionIds(focusedCardBySession, ids),
        previews: serializePreviews(filterToSessionIds(previewsByCard, ids), workspace),
        titles: pickTitles(sessions, titles),
        pinned: serializePreviews({ p: pinned }, workspace).p
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

  // Poll the workspace's uncommitted diff (additions/deletions) so the right header can show
  // a tiny git stats badge. Skipped when there's no workspace or it isn't a git repo.
  useEffect(() => {
    if (!workspace) {
      setGitStats(null)
      return
    }
    let cancelled = false
    const fetchStats = async (): Promise<void> => {
      const s = await window.deck.git.diffStats(workspace)
      if (cancelled) return
      setGitStats(s.isRepo ? s : null)
    }
    void fetchStats()
    const iv = setInterval(fetchStats, 3000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [workspace])

  // Debounced push of the canonical per-session card mirror to main. The MCP `list_cards`
  // tool reads this so the bot can discover what cards the user has open (id/path/title/type),
  // and `preview_*` callers get cardId+path resolution on every write. Debounce > React
  // multi-set batching to avoid mid-batch snapshots.
  useEffect(() => {
    const t = setTimeout(() => {
      const ownIds = (sid: string): string[] => cardsBySession[sid] ?? []
      const pinnedIds = Object.keys(pinned)
      const out: Record<
        string,
        {
          cards: {
            id: string
            title: string
            type: PreviewSource['type']
            path?: string
            url?: string
            pinned: boolean
          }[]
          focused: string | null
          cwd?: string
        }
      > = {}
      const allSessionIds = new Set<string>([
        ...sessions.map((s) => s.id),
        ...Object.keys(cardsBySession),
        ...Object.keys(focusedCardBySession),
        ...Object.keys(previewsByCard)
      ])
      // Session.cwd is the workspace path — used by the MCP `search_cards` tool to
      // resolve <workspace>/.decky/cards/. Look up in both the active workspace's
      // sessions and the global live pool (cross-workspace).
      const cwdFor = (sid: string): string | undefined =>
        sessions.find((s) => s.id === sid)?.cwd ?? liveSessions.find((s) => s.id === sid)?.cwd
      for (const sid of allSessionIds) {
        const own = ownIds(sid).filter((id) => !pinned[id])
        const ids = [...pinnedIds, ...own]
        const cards = ids.map((id, i) => {
          const isPinned = !!pinned[id]
          const source: PreviewSource = (isPinned ? pinned[id] : previewsByCard[sid]?.[id]) ?? {
            type: 'none'
          }
          const t = source.type
          const path = sourcePath(source)
          const url = t === 'me' || t === 'web' ? source.url : undefined
          return {
            id,
            title: cardTitle(source, isPinned ? 'pinned' : `card ${i + 1}`),
            type: t,
            path,
            url,
            pinned: isPinned
          }
        })
        out[sid] = { cards, focused: focusedCardBySession[sid] ?? null, cwd: cwdFor(sid) }
      }
      window.deck.cards.syncState(out)
    }, 80)
    return () => clearTimeout(t)
  }, [sessions, liveSessions, cardsBySession, focusedCardBySession, previewsByCard, pinned])

  // Drop a stale Cmd+Arrow preview the moment the active workspace actually changes —
  // Enter commits via setWorkspace, but other paths (mouse, close, palette) get here too.
  useEffect(() => {
    setPreviewedNav(null)
  }, [workspace])

  // Load the persisted mode once on mount.
  useEffect(() => {
    void window.deck.state.get<Mode>('themeMode').then((m) => {
      if (m === 'light' || m === 'dark') setMode(m)
    })
  }, [])

  const toggleMode = useCallback((): void => {
    setMode((prev) => {
      const next: Mode = prev === 'dark' ? 'light' : 'dark'
      void window.deck.state.set('themeMode', next)
      return next
    })
  }, [])

  // Register every opened workspace in the switcher list, and persist the registry.
  useEffect(() => {
    if (!workspace) return
    setWorkspaces((prev) => (prev.includes(workspace) ? prev : [...prev, workspace]))
  }, [workspace])
  useEffect(() => {
    if (workspaces.length) void window.deck.state.set('workspaces', workspaces)
  }, [workspaces])

  // Whenever the workspace registry changes, ensure every entry has a theme assignment. We only
  // assign workspaces that don't already have one (greedy: prefer the hashed theme, else the
  // closest unused hue). Existing assignments are NEVER recomputed — so a workspace's color
  // identity is fixed at registration time and survives adds/removes of siblings.
  // Gate on themesHydrated so we don't compute fresh assignments over an empty default and clobber
  // the persisted map before its disk-read resolves.
  useEffect(() => {
    if (!themesHydrated) return
    setWorkspaceThemes((prev) => {
      const next: Record<string, string> = {}
      const validIds = new Set(THEMES.map((t) => t.id))
      // Drop assignments pointing at theme IDs that no longer exist (e.g. after the
      // 15-theme → 5-theme migration); those workspaces fall back to the missing pool
      // and get reassigned in alphabetical order via the round-robin assigner below.
      for (const ws of workspaces) {
        const id = prev[ws]
        if (id && validIds.has(id)) next[ws] = id
      }
      const taken = new Set(Object.values(next))
      const missing = workspaces
        .filter((ws) => !next[ws])
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      for (const ws of missing) {
        const t = assignNewWorkspaceTheme(ws, taken)
        next[ws] = t.id
        taken.add(t.id)
      }
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      const same = prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k])
      return same ? prev : next
    })
  }, [workspaces, themesHydrated])
  useEffect(() => {
    if (!themesHydrated) return
    void window.deck.state.set('workspaceThemes', workspaceThemes)
  }, [workspaceThemes, themesHydrated])

  // Resolve any path (active workspace OR a session's cwd) to its theme. Pure lookup against the
  // persisted assignment table; falls back to the hash when no assignment exists (e.g. a cwd
  // that isn't a registered workspace, or during the brief pre-load window on startup).
  const themeFor = useCallback(
    (path: string | null | undefined): Theme => themeFromAssignments(path, workspaceThemes),
    [workspaceThemes]
  )

  // Mirror the global mode into main so embedded web cards (WebContentsView) get the matching
  // prefers-color-scheme. nativeTheme is per-process; the renderer is the source of truth.
  useEffect(() => {
    void window.deck.theme.setMode(mode)
  }, [mode])

  // Each workspace gets a color identity from the persisted assignment (1 of 15 themes, greedy
  // collision-avoidance at registration); the mode (dark/light) is a global toggle. Both reapply
  // to :root; terminals tint themselves.
  useEffect(() => {
    applyTheme(themeFor(workspace), mode)
  }, [workspace, mode, themeFor])

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
              label =
                (await window.deck.claude.aiTitle(s.cwd ?? ws, s.claudeSessionId)) ?? undefined
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
    // Arm the repaint guard for BOTH sides of the switch: the session we just opened (terminal
    // becomes visible → xterm refits + focus → claude repaints) AND the one we just left
    // (terminal becomes hidden → refit/blur also triggers a repaint). Without the `prev` side,
    // leaving an idle session would flash the working dot for ~1.5s before settling back to green.
    if (activeId) switchGuardRef.current[activeId] = t
    if (prev) switchGuardRef.current[prev] = t
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
      // Cmd/Ctrl+Shift+F → "find in cards" palette (full-text search of the workspace
      // card library). KeyboardEvent.key is 'F' with shift held, but allow 'f' too as
      // a safety net for layouts that don't uppercase.
      if (openMod && e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        e.stopPropagation()
        setCardSearchOpen((v) => !v)
        return
      }
      // Let the palette / find-in-cards / a recording shortcut field handle their own keys.
      if (captureLockRef.current || paletteOpenRef.current || cardSearchOpenRef.current) return
      // While a Cmd+Arrow preview cursor is parked in another workspace, Cmd/Ctrl+Enter
      // commits the switch and Escape cancels — plain Enter is left for the terminal.
      const preview = navRef.current.previewedNav
      if (preview) {
        if (openMod && !e.altKey && !e.shiftKey && e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          setPreviewedNav(null)
          if (preview.ws === navRef.current.activeWorkspace) {
            setActiveId(preview.id)
          } else {
            pendingActiveRef.current = preview.id
            setWorkspace(preview.ws)
          }
          return
        }
        if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setPreviewedNav(null)
          return
        }
      }
      // Cmd/Ctrl+N → nova sessão no workspace ativo; Cmd/Ctrl+K → deleta a sessão ativa.
      // Handled here (capture phase, hot-reloadable) rather than via menu accelerators, which
      // the focused xterm/<webview> can swallow and which only refresh on a main-process restart.
      if (openMod && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        e.stopPropagation()
        const { workspace: ws, startupCwd: scwd } = stateRef.current
        const cwd = ws || scwd
        if (cwd) {
          const def = defaultCliSession(cwd, defaultCli ?? 'claude')
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
        // Navigate the flat cross-workspace list as a "hover" cursor — never auto-commits,
        // even within the active workspace. Enter switches to the parked session/workspace;
        // Esc cancels. Avoids loading anything heavy just from scrolling past it.
        const list = nav.navSessions
        if (list.length < 2) return
        const cursorId = nav.previewedNav?.id ?? nav.activeId
        if (!cursorId) return
        const i = list.findIndex((x) => x.id === cursorId)
        if (i === -1) return
        const d = action === 'session.prev' ? -1 : 1
        const target = list[(i + d + list.length) % list.length]
        setPreviewedNav({ ws: target.ws, id: target.id })
      } else if (action === 'tab.pin') {
        const cur = nav.focusedCardId
        if (!cur || cur.startsWith(PANEL_PREFIX)) return
        togglePinRef.current(cur)
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

  // Cards that should NOT auto-focus on next broadcast. The "expand subject" flow opens a
  // placeholder card in the background (so the user can keep reading the original) — once
  // content arrives, a separate decky:focus-path event focuses it.
  const noFocusIdsRef = useRef<Set<string>>(new Set())

  // Keep fs watchers in sync with the file-backed cards (markdown + editor sources).
  const watchedPathsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const paths = new Set<string>()
    for (const cards of Object.values(previewsByCard)) {
      for (const src of Object.values(cards)) {
        if (src.type === 'markdown' && src.path) paths.add(src.path)
        else if (src.type === 'editor') paths.add(src.path)
        else if (src.type === 'xlsx') paths.add(src.path)
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
              if (
                (src.type === 'markdown' && src.path === path) ||
                (src.type === 'editor' && src.path === path)
              ) {
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

  // Dispatch widget RPC calls from main into the renderer-side widget registry. The bridge
  // in main parks an HTTP response until reply() comes back — so the registry can throw,
  // return a value, or resolve a Promise and we just forward the outcome.
  useEffect(() => {
    return window.deck.widget.onCall(async (msg) => {
      try {
        let result: unknown
        if (msg.kind === 'invoke') {
          result = await invokeWidget(msg.cardId ?? '', msg.widgetId ?? '', msg.op ?? '', msg.args)
        } else if (msg.kind === 'get') {
          result = getWidget(msg.cardId ?? '', msg.widgetId ?? '', msg.key ?? '')
        } else {
          // list — catalog of registered widget types + currently-mounted instances
          result = { types: listWidgetTypes(), active: listActiveWidgets() }
        }
        window.deck.widget.reply({ reqId: msg.reqId, result })
      } catch (err) {
        window.deck.widget.reply({
          reqId: msg.reqId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
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
      else if (src.type === 'editor') lines.push(`- **${id}** — (editor: \`${src.path}\`)`)
      else if (src.type === 'xlsx') lines.push(`- **${id}** — (xlsx: \`${src.path}\`)`)
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

  // Desktop notification on the working→idle edge for any session the user isn't watching right
  // now (different session OR the window is unfocused). Edge-triggered via wasWorkingRef so we
  // notify exactly once per "thinking burst that finished".
  focusSessionRef.current = (id: string): void => {
    if (sessions.some((s) => s.id === id)) {
      setActiveId(id)
      return
    }
    for (const [ws, list] of Object.entries(wsSessionsCache)) {
      if (list.some((s) => s.id === id)) {
        pendingActiveRef.current = id
        setWorkspace(ws)
        return
      }
    }
    setActiveId(id)
  }
  useEffect(() => {
    return window.deck.notify.onFocusSession(({ id }) => focusSessionRef.current(id))
  }, [])
  useEffect(() => {
    for (const [id, a] of Object.entries(sessionActivity)) {
      const wasWorking = wasWorkingRef.current[id] === true
      if (wasWorking && !a.active) {
        const watching = id === activeId && document.hasFocus()
        console.log('[notify] working→idle edge', {
          id,
          activeId,
          watching,
          hasFocus: document.hasFocus()
        })
        if (!watching) {
          const label = titles[id] || aiTitles[id] || 'sessão'
          void window.deck.notify
            .show({ id, title: `${label} pronta`, body: 'terminou de processar' })
            .then(() => console.log('[notify] IPC resolved for', id))
            .catch((e) => console.error('[notify] IPC failed', e))
        }
      }
      wasWorkingRef.current[id] = a.active
    }
  }, [sessionActivity, activeId, titles, aiTitles])

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

  // Terminals to mount: the global live pool + the active session if it isn't in it yet
  // (avoids a one-frame gap before the LRU effect adds it). Active is the only visible one.
  const activeSess = sessions.find((s) => s.id === activeId)
  const hostSessions =
    activeSess && !liveSessions.some((s) => s.id === activeId)
      ? [...liveSessions, activeSess]
      : liveSessions

  const focusedCardId = activeId ? (focusedCardBySession[activeId] ?? null) : null

  const setFocusedCard = (id: string | null): void => {
    if (!activeId) return
    setFocusedCardBySession((prev) => ({ ...prev, [activeId]: id }))
  }

  const handleClose = (ws: string, id: string): void => {
    const isActiveWs = ws === workspace
    if (isActiveWs) {
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
    } else {
      // Sessão num WS não-ativo: o estado `sessions` não a contém (só representa o WS ativo).
      // Atualizamos o cache de exibição da árvore E persistimos a remoção no arquivo do WS,
      // senão a sessão voltaria no próximo read (mount, switch, expand).
      setWsSessionsCache((c) => {
        const list = c[ws]
        if (!list) return c
        const next = list.filter((s) => s.id !== id)
        return next.length === list.length ? c : { ...c, [ws]: next }
      })
      void (async () => {
        const data = await window.deck.workspace.read<WorkspaceState>(ws)
        if (!data || !Array.isArray(data.sessions)) return
        const nextSessions = data.sessions.filter((s) => s.id !== id)
        if (nextSessions.length === data.sessions.length) return
        const remaining = new Set(nextSessions.map((s) => s.id))
        const nextActive =
          data.activeId && remaining.has(data.activeId) ? data.activeId : nextSessions[0]?.id
        void window.deck.workspace.write(ws, {
          ...data,
          sessions: nextSessions,
          activeId: nextActive,
          cardsBySession: filterToSessionIds(data.cardsBySession ?? {}, remaining),
          focusedCardBySession: filterToSessionIds(data.focusedCardBySession ?? {}, remaining),
          previews: filterToSessionIds(data.previews ?? {}, remaining),
          titles: data.titles
            ? Object.fromEntries(Object.entries(data.titles).filter(([k]) => remaining.has(k)))
            : undefined
        })
      })()
    }
    // Tira a sessão do live pool — desmonta o Terminal (que chama pty.kill no cleanup) e
    // libera o pty mesmo quando a sessão estava rodando em outro workspace.
    setLiveSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      return next.length === prev.length ? prev : next
    })
    // Destrói os WebContentsViews dos cards web desta session antes de dropar o mapa — eles
    // vivem em main, indexados por cardId, e sobrevivem unmount do React de propósito (workspace
    // switch). Fechar a session é o sinal de "estes cards não voltam", então liberamos memória.
    const sessPreviews = previewsByCard[id] ?? {}
    for (const [cid, src] of Object.entries(sessPreviews)) {
      if (src?.type === 'web') window.deck.web.destroy(cid)
    }
    // Drop the closed session's entries from the cross-workspace maps so they don't linger
    // as dead memory (and don't get re-saved into the workspace file on the next debounce).
    setCardsBySession((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    setFocusedCardBySession((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    setPreviewsByCard((prev) => {
      if (!(id in prev)) return prev
      const { [id]: _drop, ...rest } = prev
      return rest
    })
  }

  const newClaudeSession = (): void => {
    const cwd = workspace || startupCwd
    if (!cwd) return
    const def = defaultCliSession(cwd, defaultCli ?? 'claude')
    setSessions((prev) => [...prev, def])
    setActiveId(def.id)
  }

  const addFolder = async (): Promise<void> => {
    const p = await window.deck.app.pickFolder()
    if (p) setWorkspace(p)
  }

  // Open a browser card in the active session, focused. Empty url = "nova aba" (URL bar
  // auto-focuses); with url = navigates straight there (used by palette `//query` shortcut).
  const openWebTab = (url: string = ''): void => {
    if (!activeId) return
    const aId = activeId
    const id = `web-${Date.now().toString(36)}`
    setCardsBySession((p) => ({ ...p, [aId]: [...(p[aId] ?? []), id] }))
    setPreviewsByCard((p) => ({
      ...p,
      [aId]: { ...(p[aId] ?? {}), [id]: { type: 'web', url } }
    }))
    setFocusedCardBySession((p) => ({ ...p, [aId]: id }))
  }

  const openGoogleSearch = (query: string): void => {
    const q = query.trim()
    if (!q) return
    openWebTab(`https://www.google.com/search?q=${encodeURIComponent(q)}`)
  }

  const toggleExpand = (ws: string): void =>
    setExpandedWorkspaces((e) => (e.includes(ws) ? e.filter((w) => w !== ws) : [...e, ws]))

  // Selecting a session in a non-active workspace switches first; the load effect then
  // activates the pending session once that workspace's sessions land.
  const selectSession = (ws: string, sid: string): void => {
    setPreviewedNav(null)
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
    const cliKind: CliKind = s.cliKind ?? 'claude'
    const detected = detectedClis?.find((c) => c.kind === cliKind)
    if (!detected) return undefined
    return [
      detected.bin,
      ...buildArgs(cliKind, {
        sessionId: s.claudeSessionId,
        systemPrompt: DECKY_SESSION_PROMPT
      })
    ]
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
    // Cards web vivem em main (WebContentsView indexado por cardId) e sobrevivem unmount do
    // React — workspace switch só esconde, não destrói. AQUI é o close de verdade: o usuário
    // clicou no × da aba ou tirou do pinned, então o view tem que morrer pra liberar memória.
    const wasWeb =
      pinned[id]?.type === 'web' ||
      (activeId ? previewsByCard[activeId]?.[id]?.type === 'web' : false)
    if (pinned[id]) {
      setPinned((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      if (wasWeb) window.deck.web.destroy(id)
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
    if (wasWeb) window.deck.web.destroy(id)
  }

  // Click on the header git stats: read the uncommitted diff and route it to a stable
  // `git-diff` card in the active session (created if absent, refreshed if open).
  const openGitDiff = useCallback(async (): Promise<void> => {
    const ws = stateRef.current.workspace
    const aId = stateRef.current.activeId
    if (!ws || !aId) return
    const content = await window.deck.git.diffText(ws)
    if (!content) return
    const cardId = 'git-diff'
    setCardsBySession((prev) => {
      const list = prev[aId] ?? []
      return list.includes(cardId) ? prev : { ...prev, [aId]: [...list, cardId] }
    })
    setPreviewsByCard((prev) => ({
      ...prev,
      [aId]: {
        ...(prev[aId] ?? {}),
        [cardId]: { type: 'diff', content, title: 'git diff (uncommitted)' }
      }
    }))
    setFocusedCardBySession((prev) => ({ ...prev, [aId]: cardId }))
  }, [])

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
  togglePinRef.current = togglePin

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
  cardSearchOpenRef.current = cardSearchOpen

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

  // Open a workspace page (markdown file under .decky/cards/) as a card in the active session.
  // Reuses the same flow as Cmd+clicking a path in the terminal: POST to /preview with a fresh
  // card id so a NEW tab is created — unless the file is already open as a card, in which case
  // the existing one is focused. Falls back to a no-op if there's no active session.
  const openPagePath = useCallback((page: WorkspacePage): void => {
    const aId = stateRef.current.activeId
    if (!aId) return
    window.dispatchEvent(
      new CustomEvent('decky:open-path', {
        detail: { path: page.path, sessionId: aId }
      })
    )
  }, [])

  // Delete a workspace page from disk, AND close any open card (own or pinned, across all
  // sessions) currently showing that file. Without the close-on-delete sweep the open card
  // would keep its stale content and any rewatch would silently fail on the missing file.
  const deletePagePath = useCallback(async (page: WorkspacePage): Promise<boolean> => {
    const ws = stateRef.current.workspace
    if (!ws) return false
    const ok = await window.deck.cards.delete(ws, page.id)
    if (!ok) return false
    // Unpin any pinned card pointing at this path.
    setPinned((prev) => {
      let changed = false
      const next: typeof prev = {}
      for (const [id, src] of Object.entries(prev)) {
        if (sourcePath(src) === page.path) {
          changed = true
          continue
        }
        next[id] = src
      }
      return changed ? next : prev
    })
    // Drop the card from every session that had it open as an own card.
    setCardsBySession((prev) => {
      let changed = false
      const next: typeof prev = {}
      for (const [sid, ids] of Object.entries(prev)) {
        const sessPreviews = stateRef.current.previewsByCard[sid] ?? {}
        const kept = ids.filter((id) => sourcePath(sessPreviews[id]) !== page.path)
        if (kept.length !== ids.length) changed = true
        next[sid] = kept
      }
      return changed ? next : prev
    })
    setPreviewsByCard((prev) => {
      let changed = false
      const next: typeof prev = {}
      for (const [sid, cards] of Object.entries(prev)) {
        const kept: Record<string, PreviewSource> = {}
        for (const [cid, src] of Object.entries(cards)) {
          if (sourcePath(src) === page.path) {
            changed = true
            continue
          }
          kept[cid] = src
        }
        next[sid] = kept
      }
      return changed ? next : prev
    })
    return true
  }, [])

  const renderPanel = (pid: PanelId): React.JSX.Element => {
    if (pid === 'pages') {
      return <PagesPanel workspace={workspace} onOpen={openPagePath} onDelete={deletePagePath} />
    }
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
  // Build a DeckCard[] for EVERY session in this workspace (not just the active one) so we
  // can keep all sessions' DeckTabs mounted in parallel — switching sessions then only flips
  // CSS visibility, leaving <webview>/iframe guests alive instead of tearing them down and
  // forcing a full reload on return.
  // includePinned: pinned cards são workspace-global mas só montam na session ATIVA — montar
  // o mesmo cardId em várias panes faria N WebPreview instances brigarem pelos bounds do único
  // WebContentsView (keyed por cardId em main): a inativa chama hide() no tick, a ativa
  // chama setBounds(real), quem disparar último vence → card pinada "some". O view sobrevive
  // ao unmount (main não destrói no React unmount), então trocar de session só re-attacha.
  const buildContentCards = (sessionId: string, includePinned: boolean): DeckCardData[] => {
    const sessPreviews = previewsByCard[sessionId] ?? {}
    const own = (cardsBySession[sessionId] ?? []).filter((id) => !pinned[id])
    // Workspace cwd this session is rooted at — passed to web cards so the history subsystem
    // in main can tag each visit with the right workspace_id.
    const sessionCwd = sessions.find((s) => s.id === sessionId)?.cwd ?? null
    const ids = includePinned ? [...pinnedIds, ...own] : own
    return ids.map((id, i) => {
      const isPinned = !!pinned[id]
      const source = isPinned ? pinned[id] : (sessPreviews[id] ?? { type: 'none' })
      // Persist navigation metadata of a web card up to parent state so a remount (workspace
      // switch, full reload) restores the typed URL/title/favicon instead of falling back to
      // the source's initial value (often '' from "nova aba" → about:blank). The tab strip
      // also reads title+favicon from the source — so this keeps the tab in sync without
      // re-driving the page.
      const onWebMetaChange = (meta: {
        url?: string
        title?: string
        favicon?: string | null
      }): void => {
        const patch = (cur: PreviewSource | undefined): PreviewSource | undefined => {
          if (!cur || cur.type !== 'web') return cur
          const next = { ...cur }
          let changed = false
          if (meta.url !== undefined && next.url !== meta.url) {
            next.url = meta.url
            changed = true
          }
          if (meta.title !== undefined && next.title !== meta.title) {
            next.title = meta.title
            changed = true
          }
          if (meta.favicon !== undefined && next.favicon !== meta.favicon) {
            next.favicon = meta.favicon
            changed = true
          }
          return changed ? next : cur
        }
        if (isPinned) {
          setPinned((prev) => {
            const next = patch(prev[id])
            if (next === prev[id]) return prev
            return { ...prev, [id]: next as PreviewSource }
          })
        } else {
          setPreviewsByCard((prev) => {
            const sess = prev[sessionId] ?? {}
            const next = patch(sess[id])
            if (next === sess[id]) return prev
            return { ...prev, [sessionId]: { ...sess, [id]: next as PreviewSource } }
          })
        }
      }
      const webFavicon =
        source.type === 'web' ? (source.favicon ?? null) : undefined
      return {
        id,
        title: cardTitle(source, isPinned ? 'pinned' : `card ${i + 1}`),
        favicon: webFavicon,
        pinned: isPinned,
        render: () => (
          <Preview
            source={source}
            cardId={id}
            sessionId={sessionId}
            workspaceCwd={sessionCwd}
            onWebMetaChange={onWebMetaChange}
          />
        )
      }
    })
  }
  // Per-session deckCards. Built for EVERY live session (LRU pool, cross-workspace) — not
  // just the active workspace's sessions — pra que trocar de workspace seja idempotente:
  // sessions visitadas recentemente continuam mounted (com visibility:hidden) preservando
  // estado React dos cards (scroll, JSON expandido, etc) e o WebContentsView de cards web.
  // System panels ficam só na session ativa — são UI global, não precisam ser duplicados.
  const deckCardsBySession: Record<string, DeckCardData[]> = {}
  for (const s of hostSessions) {
    const isActive = s.id === activeId
    const own = buildContentCards(s.id, isActive)
    deckCardsBySession[s.id] = isActive ? [...panelCards, ...own] : own
  }
  const deckCards: DeckCardData[] = activeId
    ? (deckCardsBySession[activeId] ?? panelCards)
    : panelCards

  // Workspaces sorted alphabetically by display name — drives BOTH the tree render and
  // the cross-workspace nav order, so Cmd+Arrow walks them in the same order they appear.
  const sortedWorkspaces = [...workspaces].sort((a, b) =>
    projectFromCwd(a).localeCompare(projectFromCwd(b), undefined, { sensitivity: 'base' })
  )

  // Flat session list across all workspaces, in tree order (workspace registry × sessions).
  const navSessions: { ws: string; id: string }[] = []
  for (const ws of sortedWorkspaces) {
    for (const s of treeSessionsByWorkspace[ws] ?? []) navSessions.push({ ws, id: s.id })
  }

  navRef.current = {
    navSessions,
    activeWorkspace: workspace,
    cardIds: deckCards.map((c) => c.id),
    activeId,
    focusedCardId,
    previewedNav
  }

  const currentThemeId = workspace ? workspaceThemes[workspace] : null
  const paletteCommands: Command[] = [
    {
      id: 'theme:toggle-mode',
      label: mode === 'dark' ? t('cmd.themeLight') : t('cmd.themeDark'),
      hint: t('cmd.appearance'),
      run: toggleMode
    },
    ...(workspace
      ? THEMES.filter((th) => th.id !== currentThemeId).map((th) => ({
          id: `theme:color:${th.id}`,
          label: `${t('cmd.colorPrefix')}${th.name}`,
          hint: t('cmd.workspaceTheme'),
          run: () => setWorkspaceThemes((prev) => ({ ...prev, [workspace]: th.id }))
        }))
      : []),
    { id: 'web:new', label: t('cmd.newWebTab'), hint: t('cmd.webTabHint'), run: openWebTab },
    {
      id: 'notify:test',
      label: t('cmd.testNotification'),
      hint: t('cmd.diagnostic'),
      run: () => {
        console.log('[notify-test] firing test notification')
        void window.deck.notify
          .show({ id: activeId ?? 'test', title: 'decky', body: t('cmd.notificationTestBody') })
          .then(() => console.log('[notify-test] IPC resolved'))
          .catch((e) => console.error('[notify-test] IPC failed', e))
      }
    },
    ...PANELS.map((p) => ({
      id: `panel:${p.id}`,
      label: p.paletteLabel,
      hint: t('cmd.panelHint'),
      run: () => openPanel(p.id)
    }))
    // dev:rebuild lives in the right-click menu on the top "decky" panel header now.
  ]

  const handleCliSave = async (kind: CliKind): Promise<void> => {
    await window.deck.cli.setDefault(kind)
    await window.deck.cli.markFirstRunDone()
    setDefaultCli(kind)
    setFirstRunPending(false)
    setCliSettingsOpen(false)
  }

  const handleCliSkip = async (): Promise<void> => {
    await window.deck.cli.markFirstRunDone()
    setFirstRunPending(false)
    setCliSettingsOpen(false)
  }

  const handleCliRecheck = async (): Promise<DetectedCli[]> => {
    const fresh = await window.deck.cli.recheck()
    setDetectedClis(fresh)
    return fresh
  }

  // Overlays that cover the canvas area force every web card's native overlay to hide
  // (a WebContentsView paints above the React shell, so without this it would obscure the
  // command palette, FirstRunModal, etc.). Keep this short and additive — anything truly
  // overlay-shaped goes in here.
  const overlayActive =
    paletteOpen || ((firstRunPending || cliSettingsOpen) && detectedClis !== null)

  return (
    <OverlayActiveProvider active={overlayActive}>
    <div className="deck">
      {(firstRunPending || cliSettingsOpen) && detectedClis !== null && (
        <FirstRunModal
          detectedClis={detectedClis}
          currentDefault={defaultCli}
          onSave={handleCliSave}
          onSkip={handleCliSkip}
          onRecheck={handleCliRecheck}
          showSkip={!firstRunPending}
          heading={cliSettingsOpen && !firstRunPending ? t('cli.headingSettings') : undefined}
        />
      )}
      <main className="deck-main">
        <ResizableSplit
          defaultSizes={[30, 70]}
          minSizes={[15, 25]}
          storageKey="deck-layout-2col-v0"
        >
          <section className="panel panel-sessions">
            <div className="panel-header">
              <span>decky</span>
            </div>
            <ResizableSplit
              direction="vertical"
              defaultSizes={[65, 35]}
              minSizes={[20, 10]}
              storageKey="deck-layout-sessions-v0"
            >
              <div
                className="panel-body panel-body-flush panel-focusable"
                data-panel="terminal"
                data-focused={focusedPanel === 'terminal'}
              >
                <TerminalHost
                  sessions={hostSessions}
                  activeId={activeId}
                  detectionLoaded={detectedClis !== null}
                  commandFor={commandFor}
                  mode={mode}
                  themeFor={themeFor}
                  onUserInput={(id) => {
                    userInputAtRef.current[id] = Date.now()
                  }}
                />
              </div>
              <WorkspaceTree
                isFocused={focusedPanel === 'tree'}
                workspaces={sortedWorkspaces}
                activeWorkspace={workspace}
                activeSessionId={activeId}
                previewedSession={previewedNav}
                expanded={expandedWorkspaces}
                sessionsByWorkspace={treeSessionsByWorkspace}
                activity={sessionActivity}
                mode={mode}
                themeFor={themeFor}
                nameOf={projectFromCwd}
                onToggleExpand={toggleExpand}
                onSelectSession={selectSession}
                onNewSession={newSessionIn}
                onCloseSession={handleClose}
                onCloseWorkspace={closeWorkspace}
                onAddFolder={() => void addFolder()}
              />
            </ResizableSplit>
          </section>

          <section className="panel panel-preview">
            <div className="panel-header">
              <span>{workspace ? projectFromCwd(workspace) : 'decky'}</span>
              {gitStats && (
                <span className="panel-header-git">
                  <GitStats
                    additions={gitStats.additions}
                    deletions={gitStats.deletions}
                    onClick={openGitDiff}
                  />
                  {gitStats.branch && (
                    <span className="git-branch" title={`branch ${gitStats.branch}`}>
                      <span className="git-branch-icon" aria-hidden="true">
                        ⎇
                      </span>
                      {gitStats.branch}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div
              className="panel-body panel-body-flush panel-focusable"
              data-panel="preview"
              data-focused={focusedPanel === 'preview'}
            >
              {DECKY_LAYOUT === 'tabs' ? (
                // One DeckTabs per LIVE session (LRU pool, cross-workspace) — not só do workspace
                // ativo. Active one is visible, others are visibility:hidden. Keeping inactive
                // panes mounted preserves React state (scroll, JSON expandido) + WebContentsView
                // pra sessions de OUTROS workspaces — trocar workspace e voltar é idempotente.
                <div className="session-pane-stack">
                  {hostSessions.map((s) => {
                    const isActive = s.id === activeId
                    return (
                      <div
                        key={s.id}
                        className={`session-pane ${isActive ? 'session-pane-active' : 'session-pane-inactive'}`}
                      >
                        {/* SessionVisible drives WebContentsView paint for every web card under
                            this session. visibility:hidden keeps the React tree mounted; the
                            native overlay's "hide" runs through this context, not CSS. */}
                        <SessionVisibleProvider visible={isActive}>
                          <DeckTabs
                            focusedId={focusedCardBySession[s.id] ?? null}
                            onFocusChange={(id) =>
                              setFocusedCardBySession((prev) => ({ ...prev, [s.id]: id }))
                            }
                            onClose={closeCard}
                            onTogglePin={togglePin}
                            onReorder={reorderCards}
                            cards={deckCardsBySession[s.id] ?? []}
                          />
                        </SessionVisibleProvider>
                      </div>
                    )
                  })}
                </div>
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
        <CommandPalette
          commands={paletteCommands}
          onWebSearch={openGoogleSearch}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {cardSearchOpen && workspace && (
        <CardSearch
          workspace={workspace}
          onPick={(hit) => {
            const aId = stateRef.current.activeId
            if (!aId) return
            window.dispatchEvent(
              new CustomEvent('decky:open-path', {
                detail: { path: hit.path, sessionId: aId }
              })
            )
          }}
          onClose={() => setCardSearchOpen(false)}
        />
      )}
      {devInfo.enabled && rebuildState !== 'idle' && (
        <div
          className={`dev-rebuild-status dev-rebuild-${rebuildState}`}
          onClick={() => {
            if (rebuildState === 'ready' || rebuildState === 'error') void doRebuild()
          }}
          role={rebuildState === 'ready' || rebuildState === 'error' ? 'button' : undefined}
          title={
            rebuildState === 'ready'
              ? t('rebuild.readyTooltip')
              : rebuildState === 'error'
                ? t('rebuild.errorTooltip')
                : undefined
          }
        >
          <span>
            {rebuildState === 'running' && <span className="dev-rebuild-spinner" aria-hidden />}
            {rebuildState === 'running' ? (
              <>
                {t('rebuild.running')}
                <span className="dev-rebuild-elapsed">{rebuildElapsedSec}s</span>
              </>
            ) : rebuildState === 'ready' ? (
              <>
                {t('rebuild.readyPrefix')}
                <span className="dev-rebuild-elapsed">{rebuildElapsedSec}s</span>
                {t('rebuild.readySuffix')}
              </>
            ) : (
              <>
                {t('rebuild.errorPrefix')}
                <span className="dev-rebuild-elapsed">{rebuildElapsedSec}s</span>
                {t('rebuild.errorSuffix')}
              </>
            )}
          </span>
          {rebuildState === 'error' && rebuildLog && (
            <pre className="dev-rebuild-log">{rebuildLog}</pre>
          )}
        </div>
      )}
    </div>
    </OverlayActiveProvider>
  )
}

export default App
