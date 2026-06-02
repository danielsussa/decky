import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { PreviewSource, PreviewSourceWire } from '../shared/preview'
import { isGeneratedCardPath } from './paths'
import { getCardsForSession, getAllCards, registerPreviewResolution } from './card-mirror'

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
    console.error('[preview-server] server error:', err)
  })
}

export function stopPreviewServer(): void {
  server?.close()
  server = null
}
