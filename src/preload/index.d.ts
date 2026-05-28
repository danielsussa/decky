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
    getCurrent: () => Promise<PreviewSource>
    onSourceChange: (callback: (source: PreviewSource) => void) => () => void
  }
  claude: {
    getBin: () => Promise<string>
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
