import { ipcMain, BrowserWindow } from 'electron'
import {
  createPty,
  killAllPtys,
  killPty,
  loginShellPath,
  resizePty,
  setPtyManagerEvents,
  setSessionTitle,
  writePty,
  type CreatePtyArgs,
  type DeckyWsServer
} from '@decky/server'
import { broadcastSessionTitle, broadcastSessionRunning } from './preview-server'

// Re-exports usados por outros módulos do main (dev-rebuild, index.ts).
export { loginShellPath, killAllPtys }

// IPC bridge — toda a lógica de PTY (multiplexer, recovery, env building) vive em
// @decky/server/pty-manager. Aqui só:
//   1. Injeta callbacks que adapter eventos do manager pra webContents.send (renderer).
//   2. Registra os ipcMain.handle/on que delegam pros métodos puros do server.

export function registerPtyHandlers(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): void {
  setPtyManagerEvents({
    onData(id, data) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('pty:data', { id, data })
    },
    onExit(id, code) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('pty:exit', { id, code })
    },
    onClaude(id, info) {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('pty:claude', { id, ...info })
    },
    // Título da aba vindo do .jsonl da conversa: aiTitle do claude, ou o 1º prompt como fallback
    // (versões antigas do claude não geram aiTitle — ver syncAiTitle). Fonte única de nome de sessão.
    // Persiste no sessionTitles (o gate/tabs leem dele) + broadcast pro renderer pintar a aba na hora.
    onTitle(id, title) {
      setSessionTitle(id, title)
      broadcastSessionTitle(getWindow, getWsServer, id, title)
    },
    // Comando em foreground (npm run dev…) → sufixo da aba. Estado transitório (não persiste em
    // sessionTitles): some quando o processo termina. Broadcast win + ws (web também renderiza abas).
    onRunning(id, cmd) {
      broadcastSessionRunning(getWindow, getWsServer, id, cmd)
    }
  })

  ipcMain.handle('pty:create', (_e, args: CreatePtyArgs) => createPty(args))
  ipcMain.on('pty:write', (_e, args: { id: string; data: string }) => writePty(args.id, args.data))
  ipcMain.on('pty:kill', (_e, args: { id: string }) => killPty(args.id))
  ipcMain.on('pty:resize', (_e, args: { id: string; cols: number; rows: number }) =>
    resizePty(args.id, args.cols, args.rows)
  )
}
