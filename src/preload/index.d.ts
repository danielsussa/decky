import { ElectronAPI } from '@electron-toolkit/preload'

export type PtyDataMsg = { id: string; data: string }
export type PtyExitMsg = { id: string; code: number }

export interface DeckAPI {
  pty: {
    create: (
      id: string,
      opts: { cwd?: string; cols: number; rows: number; shell?: string }
    ) => Promise<void>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    onData: (callback: (msg: PtyDataMsg) => void) => () => void
    onExit: (callback: (msg: PtyExitMsg) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    deck: DeckAPI
  }
}
