import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { workspaceCardsDir } from '@decky/shared/node'
import type { PreviewSource } from '@decky/shared'
import { computeBacklinks } from './cards-wikilinks'
import { searchCards } from './cards-search'
import { getAllCards, getCardsForSession } from './card-mirror'
import {
  awaitFormOutcome,
  cancelFormOutcome,
  clearPreviewSource,
  getPreviewSource,
  getPreviewSources,
  isFormPending,
  normalizePreviewSource,
  parkPreviewAndAwait,
  submitFormOutcome
} from './preview-state'
import { awaitWidgetCall } from './widget-bridge'
import type { DeckyWsServer } from './ws-server'

// Standalone preview-server pro decky-server headless (PI/cloud). Atende o protocolo HTTP que
// dk-mcp e cards usam pra `preview_*`, busca, formulários e RPC de widgets. Espelho cirúrgico
// do src/main/preview-server.ts (Electron), mas:
//   - sem BrowserWindow/webContents: broadcasts vão SÓ via DeckyWsServer (clients PWA/Electron
//     se inscrevem via WS, então recebem por lá);
//   - rotas /web/act retornam 501 ("web-control não disponível neste host") — browser-control
//     Electron-only por enquanto;
//   - widgets se inscrevem como clients WS, então widget:call broadcast já chega via WS.
//
// Pra integrar no Electron, src/main/preview-server.ts continua existindo separado e adiciona
// o broadcast via webContents.send (DOM renderer local não tem WS pro engine local).

const GLOBAL_KEY = 'global'

function broadcastPreview(
  ws: DeckyWsServer | null,
  sessionId: string,
  cardId: string | null,
  source: PreviewSource,
  reqId?: string
): void {
  ws?.broadcast('preview:source-changed', { sessionId, cardId, source, reqId })
}

function cardIdFrom(req: IncomingMessage): string | null {
  const raw = req.headers['x-deck-card-id']
  const id = Array.isArray(raw) ? raw[0] : raw
  return id && id.length > 0 ? id : null
}

