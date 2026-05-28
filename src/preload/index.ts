import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { PreviewSource } from '../shared/preview'

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
      byCard: Record<string, Record<string, PreviewSource>>
    ): Promise<Record<string, Record<string, PreviewSource>>> =>
      ipcRenderer.invoke('preview:rehydrate', byCard),
    onSourceChange: (
      callback: (msg: { sessionId: string; cardId: string | null; source: PreviewSource }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: { sessionId: string; cardId: string | null; source: PreviewSource }
      ): void => callback(msg)
      ipcRenderer.on('preview:source-changed', listener)
      return () => ipcRenderer.removeListener('preview:source-changed', listener)
    }
  },
  workspace: {
    read: <T = unknown,>(cwd: string): Promise<T | null> =>
      ipcRenderer.invoke('workspace:read', cwd),
    write: (cwd: string, state: unknown): Promise<true> =>
      ipcRenderer.invoke('workspace:write', cwd, state)
  },
  file: {
    watch: (path: string): Promise<true> => ipcRenderer.invoke('file:watch', path),
    unwatch: (path: string): Promise<true> => ipcRenderer.invoke('file:unwatch', path),
    readText: (path: string): Promise<string | null> =>
      ipcRenderer.invoke('file:read-text', path),
    write: (path: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('file:write', path, content),
    onChanged: (callback: (msg: { path: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { path: string }): void => callback(msg)
      ipcRenderer.on('file:changed', listener)
      return () => ipcRenderer.removeListener('file:changed', listener)
    }
  },
  claude: {
    getBin: (): Promise<string> => ipcRenderer.invoke('claude:get-bin')
  },
  sessions: {
    getTitles: (): Promise<Record<string, string>> => ipcRenderer.invoke('sessions:get-titles'),
    onTitleChange: (callback: (msg: { id: string; title: string }) => void): (() => void) => {
      const listener = (_: unknown, msg: { id: string; title: string }): void => callback(msg)
      ipcRenderer.on('session:title-changed', listener)
      return () => ipcRenderer.removeListener('session:title-changed', listener)
    },
    onAdd: (
      callback: (msg: { cwd: string; kind: 'claude' | 'shell' }) => void
    ): (() => void) => {
      const listener = (
        _: unknown,
        msg: { cwd: string; kind: 'claude' | 'shell' }
      ): void => callback(msg)
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
    onMenuNewSession: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:new-session', listener)
      return () => ipcRenderer.removeListener('menu:new-session', listener)
    },
    onMenuCloseTab: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('menu:close-tab', listener)
      return () => ipcRenderer.removeListener('menu:close-tab', listener)
    }
  },
  state: {
    get: <T = unknown,>(key: string): Promise<T | null> => ipcRenderer.invoke('state:get', key),
    set: (key: string, value: unknown): Promise<true> =>
      ipcRenderer.invoke('state:set', key, value)
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
