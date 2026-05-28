import { ElectronAPI } from '@electron-toolkit/preload'
import type { PreviewSource } from '../shared/preview'

export type { PreviewSource }

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
      byCard: Record<string, Record<string, PreviewSource>>
    ) => Promise<Record<string, Record<string, PreviewSource>>>
    onSourceChange: (
      callback: (msg: { sessionId: string; cardId: string | null; source: PreviewSource }) => void
    ) => () => void
  }
  workspace: {
    read: <T = unknown>(cwd: string) => Promise<T | null>
    write: (cwd: string, state: unknown) => Promise<true>
  }
  file: {
    watch: (path: string) => Promise<true>
    unwatch: (path: string) => Promise<true>
    readText: (path: string) => Promise<string | null>
    write: (path: string, content: string) => Promise<boolean>
    onChanged: (callback: (msg: { path: string }) => void) => () => void
  }
  claude: {
    getBin: () => Promise<string>
    aiTitle: (cwd: string, uuid: string) => Promise<string | null>
  }
  sessions: {
    getTitles: () => Promise<Record<string, string>>
    onTitleChange: (callback: (msg: { id: string; title: string }) => void) => () => void
    onAdd: (
      callback: (msg: { cwd: string; kind: 'claude' | 'shell' }) => void
    ) => () => void
    onUuidConflict: (callback: (msg: { id: string }) => void) => () => void
  }
  app: {
    getStartupCwd: () => Promise<string>
    onMenuNewSession: (callback: () => void) => () => void
    onMenuCloseTab: (callback: () => void) => () => void
  }
  state: {
    get: <T = unknown>(key: string) => Promise<T | null>
    set: (key: string, value: unknown) => Promise<true>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    deck: DeckAPI
  }
}
