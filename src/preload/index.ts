import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { PreviewSource } from '../shared/preview'
import type { CliKind, DetectedCli, CliInstallHint } from '../shared/cli-spec'
import { DEFAULT_LOCALE, LOCALE_ARG_PREFIX, normalizeLocale, type Locale } from '../shared/locale'

const resolvedLocale: Locale = (() => {
  const arg = process.argv.find((a) => a.startsWith(LOCALE_ARG_PREFIX))
  return arg ? normalizeLocale(arg.slice(LOCALE_ARG_PREFIX.length)) : DEFAULT_LOCALE
})()

type PtyDataMsg = { id: string; data: string }
type PtyExitMsg = { id: string; code: number }

const deckApi = {
  pty: {
    create: (
      id: string,
      opts: { cwd?: string; cols: number; rows: number; shell?: string; command?: string[] }
    ): Promise<void> => ipcRenderer.invoke('pty:create', { id, ...opts }),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),
    onData: (callback: (msg: PtyDataMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyDataMsg): void => callback(msg)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (callback: (msg: PtyExitMsg) => void): (() => void) => {
      const listener = (_: unknown, msg: PtyExitMsg): void => callback(msg)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  },
  preview: {
    getAll: (): Promise<Record<string, PreviewSource>> => ipcRenderer.invoke('preview:get-all'),
    rehydrate: (
      byCard: Record<string, Record<string, PreviewSource>>,
      workspace?: string
    ): Promise<Record<string, Record<string, PreviewSource>>> =>
      ipcRenderer.invoke('preview:rehydrate', byCard, workspace),
    onSourceChange: (
      callback: (msg: {
        sessionId: string
        cardId: string | null
        source: PreviewSource
        reqId?: string
      }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: {
          sessionId: string
          cardId: string | null
          source: PreviewSource
          reqId?: string
        }
      ): void => callback(msg)
      ipcRenderer.on('preview:source-changed', listener)
      return () => ipcRenderer.removeListener('preview:source-changed', listener)
    },
    // Ack a preview:source-changed broadcast: tell main which card the inline source actually
    // landed on so the HTTP /preview response can echo cardId+path back to the MCP caller.
    resolved: (payload: { reqId: string; cardId: string; path?: string; title?: string }): void =>
      ipcRenderer.send('preview:resolved', payload)
  },
  workspace: {
    read: <T = unknown>(cwd: string): Promise<T | null> =>
      ipcRenderer.invoke('workspace:read', cwd),
    write: (cwd: string, state: unknown): Promise<true> =>
      ipcRenderer.invoke('workspace:write', cwd, state)
  },
  cards: {
    // Materialize a card to its file under the workspace's .decky/cards/. Returns the
    // resolved abs path (to store on the source + watch), or null on failure.
    write: (
      workspace: string,
      cardId: string,
      content: string,
      ext?: '.md' | '.html'
    ): Promise<string | null> =>
      ipcRenderer.invoke('cards:write', workspace, cardId, content, ext),
    // Push the renderer's full per-session card mirror to main (id/path/title/type/focused).
    // Main exposes this via HTTP for the MCP list_cards tool. Called debounced.
    syncState: (sessions: Record<string, unknown>): void =>
      ipcRenderer.send('cards:state-sync', { sessions }),
    // List every .md page under <workspace>/.decky/cards/ (recursive). Drives the
    // "Páginas do workspace" panel.
    list: (
      workspace: string
    ): Promise<{ id: string; path: string; title: string; mtime: number }[]> =>
      ipcRenderer.invoke('cards:list', workspace),
    // Full-text search across <workspace>/.decky/cards/ (recursive). Empty query
    // returns the most-recently-modified cards by mtime.
    search: (
      workspace: string,
      query: string,
      limit?: number
    ): Promise<
      {
        id: string
        path: string
        title: string
        snippet: string
        line: number
        score: number
        mtime: number
      }[]
    > => ipcRenderer.invoke('cards:search', workspace, query, limit),
    // Resolve a [[name]] wikilink to an absolute card path under <workspace>/.decky/cards/.
    // Returns null if no card matches by full id or basename.
    resolveWikilink: (workspace: string, name: string): Promise<string | null> =>
      ipcRenderer.invoke('cards:resolve-wikilink', workspace, name),
    // List every card whose body contains [[<id>]] or [[<basename>]] pointing at cardPath.
    backlinks: (
      workspace: string,
      cardPath: string
    ): Promise<
      {
        id: string
        path: string
        title: string
        snippet: string
        line: number
        mtime: number
      }[]
    > => ipcRenderer.invoke('cards:backlinks', workspace, cardPath),
    delete: (workspace: string, cardId: string): Promise<boolean> =>
      ipcRenderer.invoke('cards:delete', workspace, cardId)
  },
  tagsIndex: {
    // Ensure the workspace's tags-index.html is being generated + watched. Idempotent.
    // Triggers an initial generation on the first call so the index file exists when the
    // renderer goes to open it as an empty-state tab.
    ensure: (workspace: string): Promise<void> =>
      ipcRenderer.invoke('tagsIndex:ensure', workspace),
    // Force a regen now (sync — useful from a UI "rebuild index" button later).
    rebuild: (workspace: string): Promise<void> =>
      ipcRenderer.invoke('tagsIndex:rebuild', workspace),
    // Absolute path to <workspace>/.decky[-dev]/cards/tags-index.html.
    path: (workspace: string): Promise<string> =>
      ipcRenderer.invoke('tagsIndex:path', workspace)
  },
  file: {
    watch: (path: string): Promise<true> => ipcRenderer.invoke('file:watch', path),
    unwatch: (path: string): Promise<true> => ipcRenderer.invoke('file:unwatch', path),
    readText: (path: string): Promise<string | null> => ipcRenderer.invoke('file:read-text', path),
    readBinary: (path: string): Promise<Uint8Array | null> =>
      ipcRenderer.invoke('file:read-binary', path),
    write: (path: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('file:write', path, content),
    onChanged: (callback: (msg: { path: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { path: string }): void => callback(msg)
      ipcRenderer.on('file:changed', listener)
      return () => ipcRenderer.removeListener('file:changed', listener)
    }
  },
  claude: {
    getBin: (): Promise<string> => ipcRenderer.invoke('claude:get-bin'),
    aiTitle: (cwd: string, uuid: string): Promise<string | null> =>
      ipcRenderer.invoke('claude:ai-title', cwd, uuid)
  },
  git: {
    diffStats: (
      cwd: string
    ): Promise<{ isRepo: boolean; additions: number; deletions: number; branch?: string }> =>
      ipcRenderer.invoke('git:diff-stats', cwd),
    diffText: (cwd: string): Promise<string> => ipcRenderer.invoke('git:diff-text', cwd)
  },
  cli: {
    list: (): Promise<DetectedCli[]> => ipcRenderer.invoke('cli:list'),
    recheck: (): Promise<DetectedCli[]> => ipcRenderer.invoke('cli:recheck'),
    installHints: (): Promise<CliInstallHint[]> => ipcRenderer.invoke('cli:install-hints'),
    getDefault: (): Promise<CliKind | null> => ipcRenderer.invoke('cli:get-default'),
    setDefault: (kind: CliKind): Promise<true> => ipcRenderer.invoke('cli:set-default', kind),
    isFirstRun: (): Promise<boolean> => ipcRenderer.invoke('cli:is-first-run'),
    markFirstRunDone: (): Promise<true> => ipcRenderer.invoke('cli:mark-first-run-done'),
    getPaths: (): Promise<Partial<Record<CliKind, string>>> => ipcRenderer.invoke('cli:get-paths'),
    setPath: (kind: CliKind, path: string | null): Promise<DetectedCli[]> =>
      ipcRenderer.invoke('cli:set-path', kind, path),
    validatePath: (path: string): Promise<{ ok: boolean; error?: string; version?: string }> =>
      ipcRenderer.invoke('cli:validate-path', path)
  },
  sessions: {
    getTitles: (): Promise<Record<string, string>> => ipcRenderer.invoke('sessions:get-titles'),
    onTitleChange: (callback: (msg: { id: string; title: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { id: string; title: string }): void => callback(msg)
      ipcRenderer.on('session:title-changed', listener)
      return () => ipcRenderer.removeListener('session:title-changed', listener)
    },
    onAdd: (callback: (msg: { cwd: string; kind: 'claude' | 'shell' }) => void): (() => void) => {
      const listener = (_: unknown, msg: { cwd: string; kind: 'claude' | 'shell' }): void =>
        callback(msg)
      ipcRenderer.on('session:add', listener)
      return () => ipcRenderer.removeListener('session:add', listener)
    },
    onUuidConflict: (callback: (msg: { id: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { id: string }): void => callback(msg)
      ipcRenderer.on('session:uuid-conflict', listener)
      return () => ipcRenderer.removeListener('session:uuid-conflict', listener)
    }
  },
  app: {
    locale: resolvedLocale,
    getStartupCwd: (): Promise<string> => ipcRenderer.invoke('app:get-startup-cwd'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),
    pickFile: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pick-file', title),
    onMenuNewSession: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:new-session', listener)
      return () => ipcRenderer.removeListener('menu:new-session', listener)
    },
    onMenuCloseTab: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:close-tab', listener)
      return () => ipcRenderer.removeListener('menu:close-tab', listener)
    },
    onMenuTogglePalette: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:toggle-palette', listener)
      return () => ipcRenderer.removeListener('menu:toggle-palette', listener)
    },
    onMenuToggleFind: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:toggle-find', listener)
      return () => ipcRenderer.removeListener('menu:toggle-find', listener)
    },
    onMenuOpenCliSettings: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:open-cli-settings', listener)
      return () => ipcRenderer.removeListener('menu:open-cli-settings', listener)
    },
    onMenuDevRebuild: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:dev-rebuild', listener)
      return () => ipcRenderer.removeListener('menu:dev-rebuild', listener)
    },
    // Quit-time flush: main sends 'app:flush' and holds the exit until we reply 'app:flush-done'.
    onFlush: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('app:flush', listener)
      return () => ipcRenderer.removeListener('app:flush', listener)
    },
    flushDone: (): void => ipcRenderer.send('app:flush-done'),
    // Main forwards every link click / window.open from the renderer here so we can spawn an
    // internal web card instead of leaking to the OS browser.
    onOpenUrl: (callback: (url: string) => void): (() => void) => {
      const listener = (_: unknown, url: string): void => callback(url)
      ipcRenderer.on('app:open-url', listener)
      return () => ipcRenderer.removeListener('app:open-url', listener)
    },
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
    // Main forwards decky chrome shortcuts (Cmd+P etc) caught by focused web cards so the
    // renderer can replay them as a real KeyboardEvent on window.
    onShortcut: (
      callback: (msg: {
        key: string
        shift: boolean
        control: boolean
        alt: boolean
        meta: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: { key: string; shift: boolean; control: boolean; alt: boolean; meta: boolean }
      ): void => callback(msg)
      ipcRenderer.on('app:shortcut', listener)
      return () => ipcRenderer.removeListener('app:shortcut', listener)
    }
  },
  dev: {
    getInfo: (): Promise<{ enabled: boolean; repo?: string; accel: string }> =>
      ipcRenderer.invoke('dev:get-info'),
    rebuild: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('dev:rebuild'),
    relaunch: (): Promise<void> => ipcRenderer.invoke('dev:relaunch'),
    onOutput: (callback: (line: string) => void): (() => void) => {
      const listener = (_: unknown, line: string): void => callback(line)
      ipcRenderer.on('dev:rebuild-output', listener)
      return () => ipcRenderer.removeListener('dev:rebuild-output', listener)
    }
  },
  state: {
    get: <T = unknown>(key: string): Promise<T | null> => ipcRenderer.invoke('state:get', key),
    set: (key: string, value: unknown): Promise<true> => ipcRenderer.invoke('state:set', key, value)
  },
  theme: {
    // Tells main to set Electron's nativeTheme.themeSource so every embedded webContents
    // (each web card) reports the matching prefers-color-scheme. Call on every renderer
    // mode toggle.
    setMode: (mode: 'dark' | 'light'): Promise<true> => ipcRenderer.invoke('theme:set-mode', mode)
  },
  notify: {
    show: (payload: { id: string; title: string; body?: string }): Promise<void> =>
      ipcRenderer.invoke('notify:show', payload),
    onFocusSession: (callback: (msg: { id: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { id: string }): void => callback(msg)
      ipcRenderer.on('notify:focus-session', listener)
      return () => ipcRenderer.removeListener('notify:focus-session', listener)
    }
  },
  web: {
    // Each web card maps 1:1 to a WebContentsView owned by main. The renderer creates the
    // view on mount, streams bounds whenever its sentinel rect changes, hides it (zero-sized
    // bounds) when the pane / session / overlay state says it shouldn't be visible, and
    // destroys it on unmount.
    create: (cardId: string, url: string, workspaceCwd?: string | null): Promise<true> =>
      ipcRenderer.invoke('web:create', { cardId, url, workspaceCwd: workspaceCwd ?? null }),
    destroy: (cardId: string): Promise<true> => ipcRenderer.invoke('web:destroy', cardId),
    setBounds: (
      cardId: string,
      bounds: { x: number; y: number; width: number; height: number }
    ): void => ipcRenderer.send('web:set-bounds', { cardId, bounds }),
    hide: (cardId: string): void => ipcRenderer.send('web:hide', cardId),
    navigate: (cardId: string, url: string): void =>
      ipcRenderer.send('web:navigate', { cardId, url }),
    back: (cardId: string): void => ipcRenderer.send('web:back', cardId),
    forward: (cardId: string): void => ipcRenderer.send('web:forward', cardId),
    reload: (cardId: string): void => ipcRenderer.send('web:reload', cardId),
    stop: (cardId: string): void => ipcRenderer.send('web:stop', cardId),
    openDevTools: (cardId: string): void => ipcRenderer.send('web:open-devtools', cardId),
    getState: (
      cardId: string
    ): Promise<{
      url: string
      title: string
      favicon: string | null
      loading: boolean
      canBack: boolean
      canFwd: boolean
    } | null> => ipcRenderer.invoke('web:get-state', cardId),
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
    ): (() => void) => {
      const listener = (_: unknown, msg: Parameters<typeof callback>[0]): void => callback(msg)
      ipcRenderer.on('web:state', listener)
      return () => ipcRenderer.removeListener('web:state', listener)
    },
    // Estado vivo "agente está dirigindo este card". O backend do handoff (handoff-backend.ts)
    // liga/desliga; o renderer reage com animação + bounds shrunk pra mostrar a borda.
    getControlling: (cardId: string): Promise<boolean> =>
      ipcRenderer.invoke('web:get-controlling', cardId),
    onControlling: (
      callback: (msg: { cardId: string; controlling: boolean }) => void
    ): (() => void) => {
      const listener = (_: unknown, msg: Parameters<typeof callback>[0]): void => callback(msg)
      ipcRenderer.on('web:controlling', listener)
      return () => ipcRenderer.removeListener('web:controlling', listener)
    }
  },
  html: {
    // Resolve a local HTML file path to an http://127.0.0.1:<port> URL. Main spins up an
    // ephemeral server for the file's directory on first call and reuses it after that —
    // serving via http lets fetch / ES modules / Service Workers actually work (file:// blocks).
    resolve: (path: string): Promise<string> => ipcRenderer.invoke('html:resolve', path)
  },
  history: {
    listRecent: (
      workspaceCwd: string | null,
      limit?: number
    ): Promise<
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
    > => ipcRenderer.invoke('history:list-recent', { workspaceCwd, limit }),
    // Address-bar autocomplete: query vazia = top por frecência geral.
    suggest: (
      workspaceCwd: string | null,
      query: string,
      limit?: number
    ): Promise<
      {
        url: string
        title: string | null
        favicon: string | null
        hits: number
        last_visited: number
      }[]
    > => ipcRenderer.invoke('history:suggest', { workspaceCwd, query, limit }),
    getWorkspaceMeta: (cwd: string): Promise<{ workspaceId: string; isolated: boolean }> =>
      ipcRenderer.invoke('history:get-workspace-meta', cwd),
    setWorkspaceIsolated: (cwd: string, isolated: boolean): Promise<true> =>
      ipcRenderer.invoke('history:set-workspace-isolated', cwd, isolated)
  },
  widget: {
    // Main forwards every widget:call here. The renderer dispatches into the widget registry
    // and acks via reply(reqId, ...). One-shot per reqId — there is no streaming.
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
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: {
          reqId: string
          kind: 'invoke' | 'get' | 'list'
          cardId?: string
          widgetId?: string
          op?: string
          args?: unknown
          key?: string
        }
      ): void => callback(msg)
      ipcRenderer.on('widget:call', listener)
      return () => ipcRenderer.removeListener('widget:call', listener)
    },
    reply: (payload: { reqId: string; result?: unknown; error?: string }): void =>
      ipcRenderer.send('widget:call-reply', payload)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('deck', deckApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.deck = deckApi
}
