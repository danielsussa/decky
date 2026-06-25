import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { stat } from 'node:fs/promises'
import { BrowserWindow, type WebContents } from 'electron'
import type { PreviewSource } from '@decky/shared'
import { workspaceCardsDir } from '@decky/shared/node'
import {
  awaitFormOutcome,
  awaitWidgetCall,
  cancelFormOutcome,
  clearPreviewSource,
  computeBacklinks,
  getAllCards,
  getCardsForSession,
  getPreviewSource,
  getPreviewSources,
  isFormPending,
  normalizePreviewSource,
  parkPreviewAndAwait,
  searchCards,
  submitFormOutcome,
  type DeckyWsServer
} from '@decky/server'
import { getWebViewsManager } from './web-views'
import { trackActivityEnd, trackActivityStart } from './handoff-activity'
import {
  clickJs,
  clickLabel,
  READ_JS,
  scrollJs,
  settle,
  SNAPSHOT_JS,
  typeJs,
  waitRequest,
  waitUntil
} from './web/facilitators'
import { navigateResilient } from './web/blockwall'
import { waitForNotCaptcha } from './web/captcha'
import { focusForIntervention } from './web/intervene'
import { runDiag } from './web/diag'
import { isStateChanging, nextEventId, readEvents, record, sanitizeArgs } from './web/replay'
import { adapterToolsForUrl, findAdapterTool, makeWebContext } from './web/adapters/registry'

// Toda a STATE (previews/titles/forms) e helpers puros vivem em @decky/server/preview-state.
// Este arquivo hospeda o HTTP server na porta 6790 e a "browser-control layer" (que depende de
// WebContents nativo). Quando o transport virar WS, o HTTP server some e o state segue intacto.

const PORT = Number(process.env.DECKY_PREVIEW_PORT) || 6790
const HOST = '127.0.0.1'
const GLOBAL_KEY = 'global'

// Re-exports usados pelo src/main/index.ts.
export { getPreviewSources, getSessionTitles } from '@decky/server'
export { rehydratePreviews } from '@decky/server'

let server: Server | null = null

function broadcastPreview(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  sessionId: string,
  cardId: string | null,
  source: PreviewSource,
  reqId?: string
): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('preview:source-changed', { sessionId, cardId, source, reqId })
  }
  getWsServer()?.broadcast('preview:source-changed', { sessionId, cardId, source, reqId })
}

export function broadcastSessionTitle(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  id: string,
  title: string
): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:title-changed', { id, title })
  }
  getWsServer()?.broadcast('session:title-changed', { id, title })
}

export function broadcastSessionRunning(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  id: string,
  cmd: string
): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('session:running-changed', { id, cmd })
  }
  getWsServer()?.broadcast('session:running-changed', { id, cmd })
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ── Browser-control layer (agent drives the focused web card) ────────────────
// Snapshot tags visible interactive elements with a sequential `data-mcp-ref` + a stable
// `data-mcp-sid`; click/type address by either. The injected JS + the navigation facilitators
// (settle/wait-until/wait-request/click-label) live in ./web/facilitators. dky-mcp's browser_*
// tools and `decky web …` both POST here.