function sessionIdFrom(req: IncomingMessage): string {
  const raw = req.headers['x-deck-session-id']
  const id = Array.isArray(raw) ? raw[0] : raw
  return id && id.length > 0 ? id : GLOBAL_KEY
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getWsServer: () => DeckyWsServer | null
): Promise<void> {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, x-deck-session-id, x-deck-card-id')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = req.url || '/'
  const sessionId = sessionIdFrom(req)
  const cardId = cardIdFrom(req)

  if (req.method === 'GET' && url === '/preview') {
    sendJson(res, 200, getPreviewSource(sessionId) ?? { type: 'none' })
    return
  }
  if (req.method === 'GET' && url === '/preview/all') {
    sendJson(res, 200, getPreviewSources())
    return
  }
  if (req.method === 'POST' && url === '/preview') {
    try {
      const raw = await readBody(req)
      const wire = JSON.parse(raw)
      const source = await normalizePreviewSource(wire)
      const resolved = await parkPreviewAndAwait(
        (sId, cId, src, rId) => broadcastPreview(getWsServer(), sId, cId, src, rId),
        sessionId,
        cardId,
        source
      )
      sendJson(res, 200, {
        source,
        cardId: resolved.cardId || cardId || '',
        path: resolved.path,
        title: resolved.title
      })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'POST' && url === '/preview/clear') {
    const cleared = clearPreviewSource(sessionId)
    broadcastPreview(getWsServer(), sessionId, cardId, cleared)
    sendJson(res, 200, cleared)
    return
  }

  const cardsMatch = req.method === 'GET' && /^\/sessions\/([^/]+)\/cards\/?$/.exec(url)
  if (cardsMatch) {
    const id = decodeURIComponent(cardsMatch[1])
    sendJson(res, 200, getCardsForSession(id))
    return
  }
  if (req.method === 'GET' && url === '/sessions/cards') {
    sendJson(res, 200, getAllCards())
    return
  }

  if (req.method === 'POST' && url === '/cards/search') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { query?: unknown; limit?: unknown }
      const query = typeof body.query === 'string' ? body.query : ''
      const limit = typeof body.limit === 'number' ? body.limit : 20
      const mirror = getCardsForSession(sessionId)
      if (!mirror.cwd) {
        sendJson(res, 400, {
          error: 'no workspace known for this session — open a card in the workspace first'
        })
        return
      }
      const hits = await searchCards(workspaceCardsDir(mirror.cwd), query, limit)
      sendJson(res, 200, { hits })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'POST' && url === '/cards/backlinks') {
    try {
      const raw = await readBody(req)
      const body = raw ? (JSON.parse(raw) as { cardPath?: unknown }) : {}
      const mirror = getCardsForSession(sessionId)
      if (!mirror.cwd) {
        sendJson(res, 400, { error: 'no workspace known for this session' })
        return
      }
      let cardPath = typeof body.cardPath === 'string' ? body.cardPath : ''
      if (!cardPath) {
        const focused = mirror.cards.find((c) => c.id === mirror.focused)
        if (focused && focused.type === 'markdown' && focused.path) cardPath = focused.path
      }
      if (!cardPath) {
        sendJson(res, 400, {
          error: 'no cardPath given and no focused markdown card in this session'
        })
        return
      }
      const hits = await computeBacklinks(workspaceCardsDir(mirror.cwd), cardPath)
      sendJson(res, 200, { cardPath, hits })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, pid: process.pid })
    return
  }

  // /web/act: browser-control via WebContentsView. Não disponível em standalone — o handoff
  // separado já dirige browsers via Playwright (sem decky). Retorna 501 explicitamente pra
  // dk-mcp surfacing o erro em vez de hang.
  if (req.method === 'POST' && url === '/web/act') {
    sendJson(res, 501, {
      error: 'browser_* tools require Electron host (use handoff CLI instead)'
    })
    return
  }

  // Form long-poll: prompt_form usa pra parar até user submeter no renderer.
  if (req.method === 'POST' && url === '/form/await') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { formId?: unknown; timeoutMs?: unknown }
      if (typeof body.formId !== 'string' || body.formId.length === 0) {
        sendJson(res, 400, { error: 'formId required' })
        return
      }
      if (isFormPending(body.formId)) {
        sendJson(res, 409, { error: 'already awaiting this formId' })
        return
      }
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 10 * 60 * 1000
      const outcome = await awaitFormOutcome(body.formId, timeoutMs)
      sendJson(res, 200, outcome)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'POST' && url === '/form/submit') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { formId?: unknown; values?: unknown }
      if (typeof body.formId !== 'string') {
        sendJson(res, 400, { error: 'formId required' })
        return
      }
      const values =
        body.values && typeof body.values === 'object'
          ? (body.values as Record<string, string | boolean>)
          : {}
      const ok = submitFormOutcome(body.formId, values)
      if (!ok) {
        sendJson(res, 404, { error: 'no form awaiting this id (timed out or already resolved)' })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }
  if (req.method === 'POST' && url === '/form/cancel') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { formId?: unknown }
      if (typeof body.formId !== 'string') {
        sendJson(res, 400, { error: 'formId required' })
        return
      }
      const cancelled = cancelFormOutcome(body.formId)
      sendJson(res, 200, cancelled ? { ok: true } : { ok: true, alreadyResolved: true })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // Widget RPC — sem IPC consumer no standalone (sem Electron). awaitWidgetCall já lida com
  // o fallback "só WS broadcast" quando hasIpcConsumer=false. Clientes WS (renderer Electron
  // ou PWA com widget) recebem widget:call e respondem via widget:call-reply.
  if (req.method === 'GET' && url === '/widgets/list') {
    const outcome = await awaitWidgetCall(
      {
        getWsServer,
        emitIpc: () => {},
        hasIpcConsumer: () => false
      },
      { kind: 'list' }
    )
    if (outcome.error) {
      sendJson(res, 502, { error: outcome.error })
      return
    }
    sendJson(res, 200, { result: outcome.result })
    return
  }
  if (req.method === 'POST' && (url === '/widget/invoke' || url === '/widget/get')) {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as {
        cardId?: unknown
        widgetId?: unknown
        op?: unknown
        args?: unknown
        key?: unknown
      }
      if (typeof body.cardId !== 'string' || !body.cardId) {
        sendJson(res, 400, { error: 'cardId required' })
        return
      }
      if (typeof body.widgetId !== 'string' || !body.widgetId) {
        sendJson(res, 400, { error: 'widgetId required' })
        return
      }
      const isInvoke = url === '/widget/invoke'
      if (isInvoke && typeof body.op !== 'string') {
        sendJson(res, 400, { error: 'op required for /widget/invoke' })
        return
      }
      if (!isInvoke && typeof body.key !== 'string') {
        sendJson(res, 400, { error: 'key required for /widget/get' })
        return
      }
      const outcome = await awaitWidgetCall(
        { getWsServer, emitIpc: () => {}, hasIpcConsumer: () => false },
        {
          kind: isInvoke ? 'invoke' : 'get',
          cardId: body.cardId,
          widgetId: body.widgetId,
          op: isInvoke ? (body.op as string) : undefined,
          args: isInvoke ? body.args : undefined,
          key: isInvoke ? undefined : (body.key as string)
        }
      )
      if (outcome.error) {
        sendJson(res, 502, { error: outcome.error })
        return
      }
      sendJson(res, 200, { result: outcome.result })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // POST /workspace — pede ao renderer pra abrir nova sessão. No standalone, broadcast WS;
  // clientes (Electron renderer ou PWA) escutam session:add e abrem.
  if (req.method === 'POST' && url === '/workspace') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { cwd?: unknown; kind?: unknown }
      if (typeof body.cwd !== 'string' || body.cwd.length === 0) {
        sendJson(res, 400, { error: 'cwd must be a non-empty string' })
        return
      }
      const kind = body.kind === 'shell' ? 'shell' : 'claude'
      try {
        const s = await stat(body.cwd)
        if (!s.isDirectory()) {
          sendJson(res, 400, { error: `not a directory: ${body.cwd}` })
          return
        }
      } catch {
        sendJson(res, 400, { error: `path not accessible: ${body.cwd}` })
        return
      }
      getWsServer()?.broadcast('session:add', { cwd: body.cwd, kind })
      sendJson(res, 200, { ok: true, cwd: body.cwd, kind })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

let server: Server | null = null

export interface StandalonePreviewServerOpts {
  /** Default 6790 (env DECKY_PREVIEW_PORT). */
  port?: number
  /** Default '127.0.0.1' — só processos no host (dk-mcp do claude rodando aqui) batem. */
  host?: string
}

export function startStandalonePreviewServer(
  getWsServer: () => DeckyWsServer | null,
  opts: StandalonePreviewServerOpts = {}
): { url: string; port: number } {
  const port = opts.port ?? Number(process.env.DECKY_PREVIEW_PORT) ?? 6790
  const host = opts.host ?? '127.0.0.1'
  server = createServer((req, res) => {
    handleRequest(req, res, getWsServer).catch((err) => {
      console.error('[preview-server] handler error:', err)
      try {
        sendJson(res, 500, { error: String(err) })
      } catch {
        // already responded
      }
    })
  })
  server.listen(port, host, () => {
    console.log(`[preview-server] listening on http://${host}:${port}`)
  })
  server.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `[preview-server] port ${port} in use — preview_* / form / widget RPC won't work`
      )
      return
    }
    console.error('[preview-server] server error:', err)
  })
  return { url: `http://${host}:${port}`, port }
}

export function stopStandalonePreviewServer(): void {
  server?.close()
  server = null
}
