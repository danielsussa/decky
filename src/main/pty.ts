import { ipcMain, BrowserWindow } from 'electron'
import {
  createPty,
  killAllPtys,
  killPty,
  loginShellPath,
  resizePty,
  setPtyManagerEvents,
  writePty,
  type CreatePtyArgs
} from '@decky/server'
import { startSessionHandoffBackend, stopSessionHandoffBackend } from './handoff-backend'

// Re-exports usados por outros módulos do main (dev-rebuild, index.ts).
export { loginShellPath, killAllPtys }

// IPC bridge — toda a lógica de PTY (multiplexer, recovery, env building) vive em
// @decky/server/pty-manager. Aqui só:
//   1. Injeta callbacks que adapter eventos do manager pra webContents.send (renderer).
//   2. Liga onHandoffStart/Stop ao handoff-backend.ts (que ainda mora aqui porque depende
//      de WebContents — vai pro server quando virar browser-manager).
//   3. Registra os ipcMain.handle/on que delegam pros métodos puros do server.

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  setPtyManagerEvents({
    onData(id, data) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data })
    },
    onExit(id, code) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, code })
    },
    onUuidConflict(id) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('session:uuid-conflict', { id })
    },
    onHandoffStart(id) {
      if (process.env.DECKY_NO_HANDOFF) return
      try {
        startSessionHandoffBackend(id)
      } catch (e) {
        console.error(`[handoff] session=${id} failed to start backend:`, e)
      }
    },
    onHandoffStop(id) {
      void stopSessionHandoffBackend(id).catch((e) =>
        console.error(`[handoff] session=${id} stop failed:`, e)
      )
    }
  })

  ipcMain.handle('pty:create', (_e, args: CreatePtyArgs) => createPty(args))
  ipcMain.on('pty:write', (_e, args: { id: string; data: string }) => writePty(args.id, args.data))
  ipcMain.on('pty:kill', (_e, args: { id: string }) => killPty(args.id))
  ipcMain.on('pty:resize', (_e, args: { id: string; cols: number; rows: number }) =>
    resizePty(args.id, args.cols, args.rows)
  )
}
