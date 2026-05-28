import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { BrowserWindow } from 'electron'
import type { PreviewSource, PreviewSourceWire } from '../shared/preview'

const PORT = Number(process.env.DECK_PREVIEW_PORT) || 6790
const HOST = '127.0.0.1'

let current: PreviewSource = { type: 'none' }
const sessionTitles = new Map<string, string>()
let server: Server | null = null

export function getPreviewSource(): PreviewSource {
  return current
}

export function getSessionTitles(): Record<string, string> {
  return Object.fromEntries(sessionTitles)
}

function broadcastPreview(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('preview:source', current)
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
        title: wire.title ?? basename(wire.path)
      }
    }
    throw new Error('markdown source requires content or path')
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
  res.setHeader('access-control-allow-headers', 'content-type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = req.url || '/'

  if (req.method === 'GET' && url === '/preview') {
    sendJson(res, 200, current)
    return
  }

  if (req.method === 'POST' && url === '/preview') {
    try {
      const raw = await readBody(req)
      const wire = JSON.parse(raw) as PreviewSourceWire
      current = await normalize(wire)
      broadcastPreview(getWindow)
      sendJson(res, 200, current)
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message })
    }
    return
  }

  if (req.method === 'POST' && url === '/preview/clear') {
    current = { type: 'none' }
    broadcastPreview(getWindow)
    sendJson(res, 200, current)
    return
  }

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, pid: process.pid })
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
