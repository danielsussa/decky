import { readdir, stat } from 'node:fs/promises'
import { hostname, homedir, platform } from 'node:os'
import { join } from 'node:path'
import { workspaceCardsDir } from '@decky/shared/node'
import { applyCardsStateSync, applyPreviewResolved, type MirrorSession } from './card-mirror'
import { searchCards } from './cards-search'
import { approvePending, listAll, rejectPending, revokeDevice } from './devices'
import { deleteCard, listCards, writeCard } from './cards-store'
import { computeBacklinks, resolveWikilink } from './cards-wikilinks'
import { readAiTitle, resolveClaudeBin } from './claude-bin'
import { readTextFile, writeBinaryFileBase64, writeTextFile } from './file-ops'
import { getSessionTitles } from './preview-state'
import type { DeckyWsServer } from './ws-server'

// Handlers WS que antes viviam só em src/main (Electron). Migrados aqui pra que o decky-server
// standalone também responda — sem isso, engines remotos quebravam quando o renderer chamava
// cards.list / claude.aiTitle / file.readText / etc. no workspace deles.
//
// Cada `register*` agrupa um domínio coerente. Tanto o standalone (bin/decky-server.ts) quanto
// o shim Electron (src/main/index.ts) chamam as mesmas funções, garantindo paridade.

export function registerClaudeWsHandlers(ws: DeckyWsServer): void {
  ws.handle<void, string>('claude:get-bin', () => resolveClaudeBin())
  ws.handle<{ cwd: string; uuid: string }, string | null>('claude:ai-title', (args) =>
    readAiTitle(args?.cwd ?? '', args?.uuid ?? '')
  )
}

export function registerCardsCoreWsHandlers(ws: DeckyWsServer): void {
  ws.handle<
    { workspace: string; cardId: string; content: string; ext?: '.md' | '.html' },
    string | null
  >('cards:write', (args) =>
    writeCard(args?.workspace ?? '', args?.cardId ?? '', args?.content ?? '', args?.ext ?? '.md')
  )
  ws.handle<{ workspace: string }, Awaited<ReturnType<typeof listCards>>>('cards:list', (args) =>
    listCards(args?.workspace ?? '')
  )
  ws.handle<{ workspace: string; cardId: string }, boolean>('cards:delete', (args) =>
    deleteCard(args?.workspace ?? '', args?.cardId ?? '')
  )
}

export function registerCardsExtraWsHandlers(ws: DeckyWsServer): void {
  ws.handle<{ workspace: string; query: string; limit?: number }, unknown>(
    'cards:search',
    (args) =>
      searchCards(
        workspaceCardsDir(args?.workspace ?? ''),
        args?.query ?? '',
        typeof args?.limit === 'number' ? args.limit : 20,
        'html'
      )
  )
  ws.handle<{ workspace: string; name: string }, string | null>('cards:resolve-wikilink', (args) =>
    resolveWikilink(workspaceCardsDir(args?.workspace ?? ''), args?.name ?? '')
  )
  ws.handle<{ workspace: string; cardPath: string }, unknown>('cards:backlinks', (args) =>
    computeBacklinks(workspaceCardsDir(args?.workspace ?? ''), args?.cardPath ?? '')
  )
}

export function registerCardMirrorWsHandlers(ws: DeckyWsServer): void {
  ws.handle<{ sessions: Record<string, MirrorSession> }, void>('cards:state-sync', (payload) =>
    applyCardsStateSync(payload)
  )
  ws.handle<{ reqId?: string; cardId?: string; path?: string; title?: string }, void>(
    'preview:resolved',
    (payload) => applyPreviewResolved(payload)
  )
}

export function registerSessionsWsHandlers(ws: DeckyWsServer): void {
  ws.handle<void, Record<string, string>>('sessions:get-titles', () => getSessionTitles())
}

// Info estático do host — usado pelo PWA pra mostrar contexto (que máquina, que home dir) e
// sugerir defaults de cwd. Sem state persistente, é a única forma de saber qual o user/home
// do server.
export function registerServerInfoWsHandlers(ws: DeckyWsServer): void {
  ws.handle<void, { home: string; hostname: string; platform: string }>('server:info', () => ({
    home: homedir(),
    hostname: hostname(),
    platform: platform()
  }))
  // Detecta workspaces "naturais" via `find`-light no $HOME: subdirs que contêm `.decky/cards`.
  // Limita depth pra evitar varredura ilimitada — só procura sob $HOME até 4 níveis.
  ws.handle<void, string[]>('server:list-workspaces', async () => {
    const home = homedir()
    const out: string[] = []
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 4) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      // Se este dir tem `.decky/cards`, é um workspace — registra e PARA de recursar (evita
      // listar pastas filhas dentro de um workspace).
      const hasDecky = entries.some((e) => e.isDirectory() && e.name === '.decky')
      if (hasDecky) {
        try {
          await stat(join(dir, '.decky', 'cards'))
          out.push(dir)
          return
        } catch {
          // .decky existe mas sem cards/ → não é workspace, continua descendo
        }
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue // pula .git, .cache etc
        if (e.name === 'node_modules') continue
        await walk(join(dir, e.name), depth + 1)
      }
    }
    await walk(home, 0)
    return out
  })
}

// Devices: admin do pairing flow. Esses handlers exigem o caller estar autenticado (qualquer
// device aprovado pode aprovar/revogar outros — modelo simples; quando virar multi-user pra
// valer, vira RBAC). Listagem é segura sem auth pra debug, mas o WS upgrade já bloqueia.
export function registerDevicesWsHandlers(ws: DeckyWsServer): void {
  ws.handle<void, unknown>('devices:list', () => listAll())
  ws.handle<{ pendingId: string; name?: string }, boolean>(
    'devices:approve',
    async (args) => (await approvePending(args?.pendingId ?? '', args?.name)) !== null
  )
  ws.handle<{ pendingId: string }, boolean>('devices:reject', (args) =>
    rejectPending(args?.pendingId ?? '')
  )
  ws.handle<{ deviceId: string }, boolean>('devices:revoke', (args) =>
    revokeDevice(args?.deviceId ?? '')
  )
}

// file:* básico — read/write apenas. file:watch fica de fora do standalone por enquanto:
// depende de broadcast inverso (chokidar → ws.broadcast 'file:changed') que não está cabeado
// no standalone, e o renderer já trata file:watch como best-effort no engine local.
export function registerFileWsHandlers(ws: DeckyWsServer): void {
  ws.handle<{ path: string }, string | null>('file:read-text', (args) =>
    readTextFile(args?.path ?? '')
  )
  ws.handle<{ path: string; content: string }, boolean>('file:write', (args) =>
    writeTextFile(args?.path ?? '', args?.content ?? '')
  )
  // Binary write via base64 — usado pra paste de imagem em sessão remota (Terminal.tsx detecta
  // image no clipboard, encode base64 e sobe pra /tmp/decky-paste-X.png no host do engine).
  ws.handle<{ path: string; base64: string }, boolean>('file:write-binary-base64', (args) =>
    writeBinaryFileBase64(args?.path ?? '', args?.base64 ?? '')
  )
}
