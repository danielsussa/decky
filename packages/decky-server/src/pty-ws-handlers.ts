import {
  createPty,
  killPty,
  resizePty,
  setPtyManagerEvents,
  writePty,
  type CreatePtyArgs
} from './pty-manager'
import type { DeckyWsServer } from './ws-server'

// Bloco 2 — pty sobre WS. No decky-server headless, o terminal de uma sessão roda NO host do
// server (via pty-manager) e streama pro client por broadcast WS. É o espelho do que o main
// local faz com webContents.send (src/main/pty.ts): mesmo pty-manager, transporte diferente.
// Sem handoff backend aqui (depende de WebContents — Electron-only).
//
// O client (preload) manda pty:create via wsInvoke (espera reply) e pty:write/kill/resize via
// wsSend (fire-and-forget). Output volta como broadcast pty:data / pty:exit, carregando o id da
// sessão pro renderer rotear.

export function registerPtyWsHandlers(ws: DeckyWsServer): void {
  setPtyManagerEvents({
    onData(id, data) {
      ws.broadcast('pty:data', { id, data })
    },
    onExit(id, code) {
      ws.broadcast('pty:exit', { id, code })
    },
    onUuidConflict(id) {
      ws.broadcast('session:uuid-conflict', { id })
    }
  })

  ws.handle<CreatePtyArgs, void>('pty:create', (args) => createPty(args))
  ws.handle<{ id: string; data: string }, void>('pty:write', (args) => {
    writePty(args.id, args.data)
  })
  ws.handle<{ id: string }, void>('pty:kill', (args) => {
    killPty(args.id)
  })
  ws.handle<{ id: string; cols: number; rows: number }, void>('pty:resize', (args) => {
    resizePty(args.id, args.cols, args.rows)
  })
}