function normalizeWebUrl(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return s
  if (/^(https?|file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s))
    return `http://${s}`
  if (/^[^\s]+\.[^\s]{2,}/.test(s) && !/\s/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

// Resolve which web card the action targets: an explicit cardId, else the session's focused card
// (if it's a web card), else the single open web card. Throws a guiding error otherwise.
//
// IMPORTANTE: o WebViewsManager é singleton no main process — compartilhado entre sessões
// e workspaces. Sem essa validação, uma sessão A passando um cardId que pertence a sessão B
// (até de outro workspace) dirigia o card de B. /web/act é o único caminho que aceita cardId
// arbitrário; o handoff CLI é cross-session por design (sticky pelo card focado em qualquer
// sessão), mas /web/act vem do MCP que JÁ tem sessionId — então blinda aqui.
function resolveWebCard(
  sessionId: string,
  explicitCardId?: string
): { cardId: string; wc: WebContents } {
  const manager = getWebViewsManager()
  if (!manager) throw new Error('no web views ready — open a web card first')
  const sessionCards = getCardsForSession(sessionId)
  let cardId = explicitCardId
  if (cardId) {
    // cardId explícito: garante que pertence à sessão chamadora.
    const owns = sessionCards.cards.some((c) => c.id === cardId)
    if (!owns) {
      throw new Error(
        `card "${cardId}" não pertence a esta sessão — /web/act só dirige cards da sessão chamadora`
      )
    }
  } else {
    const focused = sessionCards.cards.find((c) => c.id === sessionCards.focused)
    if (focused && focused.type === 'web') cardId = focused.id
    else {
      const webCards = sessionCards.cards.filter((c) => c.type === 'web')
      if (webCards.length === 1) cardId = webCards[0].id
    }
  }
  if (!cardId) throw new Error('no focused web card — open a web card (or pass cardId)')
  const wc = manager.webContentsFor(cardId)
  if (!wc) throw new Error(`no web card with id "${cardId}"`)
  return { cardId, wc }
}

// Um agente dirigindo um web card roda em BACKGROUND em relação ao usuário, que pode estar
// digitando no terminal nesse exato momento. loadURL, o `el.focus()` do typeJs e o `el.click()`
// do clickJs fazem o WebContentsView do card pegar o foco de OS — o cursor some do terminal "do
// nada". rendererHadFocus captura, ANTES da ação, se o renderer (terminal/UI) estava com o foco
// e o card não; returnFocusToRenderer devolve depois. Quando o usuário está de fato no card (wc
// focado) não mexe; focusForIntervention (block/captcha) foca a própria janela, então é
// consistente. Espelha o guard de live-reload em web-views.ts (reload()).
function rendererHadFocus(getWindow: () => BrowserWindow | null, wc: WebContents): boolean {
  const win = getWindow()
  return (
    !!win &&
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    win.webContents.isFocused() &&
    !wc.isFocused()
  )
}

function returnFocusToRenderer(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  if (!win.webContents.isFocused()) win.webContents.focus()
  // win.webContents.focus() devolve o foco de OS pra janela mas não recoloca o <textarea> do xterm;
  // o renderer recoloca no terminal ativo ao receber isto (mesmo guard de web-views.guardLoadFocus).
  win.webContents.send('app:focus-stolen-back')
}

interface WebActBody {
  action?: string
  cardId?: string
  url?: string
  ref?: string
  text?: string
  code?: string
  // scroll: direction ('down'|'up'|'top'|'bottom') + optional per-step pixel amount.
  dir?: string
  amount?: number
  // Facilitators (settle / wait-until / wait-request / click-label).
  expression?: string
  pattern?: string
  method?: string
  label?: string
  strict?: boolean
  index?: number
  timeoutMs?: number
  quietMs?: number
  pollMs?: number
  matchRecentMs?: number
  // navigate: settle after the load (default true).
  settle?: boolean
  // navigate: force a brand-new web card instead of reusing the focused/only web card.
  forceNew?: boolean
  // resilient-navigate (blockwall).
  warmUp?: string
  retries?: number
  backoffMs?: number
  jitterMs?: number
  readyExpr?: string
  // captcha-wait.
  cleanRequired?: number
}

// Open a new web card by broadcasting a `web` preview source — the same path POST /preview uses.
// The renderer creates + focuses the card and mounts its WebContentsView (which navigates to the
// url). Returns the resolved cardId once the renderer acks.
//
// We mint an EXPLICIT fresh card id and pass it through, instead of null. With a null cardId the
// renderer's onSourceChange falls back to the FOCUSED card and overwrites it — so "open a new web
// card" would silently clobber whatever is focused (a markdown card, or an already-open web tab)
// instead of spawning a new tab. An explicit id the session doesn't have yet forces a new tab,
// exactly like the Cmd+click "open in new tab" path does.
async function createWebCard(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  sessionId: string,
  url: string
): Promise<string> {
  const source: PreviewSource = { type: 'web', url }
  const newId = `web-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`
  const resolved = await parkPreviewAndAwait(
    (sId, cId, src, rId) => broadcastPreview(getWindow, getWsServer, sId, cId, src, rId),
    sessionId,
    newId,
    source
  )
  return resolved.cardId
}

// Wraps runWebActionInner with replay logging for state-changing actions (navigate/click/type/…).
// Best-effort: a failed action still records ok:false + error, and replay errors never mask the
// real result. urlBefore is captured pre-action when a card already exists.
async function runWebAction(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  sessionId: string,
  body: WebActBody
): Promise<unknown> {
  const action = body.action ?? ''
  if (!isStateChanging(action)) {
    return runWebActionInner(getWindow, getWsServer, sessionId, body)
  }
  const t0 = Date.now()
  let cardId = body.cardId
  let urlBefore: string | undefined
  try {
    const t = resolveWebCard(sessionId, body.cardId)
    cardId = t.cardId
    urlBefore = t.wc.getURL()
  } catch {
    // no card yet (navigate may create one) — record against the resolved id afterwards
  }
  try {
    const result = (await runWebActionInner(getWindow, getWsServer, sessionId, body)) as {
      cardId?: string
      url?: string
    }
    const rid = result?.cardId || cardId
    if (rid) {
      record(rid, {
        id: nextEventId(),
        ts: Date.now(),
        cmd: action,
        args: sanitizeArgs(action, body as Record<string, unknown>),
        durationMs: Date.now() - t0,
        ok: true,
        urlBefore,
        urlAfter: result?.url
      })
    }
    return result
  } catch (err) {
    if (cardId) {
      record(cardId, {
        id: nextEventId(),
        ts: Date.now(),
        cmd: action,
        args: sanitizeArgs(action, body as Record<string, unknown>),
        durationMs: Date.now() - t0,
        ok: false,
        error: (err as Error).message,
        urlBefore
      })
    }
    throw err
  }
}

async function runWebActionInner(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null,
  sessionId: string,
  body: WebActBody
): Promise<unknown> {
  // navigate is the one action that can run with NO web card open — it opens one. (The agent
  // needs this to start a browsing flow from scratch; the other actions require an existing card.)
  if (body.action === 'navigate') {
    const url = normalizeWebUrl(String(body.url ?? ''))
    // forceNew: open a fresh web card even when one is focused/open (multi-tab). `--card` is
    // about driving a SPECIFIC card, so it's contradictory with forceNew → reject early.
    if (body.forceNew && body.cardId) {
      throw new Error('navigate: cannot combine forceNew with a cardId')
    }
    let target: { cardId: string; wc: WebContents } | null = null
    if (!body.forceNew) {
      try {
        target = resolveWebCard(sessionId, body.cardId)
      } catch {
        target = null
      }
    }
    if (target) {
      // Caminho que dirige um card já aberto — sinaliza atividade pro tracker. Cria card
      // novo NÃO sinaliza (não há controle de algo que ainda não existe).
      const keepFocus = rendererHadFocus(getWindow, target.wc)
      trackActivityStart(target.wc, 'mcp-http:navigate')
      try {
        await target.wc.loadURL(url).catch(() => {})
        // settle por padrão (page-ready) — o agent quase sempre quer agir logo após navegar.
        // Opt-out com settle:false (igual ao --no-wait do handoff).
        const settleResult = body.settle === false ? null : await settle(target.wc)
        return {
          ok: true,
          cardId: target.cardId,
          url: target.wc.getURL(),
          title: target.wc.getTitle(),
          settled: settleResult ? settleResult.settled : undefined
        }
      } finally {
        trackActivityEnd()
        if (keepFocus) returnFocusToRenderer(getWindow)
      }
    }
    // Explicit cardId that doesn't exist is an error; no cardId → open a fresh web card.
    if (body.cardId) throw new Error(`no web card with id "${body.cardId}"`)
    const cardId = await createWebCard(getWindow, getWsServer, sessionId, url)
    return { ok: true, created: true, cardId, url }
  }

  // resilient-navigate: like navigate, but resists anti-bot walls (jitter + warm-up + backoff). Can
  // open a fresh card too. On exhaustion, brings decky to the front so the human can intervene.
  if (body.action === 'resilient-navigate') {
    const url = normalizeWebUrl(String(body.url ?? ''))
    let target: { cardId: string; wc: WebContents } | null = null
    try {
      target = resolveWebCard(sessionId, body.cardId)
    } catch {
      target = null
    }
    let created = false
    if (!target) {
      if (body.cardId) throw new Error(`no web card with id "${body.cardId}"`)
      const newId = await createWebCard(getWindow, getWsServer, sessionId, url)
      target = resolveWebCard(sessionId, newId)
      created = true
    }
    const keepFocus = rendererHadFocus(getWindow, target.wc)
    trackActivityStart(target.wc, 'mcp-http:resilient-navigate')
    try {
      const result = await navigateResilient(target.wc, url, {
        warmUp: body.warmUp,
        retries: body.retries,
        backoffMs: body.backoffMs,
        jitterMs: body.jitterMs,
        readyExpr: body.readyExpr,
        readyTimeoutMs: body.timeoutMs
      })
      if (!result.ok) {
        focusForIntervention(
          getWindow,
          `blocked (${result.blocked?.descriptor}) at ${result.url} after ${result.attempts} attempts`
        )
      }
      return { ...result, cardId: target.cardId, created }
    } finally {
      trackActivityEnd()
      if (keepFocus) returnFocusToRenderer(getWindow)
    }
  }

  const { wc } = resolveWebCard(sessionId, body.cardId)
  // Ações ATIVAS (mutam página ou input) sinalizam atividade → label pulsa + input blocker.
  // PASSIVAS (snapshot/read) só lêem o DOM e não devem atrapalhar quem está digitando nem
  // acender o indicador — Claude frequentemente faz snapshot pra "ver" o estado sem que o
  // usuário tenha pedido pra agir.
  const isActive =
    body.action === 'click' ||
    body.action === 'type' ||
    body.action === 'eval' ||
    body.action === 'scroll' ||
    body.action === 'click-label'
  // Ações ATIVAS focam um elemento da página (typeJs/clickJs) → roubam o foco de OS do terminal.
  const keepFocus = isActive && rendererHadFocus(getWindow, wc)
  if (isActive) trackActivityStart(wc, `mcp-http:${body.action}`)
  try {
    switch (body.action) {
      case 'snapshot':
        return await wc.executeJavaScript(SNAPSHOT_JS)
      case 'read':
        return await wc.executeJavaScript(READ_JS)
      case 'click':
        return await wc.executeJavaScript(clickJs(String(body.ref ?? '')), true)
      case 'type':
        return await wc.executeJavaScript(
          typeJs(String(body.ref ?? ''), String(body.text ?? '')),
          true
        )
      case 'eval':
        return await wc.executeJavaScript(String(body.code ?? ''))
      case 'scroll':
        return await wc.executeJavaScript(
          scrollJs({ ref: body.ref, dir: body.dir, amount: body.amount }),
          true
        )
      // ── Facilitators ──
      case 'settle':
      case 'wait':
        return await settle(wc, { timeoutMs: body.timeoutMs, quietMs: body.quietMs })
      case 'wait-until':
        if (!body.expression) throw new Error('wait-until requires an expression')
        return await waitUntil(wc, body.expression, {
          timeoutMs: body.timeoutMs,
          pollMs: body.pollMs
        })
      case 'wait-request':
        if (!body.pattern) throw new Error('wait-request requires a pattern')
        return await waitRequest(wc, body.pattern, {
          method: body.method,
          timeoutMs: body.timeoutMs,
          matchRecentMs: body.matchRecentMs
        })
      case 'click-label':
        if (!body.label) throw new Error('click-label requires a label pattern')
        return await clickLabel(wc, body.label, { strict: body.strict, index: body.index })
      case 'captcha-wait':
        return await waitForNotCaptcha(wc, {
          timeoutMs: body.timeoutMs,
          pollMs: body.pollMs,
          cleanRequired: body.cleanRequired,
          onChallenge: (desc) =>
            focusForIntervention(getWindow, `captcha detected (${desc}) — solve it in the web card`)
        })
      case 'diag':
        return await runDiag(wc, { url: body.url, settleMs: body.timeoutMs })
      default:
        throw new Error(`unknown web action: ${body.action}`)
    }
  } finally {
    if (isActive) trackActivityEnd()
    if (keepFocus) returnFocusToRenderer(getWindow)
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): Promise<void> {
  // CORS for local dev convenience (only loopback can reach this anyway).
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
        (sId, cId, src, rId) => broadcastPreview(getWindow, getWsServer, sId, cId, src, rId),
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
    broadcastPreview(getWindow, getWsServer, sessionId, cardId, cleared)
    sendJson(res, 200, cleared)
    return
  }

  // GET /sessions/<id>/cards → mirror of the renderer's per-session card list,
  // so external callers (MCP list_cards) can see what the user has open.
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

  // POST /cards/search — full-text search the session's workspace card library.
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

  // POST /cards/backlinks — reverse links for a given card. Body: { cardPath?: string }.
  // Without cardPath we default to the session's focused card so the MCP tool can be called
  // with zero args ("who refs the card I'm staring at?").
  if (req.method === 'POST' && url === '/cards/backlinks') {
    try {
      const raw = await readBody(req)
      const body = raw ? (JSON.parse(raw) as { cardPath?: unknown }) : {}
      const mirror = getCardsForSession(sessionId)
      if (!mirror.cwd) {
        sendJson(res, 400, {
          error: 'no workspace known for this session — open a card in the workspace first'
        })
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

  // Browser-control layer: dky-mcp's browser_* tools POST here to drive the focused web card.
  if (req.method === 'POST' && url === '/web/act') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as WebActBody
      const result = await runWebAction(getWindow, getWsServer, sessionId, body)
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // GET /web/replay?last=N[&cardId=…] — the replay log for a card. cardId defaults to the session's
  // focused web card (no live WebContents needed — the log persists past tab close).
  if (req.method === 'GET' && url.startsWith('/web/replay')) {
    const q = new URL(url, 'http://x').searchParams
    let targetCard = q.get('cardId') || cardId || ''
    if (!targetCard) {
      const mirror = getCardsForSession(sessionId)
      const focused = mirror.cards.find((c) => c.id === mirror.focused && c.type === 'web')
      const sole = mirror.cards.filter((c) => c.type === 'web')
      targetCard = focused?.id || (sole.length === 1 ? sole[0].id : '')
    }
    if (!targetCard) {
      sendJson(res, 400, { error: 'no cardId given and no focused web card in this session' })
      return
    }
    const last = q.get('last') ? Number(q.get('last')) : undefined
    sendJson(res, 200, { cardId: targetCard, events: readEvents(targetCard, { last }) })
    return
  }

  // GET /web/adapters — the adapter verbs that match the active card's URL (self-describing site).
  if (req.method === 'GET' && url === '/web/adapters') {
    let pageUrl = ''
    try {
      pageUrl = resolveWebCard(sessionId, cardId ?? undefined).wc.getURL()
    } catch {
      pageUrl = ''
    }
    sendJson(res, 200, { url: pageUrl, tools: pageUrl ? adapterToolsForUrl(pageUrl) : [] })
    return
  }

  // POST /web/adapters/run { name, args?, cardId? } — run one adapter verb against the card.
  if (req.method === 'POST' && url === '/web/adapters/run') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { name?: unknown; args?: unknown; cardId?: unknown }
      if (typeof body.name !== 'string' || !body.name) {
        sendJson(res, 400, { error: 'name required' })
        return
      }
      const tool = findAdapterTool(body.name)
      if (!tool) {
        sendJson(res, 404, { error: `no adapter tool named "${body.name}"` })
        return
      }
      const { wc } = resolveWebCard(
        sessionId,
        typeof body.cardId === 'string' ? body.cardId : undefined
      )
      const args = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<
        string,
        unknown
      >
      trackActivityStart(wc, `adapter:${body.name}`)
      try {
        const result = await tool.run(makeWebContext(wc), args)
        sendJson(res, 200, { ok: true, result })
      } finally {
        trackActivityEnd()
      }
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // Long-poll: MCP `prompt_form` blocks here until the user submits/cancels in the renderer.
  // Default timeout is 10min — agent prompts should resolve well before that.
  if (req.method === 'POST' && url === '/form/await') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { formId?: unknown; timeoutMs?: unknown }
      if (typeof body.formId !== 'string' || body.formId.length === 0) {
        sendJson(res, 400, { error: 'formId required' })
        return
      }
      const formId = body.formId
      const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 10 * 60 * 1000
      if (isFormPending(formId)) {
        sendJson(res, 409, { error: 'already awaiting this formId' })
        return
      }
      const outcome = await awaitFormOutcome(formId, timeoutMs)
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

  // GET /widgets/list — catalog of registered widget types + currently-mounted instances.
  // Used by MCP `list_widgets` so the AI can discover available widgets without hardcoded docs.
  if (req.method === 'GET' && url === '/widgets/list') {
    const outcome = await awaitWidgetCall(
      {
        getWsServer,
        emitIpc: (payload) => {
          const win = getWindow()
          if (win && !win.isDestroyed()) win.webContents.send('widget:call', payload)
        },
        hasIpcConsumer: () => {
          const win = getWindow()
          return !!(win && !win.isDestroyed())
        }
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

  // Widget RPC — `card_invoke` / `card_get` from MCP land here. We forward to the renderer
  // via IPC (widget:call) and park a resolver until widget:call-reply comes back. The renderer
  // dispatches into the live widget registry (see lib/widget-registry.ts).
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
        {
          getWsServer,
          emitIpc: (payload) => {
            const win = getWindow()
            if (win && !win.isDestroyed()) win.webContents.send('widget:call', payload)
          },
          hasIpcConsumer: () => {
            const win = getWindow()
            return !!(win && !win.isDestroyed())
          }
        },
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

  // POST /sessions/web-tab { title?: string } — open a new EMPTY web tab (a browser card) in the
  // active session, focused, labeled with `title` until it navigates. It lives inside the current
  // session, so there's no session id to mint. The caller is `decky new-tab`.
  if (req.method === 'POST' && url === '/sessions/web-tab') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { title?: unknown }
      const title =
        typeof body.title === 'string' && body.title.length > 0 ? body.title.slice(0, 80) : ''
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('webtab:new', { title })
        win.focus()
      }
      getWsServer()?.broadcast('webtab:new', { title })
      sendJson(res, 200, { ok: true, title })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // POST /sessions/rename { title } — rename THIS session's tab and PIN it: the renderer marks the
  // session as user-titled, so the auto-title (claude aiTitle / first prompt) never overrides it
  // again, and the name persists across restart. Empty title clears the pin (back to auto-title).
  // Reuses the `session:title-changed` event with `pinned:true` so the renderer can tell manual from
  // auto. The caller is `decky rename`.
  if (req.method === 'POST' && url === '/sessions/rename') {
    try {
      const id = sessionIdFrom(req)
      if (!id || id === GLOBAL_KEY) {
        sendJson(res, 400, { error: 'no session (run inside a decky tab)' })
        return
      }
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { title?: unknown }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : ''
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('session:title-changed', { id, title, pinned: true })
      }
      getWsServer()?.broadcast('session:title-changed', { id, title, pinned: true })
      sendJson(res, 200, { ok: true, id, title })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // POST /cards/reload { path } — push-based live reload: tells the renderer to re-render the
  // open card(s) whose source file is `path`. Used after a card-manifesto is mutated on disk
  // (decky add-widget/title) so the card updates deterministically, WITHOUT depending on the fs
  // watcher firing — the mutation itself drives the reload.
  if (req.method === 'POST' && url === '/cards/reload') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { path?: unknown }
      const path = typeof body.path === 'string' ? body.path : ''
      if (!path) {
        sendJson(res, 400, { error: 'path required' })
        return
      }
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('card:reload', { path })
      getWsServer()?.broadcast('card:reload', { path })
      sendJson(res, 200, { ok: true, path })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // POST /cards/patch { path, op, type?, id?, spec?, n? } — INCREMENTAL live patch (no full
  // reload): op 'append' drops one widget into the open card(s) for `path`, op 'pop' removes the
  // last n. Lets a card be built/torn down widget-by-widget WITHOUT the reload flicker. The manifest
  // on disk remains the source of truth — a later full reload reconciles. The CLI falls back to
  // /cards/reload if this fails, so it degrades cleanly on an older server.
  if (req.method === 'POST' && url === '/cards/patch') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as {
        path?: unknown
        op?: unknown
        type?: unknown
        id?: unknown
        spec?: unknown
        n?: unknown
      }
      const path = typeof body.path === 'string' ? body.path : ''
      const op = body.op === 'append' || body.op === 'pop' ? body.op : ''
      if (!path || !op) {
        sendJson(res, 400, { error: 'path and op (append|pop) required' })
        return
      }
      const msg = { path, op, type: body.type, id: body.id, spec: body.spec, n: body.n }
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('card:patch', msg)
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // POST /workspace { cwd: string, kind?: 'claude' | 'shell' }
  // Tells the renderer to add a new session in the given cwd and focus it.
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
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('session:add', { cwd: body.cwd, kind })
        win.focus()
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

export function startPreviewServer(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): void {
  server = createServer((req, res) => {
    handleRequest(req, res, getWindow, getWsServer).catch((err) => {
      console.error('[preview-server] handler error:', err)
      try {
        sendJson(res, 500, { error: String(err) })
      } catch {
        // already responded or socket closed
      }
    })
  })
  server.listen(PORT, HOST, () => {
    console.log(`[preview-server] listening on http://${HOST}:${PORT}`)
  })
  server.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(
        `[preview-server] port ${PORT} already in use — a stale decky/preview-server is likely still holding it. Preview cards won't work until it's freed; the rest of decky keeps running.`
      )
      return
    }
    console.error('[preview-server] server error:', err)
  })
}

export function stopPreviewServer(): void {
  server?.close()
  server = null
}
