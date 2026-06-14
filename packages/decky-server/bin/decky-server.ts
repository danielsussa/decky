#!/usr/bin/env node
import {
  closeHistoryDb,
  openHistoryDb,
  registerCliWsHandlers,
  registerGitWsHandlers,
  registerHistoryWsHandlers,
  registerStateWsHandlers,
  registerTagsIndexWsHandlers,
  registerWorkspaceWsHandlers,
  startWsServer,
  type DeckyWsServer
} from '../src/index'

// Entry CLI do decky-server standalone. Sobe o WS server e registra os handlers que JÁ vivem
// em @decky/server e não dependem de Electron. Funcionalidades Electron-only (web-views, pty
// com handoff backend, dialogs, notifications, dev-rebuild) ficam fora desta versão headless
// — vêm nas próximas PRs (browser-manager com Playwright, etc).

const DEFAULT_PORT = Number(process.env.DECKY_SERVER_PORT) || 8447
const DEFAULT_HOST = process.env.DECKY_SERVER_HOST || '127.0.0.1'

async function start(): Promise<void> {
  console.log('[decky-server] starting…')

  // History DB: best-effort. Sem DB o server ainda sobe; só history:* falham.
  try {
    openHistoryDb()
    console.log('[decky-server] history db opened')
  } catch (err) {
    console.warn('[decky-server] history db failed to open:', err)
  }

  let ws: DeckyWsServer
  try {
    ws = await startWsServer({ host: DEFAULT_HOST, port: DEFAULT_PORT })
  } catch (err) {
    console.error('[decky-server] failed to start WS server:', err)
    process.exit(1)
  }
  console.log(`[decky-server] WS listening at ${ws.url}`)

  registerCliWsHandlers(ws)
  registerStateWsHandlers(ws)
  registerGitWsHandlers(ws)
  registerWorkspaceWsHandlers(ws)
  registerTagsIndexWsHandlers(ws)
  registerHistoryWsHandlers(ws)
  console.log('[decky-server] handlers registered (cli, state, git, workspace, tagsIndex, history)')
  console.log('[decky-server] ready — Ctrl+C para encerrar')

  let shuttingDown = false
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n[decky-server] received ${sig}, shutting down…`)
    try {
      await ws.close()
    } catch (err) {
      console.error('[decky-server] ws close failed:', err)
    }
    try {
      closeHistoryDb()
    } catch (err) {
      console.error('[decky-server] history close failed:', err)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

function printHelp(): void {
  console.log(`decky-server — engine headless do decky client.

USO:
  decky-server [comando]

COMANDOS:
  start (default)    inicia o server
  help               mostra esta ajuda

ENV:
  DECKY_SERVER_HOST  host pra bind (default: 127.0.0.1 — loopback)
  DECKY_SERVER_PORT  porta (default: 8447)

EXEMPLOS:
  decky-server                              # roda em loopback
  DECKY_SERVER_HOST=0.0.0.0 decky-server    # escuta em todas as interfaces
                                              (pra produção, ponha TLS proxy na frente)
`)
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || 'start'
  switch (cmd) {
    case 'start':
      await start()
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      console.error(`unknown command: ${cmd}\n`)
      printHelp()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('[decky-server] fatal:', err)
  process.exit(1)
})
