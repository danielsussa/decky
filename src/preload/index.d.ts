import { ElectronAPI } from '@electron-toolkit/preload'
import type { PreviewSource } from '../shared/preview'
import type { CliKind, DetectedCli, CliInstallHint } from '../shared/cli-spec'
import type { Locale } from '../shared/locale'

export type { PreviewSource, CliKind, DetectedCli, CliInstallHint, Locale }

export type PtyDataMsg = { id: string; data: string }
export type PtyExitMsg = { id: string; code: number }

export interface DeckAPI {
  pty: {
    create: (
      id: string,
      opts: { cwd?: string; cols: number; rows: number; shell?: string; command?: string[] }
    ) => Promise<void>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    onData: (callback: (msg: PtyDataMsg) => void) => () => void
    onExit: (callback: (msg: PtyExitMsg) => void) => () => void
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
    write: (cwd: string, state: unknown) => Promise<true>
  }
  cards: {
    write: (workspace: string, cardId: string, content: string) => Promise<string | null>
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
  file: {
    watch: (path: string) => Promise<true>
    unwatch: (path: string) => Promise<true>
    readText: (path: string) => Promise<string | null>
    readBinary: (path: string) => Promise<Uint8Array | null>
    write: (path: string, content: string) => Promise<boolean>
    onChanged: (callback: (msg: { path: string }) => void) => () => void
  }
  claude: {
    getBin: () => Promise<string>
    aiTitle: (cwd: string, uuid: string) => Promise<string | null>
  }
  git: {
    diffStats: (
      cwd: string
    ) => Promise<{ isRepo: boolean; additions: number; deletions: number; branch?: string }>
    diffText: (cwd: string) => Promise<string>
  }
  cli: {
    list: () => Promise<DetectedCli[]>
    recheck: () => Promise<DetectedCli[]>
    installHints: () => Promise<CliInstallHint[]>
    getDefault: () => Promise<CliKind | null>
    setDefault: (kind: CliKind) => Promise<true>
    isFirstRun: () => Promise<boolean>
    markFirstRunDone: () => Promise<true>
    getPaths: () => Promise<Partial<Record<CliKind, string>>>
    setPath: (kind: CliKind, path: string | null) => Promise<DetectedCli[]>
    validatePath: (path: string) => Promise<{ ok: boolean; error?: string; version?: string }>
  }
  sessions: {
    getTitles: () => Promise<Record<string, string>>
    onTitleChange: (callback: (msg: { id: string; title: string }) => void) => () => void
    onAdd: (callback: (msg: { cwd: string; kind: 'claude' | 'shell' }) => void) => () => void
    onUuidConflict: (callback: (msg: { id: string }) => void) => () => void
  }
  app: {
    locale: Locale
    getStartupCwd: () => Promise<string>
    pickFolder: () => Promise<string | null>
    pickFile: (title?: string) => Promise<string | null>
    onMenuNewSession: (callback: () => void) => () => void
    onMenuCloseTab: (callback: () => void) => () => void
    onMenuOpenCliSettings: (callback: () => void) => () => void
    onMenuDevRebuild: (callback: () => void) => () => void
    onFlush: (callback: () => void) => () => void
    flushDone: () => void
    onOpenUrl: (callback: (url: string) => void) => () => void
    openExternal: (url: string) => Promise<void>
  }
  dev: {
    getInfo: () => Promise<{ enabled: boolean; repo?: string; accel: string }>
    rebuild: () => Promise<{ ok: boolean; error?: string }>
    relaunch: () => Promise<void>
    onOutput: (callback: (line: string) => void) => () => void
  }
  state: {
    get: <T = unknown>(key: string) => Promise<T | null>
    set: (key: string, value: unknown) => Promise<true>
  }
  theme: {
    setMode: (mode: 'dark' | 'light') => Promise<true>
  }
  notify: {
    show: (payload: { id: string; title: string; body?: string }) => Promise<void>
    onFocusSession: (callback: (msg: { id: string }) => void) => () => void
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
    setWorkspaceIsolated: (cwd: string, isolated: boolean) => Promise<true>
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
