import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, type WebContents } from 'electron'
import type { PreviewSource, PreviewSourceWire } from '../shared/preview'
import { isGeneratedCardPath } from './paths'
import { getCardsForSession, getAllCards, registerPreviewResolution } from './card-mirror'
import { awaitWidgetCall } from './widget-bridge'
import { getWebViewsManager } from './web-views'

const PORT = Number(process.env.DECKY_PREVIEW_PORT) || 6790
const HOST = '127.0.0.1'

const GLOBAL_KEY = 'global'
const previews = new Map<string, PreviewSource>()
const sessionTitles = new Map<string, string>()
let server: Server | null = null

// Form prompt flow: the MCP `prompt_form` tool POSTs /form/await with a formId and the
// HTTP response is held open until the user clicks SEND or CANCEL in the renderer
// (which POSTs /form/submit or /form/cancel here). The pending map keys are formIds.
type FormOutcome =
  | { status: 'submitted'; values: Record<string, string | boolean> }
  | { status: 'cancelled' }
  | { status: 'timeout' }
const pendingForms = new Map<string, { resolve: (r: FormOutcome) => void; timer: NodeJS.Timeout }>()

export function getPreviewSources(): Record<string, PreviewSource> {
  return Object.fromEntries(previews)
}

export function getSessionTitles(): Record<string, string> {
  return Object.fromEntries(sessionTitles)
}

/**
 * Re-read markdown sources that were persisted as just a path (no content).
 * Paths persisted as relative are resolved against `workspace` so cards survive
 * the workspace folder being renamed/moved.
 */
export async function rehydratePreviews(
  byCard: Record<string, Record<string, PreviewSource>>,
  workspace?: string
): Promise<Record<string, Record<string, PreviewSource>>> {
  const out: Record<string, Record<string, PreviewSource>> = {}
  for (const [sessionId, cards] of Object.entries(byCard ?? {})) {
    out[sessionId] = {}
    for (const [cardId, source] of Object.entries(cards)) {
      if (source.type === 'markdown' && source.path && !source.content) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        try {
          const content = await readFile(abs, 'utf-8')
          // Generated card files (<workspace>/.decky/cards/<id>.md) have meaningless
          // basenames. Drop a title that's just the filename so it derives from the content
          // (heading / first line); keep a real custom title if the bot set one.
          const generated = isGeneratedCardPath(abs)
          const bn = basename(abs)
          let title = source.title
          if (generated && (!title || title === bn)) title = undefined
          else if (!generated && !title) title = bn
          out[sessionId][cardId] = { type: 'markdown', content, title, path: abs }
        } catch {
          out[sessionId][cardId] = {
            type: 'markdown',
            content: `*(arquivo não encontrado: ${abs})*`,
            path: abs
          }
        }
      } else if (source.type === 'editor' && source.path && !source.content) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        try {
          const content = await readFile(abs, 'utf-8')
          out[sessionId][cardId] = {
            type: 'editor',
            content,
            title: source.title ?? basename(abs),
            path: abs
          }
        } catch {
          out[sessionId][cardId] = {
            type: 'editor',
            content: '',
            title: source.title ?? basename(abs),
            path: abs
          }
        }
      } else if (source.type === 'xlsx' && source.path) {
        const abs =
          !isAbsolute(source.path) && workspace ? resolvePath(workspace, source.path) : source.path
        out[sessionId][cardId] = {
          type: 'xlsx',
          path: abs,
          title: source.title ?? basename(abs)
        }
      } else {
        out[sessionId][cardId] = source
      }
    }
  }
  return out
}

function broadcastPreview(
  getWindow: () => BrowserWindow | null,
  sessionId: string,
  cardId: string | null,
  source: PreviewSource,
  reqId?: string
): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('preview:source-changed', { sessionId, cardId, source, reqId })
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

function broadcastSessionTitle(
  getWindow: () => BrowserWindow | null,
  id: string,
  title: string
): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('session:title-changed', { id, title })
}

