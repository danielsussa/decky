#!/usr/bin/env node
import {
  closeHistoryDb,
  ensureToken,
  generateAndSaveToken,
  openHistoryDb,
  readSavedToken,
  registerCliWsHandlers,
  registerGitWsHandlers,
  registerHistoryWsHandlers,
  registerPtyWsHandlers,
  registerStateWsHandlers,
  registerTagsIndexWsHandlers,
  registerWorkspaceWsHandlers,
  serverDir,
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

  // Auth: gera token se ainda não existe. Em loopback puro (127.0.0.1) faz pouca diferença,
  // mas o protocolo já aceita pra quando o host virar 0.0.0.0 ou tailscale.
  const token = ensureToken()
  console.log(`[decky-server] auth token at ${serverDir()}/admin-token.txt`)

  // History DB: best-effort. Sem DB o server ainda sobe; só history:* falham.
  try {
    openHistoryDb()
    console.log('[decky-server] history db opened')
  } catch (err) {
    console.warn('[decky-server] history db failed to open:', err)
  }

  let ws: DeckyWsServer
  try {
    ws = await startWsServer({ host: DEFAULT_HOST, port: DEFAULT_PORT, token })
  } catch (err) {
    console.error('[decky-server] failed to start WS server:', err)
    process.exit(1)
  }
  console.log(`[decky-server] WS listening at ${ws.url}`)
  console.log(`[decky-server] connect with: ${ws.url}?token=${token}`)

  registerCliWsHandlers(ws)
  registerStateWsHandlers(ws)
  registerGitWsHandlers(ws)
  registerWorkspaceWsHandlers(ws)
  registerTagsIndexWsHandlers(ws)
  registerHistoryWsHandlers(ws)
  registerPtyWsHandlers(ws)
  console.log(
    '[decky-server] handlers registered (cli, state, git, workspace, tagsIndex, history, pty)'
  )
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

function initCmd(): void {
  const existing = readSavedToken()
  if (existing) {
    console.log(`token já existe em ${serverDir()}/admin-token.txt`)
    console.log(`(use "decky-server token rotate" pra gerar novo — TODO)`)
    return
  }
  const t = generateAndSaveToken()
  console.log(`✓ token gerado: ${t}`)
  console.log(`  salvo em ${serverDir()}/admin-token.txt (mode 600)`)
}

function tokenCmd(): void {
  const t = readSavedToken()
  if (!t) {
    console.log('nenhum token gerado ainda. Rode `decky-server init` primeiro.')
    return
  }
  console.log(t)
}

function printHelp(): void {
  console.log(`decky-server — engine headless do decky client.

USO:
  decky-server [comando]

COMANDOS:
  start (default)    inicia o server
  init               gera o token bearer se ainda não existe
  token              imprime o token atual
  help               mostra esta ajuda

ENV:
  DECKY_SERVER_HOST  host pra bind (default: 127.0.0.1 — loopback)
  DECKY_SERVER_PORT  porta (default: 8447)
  DECKY_SERVER_DIR   diretório de config (default: ~/.decky-server)

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
    case 'init':
      initCmd()
      break
    case 'token':
      tokenCmd()
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
