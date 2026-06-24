import { ElectronAPI } from '@electron-toolkit/preload'
import type { PreviewSource } from '@decky/shared'
import type { Locale, Engine } from '@decky/shared'

export type { PreviewSource, Locale, Engine }

export type PtyDataMsg = { id: string; data: string }
export type PtyExitMsg = { id: string; code: number }
export type PtyClaudeMsg = { id: string; running: boolean; sessionId?: string; launchCmd?: string }
export type ClaudeSessionInfo = {
  id: string
  title: string | null
  gitBranch: string | null
  lastPrompt: string | null
  mtimeMs: number
  /** Timestamp do último turn real (user/assistant) — recência honesta da conversa p/ filtro. */
  lastTurnMs: number
}

export interface DeckAPI {
  pty: {
    create: (
      id: string,
      opts: {
        cwd?: string
        cols: number
        rows: number
        shell?: string
        command?: string[]
        claudeSessionId?: string
      }
    ) => Promise<void>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    onData: (callback: (msg: PtyDataMsg) => void) => () => void
    onExit: (callback: (msg: PtyExitMsg) => void) => () => void
    onClaude: (callback: (msg: PtyClaudeMsg) => void) => () => void
  }
  preview: {
    getAll: () => Promise<Record<string, PreviewSource>>
    rehydrate: (
      byCard: Record<string, Record<string, PreviewSource>>,
      workspace?: string
    ) => Promise<Record<string, Record<string, PreviewSource>>>
    onSourceChange: (
      callback: (msg: {
        sessionId: string
        cardId: string | null
        source: PreviewSource
        reqId?: string
      }) => void
    ) => () => void
    resolved: (payload: { reqId: string; cardId: string; path?: string; title?: string }) => void
  }
  workspace: {
    read: <T = unknown>(cwd: string) => Promise<T | null>
    write: (cwd: string, state: unknown) => Promise<boolean>
  }
  cards: {
    write: (
      workspace: string,
      cardId: string,
      content: string,
      ext?: '.md' | '.html'
    ) => Promise<string | null>
    syncState: (sessions: Record<string, unknown>) => void
    list: (
      workspace: string
    ) => Promise<{ id: string; path: string; title: string; mtime: number }[]>
    search: (
      workspace: string,
      query: string,
      limit?: number
    ) => Promise<
      {
        id: string
        path: string
        title: string
        snippet: string
        line: number
        score: number
        mtime: number
      }[]
    >
    resolveWikilink: (workspace: string, name: string) => Promise<string | null>
    backlinks: (
      workspace: string,
      cardPath: string
    ) => Promise<
      {
        id: string
        path: string
        title: string
        snippet: string
        line: number
        mtime: number
      }[]
    >
    delete: (workspace: string, cardId: string) => Promise<boolean>
  }
  tagsIndex: {
    ensure: (workspace: string) => Promise<void>
    rebuild: (workspace: string) => Promise<void>
    path: (workspace: string) => Promise<string>
  }
  file: {
    watch: (path: string) => Promise<boolean>
    unwatch: (path: string) => Promise<boolean>
    readText: (path: string, workspace?: string) => Promise<string | null>
    readBinary: (path: string) => Promise<Uint8Array | null>
    write: (path: string, content: string, workspace?: string) => Promise<boolean>
    writeBinaryBase64: (path: string, base64: string, workspace?: string) => Promise<boolean>
    onChanged: (callback: (msg: { path: string }) => void) => () => void
  }
  git: {
    diffStats: (
      cwd: string
    ) => Promise<{ isRepo: boolean; additions: number; deletions: number; branch?: string }>
    diffText: (cwd: string) => Promise<string>
  }
  sessions: {
    getTitles: () => Promise<Record<string, string>>
    onTitleChange: (callback: (msg: { id: string; title: string }) => void) => () => void
    onRunningChange: (callback: (msg: { id: string; cmd: string }) => void) => () => void
    onAdd: (callback: (msg: { cwd: string }) => void) => () => void
    onWebTab: (callback: (msg: { title?: string }) => void) => () => void
    listClaude: (cwd: string) => Promise<ClaudeSessionInfo[]>
    deleteClaude: (cwd: string, id: string) => Promise<void>
  }
  app: {
    locale: Locale
    getStartupCwd: () => Promise<string>
    pickFolder: () => Promise<string | null>
    pickFile: (title?: string) => Promise<string | null>
    onMenuNewSession: (callback: () => void) => () => void
    onMenuCloseTab: (callback: () => void) => () => void
    onMenuTogglePalette: (callback: () => void) => () => void
    onMenuToggleFind: (callback: () => void) => () => void
    onMenuDevRebuild: (callback: () => void) => () => void
    onFlush: (callback: () => void) => () => void
    flushDone: () => void
    diag: (msg: string) => void
    typingPing: () => void
    onFocusStolenBack: (callback: () => void) => () => void
    onOpenUrl: (callback: (url: string) => void) => () => void
    openExternal: (url: string) => Promise<void>
    cardUrlToPath: (url: string) => Promise<string | null>
    onShortcut: (
      callback: (msg: {
        key: string
        shift: boolean
        control: boolean
        alt: boolean
        meta: boolean
      }) => void
    ) => () => void
  }
  dev: {
    getInfo: () => Promise<{ enabled: boolean; repo?: string; accel: string }>
    rebuild: () => Promise<{ ok: boolean; error?: string }>
    relaunch: () => Promise<void>
    onOutput: (callback: (line: string) => void) => () => void
  }
  state: {
    get: <T = unknown>(key: string) => Promise<T | null>
    set: (key: string, value: unknown) => Promise<boolean>
  }
  theme: {
    setMode: (mode: 'dark' | 'light') => Promise<boolean>
  }
  notify: {
    show: (payload: { id: string; title: string; body?: string }) => Promise<void>
    onFocusSession: (callback: (msg: { id: string }) => void) => () => void
  }
  html: {
    resolve: (path: string) => Promise<string>
  }
  history: {
    listRecent: (
      workspaceCwd: string | null,
      limit?: number
    ) => Promise<
      {
        id: number
        url: string
        title: string | null
        favicon: string | null
        card_id: string | null
        workspace_id: string
        visited_at: number
        dwell_ms: number
        transition: string | null
      }[]
    >
    suggest: (
      workspaceCwd: string | null,
      query: string,
      limit?: number
    ) => Promise<
      {
        url: string
        title: string | null
        favicon: string | null
        hits: number
        last_visited: number
      }[]
    >
    getWorkspaceMeta: (cwd: string) => Promise<{ workspaceId: string; isolated: boolean }>
    setWorkspaceIsolated: (cwd: string, isolated: boolean) => Promise<boolean>
  }
  web: {
    create: (cardId: string, url: string, workspaceCwd?: string | null) => Promise<true>
    destroy: (cardId: string) => Promise<true>
    setBounds: (
      cardId: string,
      bounds: { x: number; y: number; width: number; height: number }
    ) => void
    hide: (cardId: string) => void
    navigate: (cardId: string, url: string) => void
    back: (cardId: string) => void
    forward: (cardId: string) => void
    reload: (cardId: string) => void
    stop: (cardId: string) => void
    openDevTools: (cardId: string) => void
    onReload: (callback: (msg: { path: string }) => void) => () => void
    patchCard: (
      cardId: string,
      patch: { op: string; type?: string; id?: string; spec?: unknown; n?: number }
    ) => void
    onPatch: (
      callback: (msg: {
        path: string
        op: string
        type?: string
        id?: string
        spec?: unknown
        n?: number
      }) => void
    ) => () => void
    getState: (cardId: string) => Promise<{
      url: string
      title: string
      favicon: string | null
      loading: boolean
      canBack: boolean
      canFwd: boolean
    } | null>
    onState: (
      callback: (msg: {
        cardId: string
        url: string
        title: string
        favicon: string | null
        loading: boolean
        canBack: boolean
        canFwd: boolean
      }) => void
    ) => () => void
    getControlling: (cardId: string) => Promise<boolean>
    onControlling: (callback: (msg: { cardId: string; controlling: boolean }) => void) => () => void
    onOpenTab: (callback: (msg: { url: string }) => void) => () => void
  }
  widget: {
    onCall: (
      callback: (msg: {
        reqId: string
        kind: 'invoke' | 'get' | 'list'
        cardId?: string
        widgetId?: string
        op?: string
        args?: unknown
        key?: string
      }) => void
    ) => () => void
    reply: (payload: { reqId: string; result?: unknown; error?: string }) => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    deck: DeckAPI
  }
}
