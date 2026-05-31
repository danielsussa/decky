import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { PreviewSource } from '../shared/preview'
import type { CliKind, DetectedCli, CliInstallHint } from '../shared/cli-spec'

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
    write: (workspace: string, cardId: string, content: string): Promise<string | null> =>
      ipcRenderer.invoke('cards:write', workspace, cardId, content),
    // Push the renderer's full per-session card mirror to main (id/path/title/type/focused).
    // Main exposes this via HTTP for the MCP list_cards tool. Called debounced.
    syncState: (sessions: Record<string, unknown>): void =>
      ipcRenderer.send('cards:state-sync', { sessions })
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
    markFirstRunDone: (): Promise<true> => ipcRenderer.invoke('cli:mark-first-run-done')
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
    getStartupCwd: (): Promise<string> => ipcRenderer.invoke('app:get-startup-cwd'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),
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
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url)
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
  notify: {
    show: (payload: { id: string; title: string; body?: string }): Promise<void> =>
      ipcRenderer.invoke('notify:show', payload),
    onFocusSession: (callback: (msg: { id: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { id: string }): void => callback(msg)
      ipcRenderer.on('notify:focus-session', listener)
      return () => ipcRenderer.removeListener('notify:focus-session', listener)
    }
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