async function normalize(wire: PreviewSourceWire): Promise<PreviewSource> {
  if (wire.type === 'markdown') {
    if (wire.content != null) {
      return { type: 'markdown', content: wire.content, title: wire.title }
    }
    if (wire.path) {
      const content = await readFile(wire.path, 'utf-8')
      return {
        type: 'markdown',
        content,
        title: wire.title ?? basename(wire.path),
        path: wire.path
      }
    }
    throw new Error('markdown source requires content or path')
  }
  if (wire.type === 'diff') {
    if (wire.content != null) {
      return { type: 'diff', content: wire.content, title: wire.title }
    }
    if (wire.path) {
      const content = await readFile(wire.path, 'utf-8')
      return { type: 'diff', content, title: wire.title ?? basename(wire.path), path: wire.path }
    }
    throw new Error('diff source requires content or path')
  }
  if (wire.type === 'editor') {
    if (!wire.path) throw new Error('editor source requires a path')
    const content = await readFile(wire.path, 'utf-8')
    return { type: 'editor', content, title: wire.title ?? basename(wire.path), path: wire.path }
  }
  if (wire.type === 'xlsx') {
    if (!wire.path) throw new Error('xlsx source requires a path')
    // Binary — don't read here; the renderer reads via file:read-binary on mount.
    await stat(wire.path)
    return { type: 'xlsx', path: wire.path, title: wire.title ?? basename(wire.path) }
  }
  if (wire.type === 'web' && !wire.url) {
    throw new Error('web source requires a url')
  }
  return wire as PreviewSource
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
// Same model as decky-browser's agent-mcp: snapshot tags visible interactive elements with a
// stable `data-mcp-ref`; click/type address by that ref. dky-mcp's browser_* tools POST here.
const SNAPSHOT_JS = `(() => {
  const SEL = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=checkbox],[role=tab],[contenteditable=true],[onclick]';
  for (const el of document.querySelectorAll('[data-mcp-ref]')) el.removeAttribute('data-mcp-ref');
  const out = []; let i = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue;
    const ref = 'e' + (++i);
    el.setAttribute('data-mcp-ref', ref);
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value ||
      (el.innerText || '').trim() || el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0, 80);
    out.push({ ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), name,
      type: el.getAttribute('type') || undefined });
  }
  return { url: location.href, title: document.title, elements: out };
})()`

const READ_JS = `(() => ({
  url: location.href, title: document.title,
  text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000)
}))()`

function clickJs(ref: string): string {
  const refLit = JSON.stringify(ref)
  return `(() => {
    const el = document.querySelector('[data-mcp-ref=' + ${JSON.stringify(refLit)} + ']');
    if (!el) return { ok: false, error: 'ref not found: ' + ${refLit} };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return { ok: true };
  })()`
}

function typeJs(ref: string, text: string): string {
  const refLit = JSON.stringify(ref)
  const textLit = JSON.stringify(text)
  return `(() => {
    const el = document.querySelector('[data-mcp-ref=' + ${JSON.stringify(refLit)} + ']');
    if (!el) return { ok: false, error: 'ref not found: ' + ${refLit} };
    el.focus();
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${textLit}); else el.value = ${textLit};
    } else if (el.isContentEditable) {
      el.textContent = ${textLit};
    } else {
      return { ok: false, error: 'element is not typable' };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`
}

function normalizeWebUrl(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return s
  if (/^(https?|file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s)) return `http://${s}`
  if (/^[^\s]+\.[^\s]{2,}/.test(s) && !/\s/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

// Resolve which web card the action targets: an explicit cardId, else the session's focused card
// (if it's a web card), else the single open web card. Throws a guiding error otherwise.
function resolveWebCard(sessionId: string, explicitCardId?: string): { cardId: string; wc: WebContents } {
  const manager = getWebViewsManager()
  if (!manager) throw new Error('no web views ready — open a web card first')
  let cardId = explicitCardId
  if (!cardId) {
    const m = getCardsForSession(sessionId)
    const focused = m.cards.find((c) => c.id === m.focused)
    if (focused && focused.type === 'web') cardId = focused.id
    else {
      const webCards = m.cards.filter((c) => c.type === 'web')
      if (webCards.length === 1) cardId = webCards[0].id
    }
  }
  if (!cardId) throw new Error('no focused web card — open a web card (or pass cardId)')
  const wc = manager.webContentsFor(cardId)
  if (!wc) throw new Error(`no web card with id "${cardId}"`)
  return { cardId, wc }
}

interface WebActBody {
  action?: string
  cardId?: string
  url?: string
  ref?: string
  text?: string
  code?: string
}

// Open a new web card by broadcasting a `web` preview source — the same path POST /preview uses.
// The renderer creates + focuses the card and mounts its WebContentsView (which navigates to the
// url). Returns the resolved cardId once the renderer acks.
async function createWebCard(
  getWindow: () => BrowserWindow | null,
  sessionId: string,
  url: string
): Promise<string> {
  const source: PreviewSource = { type: 'web', url }
  previews.set(sessionId, source)
  const reqId = randomUUID()
  const resolved = await new Promise<{ cardId: string }>((resolve) => {
    registerPreviewResolution(reqId, (info) => resolve({ cardId: info.cardId }))
    broadcastPreview(getWindow, sessionId, null, source, reqId)
  })
  return resolved.cardId
}

async function runWebAction(
  getWindow: () => BrowserWindow | null,
  sessionId: string,
  body: WebActBody
): Promise<unknown> {
  // navigate is the one action that can run with NO web card open — it opens one. (The agent
  // needs this to start a browsing flow from scratch; the other actions require an existing card.)
  if (body.action === 'navigate') {
    const url = normalizeWebUrl(String(body.url ?? ''))
    let target: { cardId: string; wc: WebContents } | null = null
    try {
      target = resolveWebCard(sessionId, body.cardId)
    } catch {
      target = null
    }
    if (target) {
      await target.wc.loadURL(url).catch(() => {})
      return { ok: true, cardId: target.cardId, url: target.wc.getURL(), title: target.wc.getTitle() }
    }
    // Explicit cardId that doesn't exist is an error; no cardId → open a fresh web card.
    if (body.cardId) throw new Error(`no web card with id "${body.cardId}"`)
    const cardId = await createWebCard(getWindow, sessionId, url)
    return { ok: true, created: true, cardId, url }
  }

  const { wc } = resolveWebCard(sessionId, body.cardId)
  switch (body.action) {
    case 'snapshot':
      return wc.executeJavaScript(SNAPSHOT_JS)
    case 'read':
      return wc.executeJavaScript(READ_JS)
    case 'click':
      return wc.executeJavaScript(clickJs(String(body.ref ?? '')), true)
    case 'type':
      return wc.executeJavaScript(typeJs(String(body.ref ?? ''), String(body.text ?? '')), true)
    case 'eval':
      return wc.executeJavaScript(String(body.code ?? ''))
    default:
      throw new Error(`unknown web action: ${body.action}`)
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getWindow: () => BrowserWindow | null
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
    sendJson(res, 200, previews.get(sessionId) ?? { type: 'none' })
    return
  }

  if (req.method === 'GET' && url === '/preview/all') {
    sendJson(res, 200, Object.fromEntries(previews))
    return
  }

  if (req.method === 'POST' && url === '/preview') {
    try {
      const raw = await readBody(req)
      const wire = JSON.parse(raw) as PreviewSourceWire
      const source = await normalize(wire)
      previews.set(sessionId, source)
      // Park a resolver keyed by reqId; the renderer acks it via the 'preview:resolved' IPC
      // after computing the target card and (for inline markdown) materializing the file.
      const reqId = randomUUID()
      const resolved = await new Promise<{
        cardId: string
        path?: string
        title?: string
      }>((resolve) => {
        registerPreviewResolution(reqId, resolve)
        broadcastPreview(getWindow, sessionId, cardId, source, reqId)
      })
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
    const cleared: PreviewSource = { type: 'none' }
    previews.set(sessionId, cleared)
    broadcastPreview(getWindow, sessionId, cardId, cleared)
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

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, pid: process.pid })
    return
  }

  // Browser-control layer: dky-mcp's browser_* tools POST here to drive the focused web card.
  if (req.method === 'POST' && url === '/web/act') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw) as WebActBody
      const result = await runWebAction(getWindow, sessionId, body)
      sendJson(res, 200, result)
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
      // Reject duplicate await for the same formId.
      if (pendingForms.has(formId)) {
        sendJson(res, 409, { error: 'already awaiting this formId' })
        return
      }
      const outcome = await new Promise<FormOutcome>((resolve) => {
        const timer = setTimeout(() => {
          pendingForms.delete(formId)
          resolve({ status: 'timeout' })
        }, timeoutMs)
        pendingForms.set(formId, { resolve, timer })
      })
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
      const pending = pendingForms.get(body.formId)
      if (!pending) {
        sendJson(res, 404, { error: 'no form awaiting this id (timed out or already resolved)' })
        return
      }
      clearTimeout(pending.timer)
      pendingForms.delete(body.formId)
      const values =
        body.values && typeof body.values === 'object'
          ? (body.values as Record<string, string | boolean>)
          : {}
      pending.resolve({ status: 'submitted', values })
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
      const pending = pendingForms.get(body.formId)
      if (!pending) {
        sendJson(res, 200, { ok: true, alreadyResolved: true })
        return
      }
      clearTimeout(pending.timer)
      pendingForms.delete(body.formId)
      pending.resolve({ status: 'cancelled' })
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  // GET /widgets/list — catalog of registered widget types + currently-mounted instances.
  // Used by MCP `list_widgets` so the AI can discover available widgets without hardcoded docs.
  if (req.method === 'GET' && url === '/widgets/list') {
    const outcome = await awaitWidgetCall(getWindow, { kind: 'list' })
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
      const outcome = await awaitWidgetCall(getWindow, {
        kind: isInvoke ? 'invoke' : 'get',
        cardId: body.cardId,
        widgetId: body.widgetId,
        op: isInvoke ? (body.op as string) : undefined,
        args: isInvoke ? body.args : undefined,
        key: isInvoke ? undefined : (body.key as string)
      })
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

  // POST /sessions/<id>/title  { title: string }
  const titleMatch = req.method === 'POST' && /^\/sessions\/([^/]+)\/title\/?$/.exec(url)
  if (titleMatch) {
    try {
      const id = decodeURIComponent(titleMatch[1])
      const raw = await readBody(req)
      const body = JSON.parse(raw) as { title?: unknown }
      if (typeof body.title !== 'string' || body.title.length === 0) {
        sendJson(res, 400, { error: 'title must be a non-empty string' })
        return
      }
      const title = body.title.slice(0, 80)
      sessionTitles.set(id, title)
      broadcastSessionTitle(getWindow, id, title)
      sendJson(res, 200, { ok: true, id, title })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  if (req.method === 'GET' && url === '/sessions/titles') {
    sendJson(res, 200, Object.fromEntries(sessionTitles))
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
      sendJson(res, 200, { ok: true, cwd: body.cwd, kind })
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

export function startPreviewServer(getWindow: () => BrowserWindow | null): void {
  server = createServer((req, res) => {
    handleRequest(req, res, getWindow).catch((err) => {
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
      // A previous decky that didn't shut down cleanly can leave the port held. Surface it
      // loudly instead of dying mid-boot — the rest of the app still works without preview.
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
