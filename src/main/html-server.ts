import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize as normalizePath, relative, resolve as resolvePath } from 'node:path'
import { app, ipcMain } from 'electron'
import { diag } from './diag'

// Serves a local directory over an ephemeral http://127.0.0.1:<port> so HTML cards opened from
// preview_show can do fetch / ES modules / Service Workers — all the things file:// blocks.
// One server per directory (cache keyed by abs dir); shared across cards under the same root.
// Lifetime: from first request until app quit. Ports are auto-assigned (bind to :0).

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf'
}

interface DirServer {
  server: Server
  port: number
  baseUrl: string
}

const servers = new Map<string, DirServer>()

async function serveDir(absDir: string): Promise<DirServer> {
  const key = resolvePath(absDir)
  const existing = servers.get(key)
  if (existing) return existing
  const server = createServer((req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      const pathname = decodeURIComponent(u.pathname)
      // Strip leading slash, normalize, then check it stays under the dir. Rejecting any
      // `..` segment that escapes the root is what scopes this server to its directory.
      const target = join(key, normalizePath('.' + pathname))
      const rel = relative(key, target)
      if (rel.startsWith('..') || rel === '..' || rel.includes('..' + '/')) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      readFile(target)
        .then((buf) => {
          const ext = extname(target).toLowerCase()
          const mime = MIME[ext] ?? 'application/octet-stream'
          res.writeHead(200, {
            'content-type': mime,
            // No-store so editing the HTML and reloading the card always reflects the latest
            // on disk — html cards are typically authored locally, not cached for perf.
            'cache-control': 'no-store'
          })
          res.end(buf)
        })
        .catch(() => {
          res.writeHead(404)
          res.end('not found')
        })
    } catch (e) {
      res.writeHead(500)
      res.end(String(e))
    }
  })
  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => res())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('html-server: failed to bind')
  const info: DirServer = { server, port: addr.port, baseUrl: `http://127.0.0.1:${addr.port}` }
  servers.set(key, info)
  diag(`[html-server] serving ${key} on ${info.baseUrl}`)
  return info
}

// Resolve a file path to its served URL. Lazily starts a server for the file's directory
// (cached per dir). Returns http://127.0.0.1:<port>/<basename>.
export async function resolveHtmlUrl(absPath: string): Promise<string> {
  const abs = resolvePath(absPath)
  // dirname() strips trailing segment, including for files at /.
  const idx = abs.lastIndexOf('/')
  const dir = idx > 0 ? abs.slice(0, idx) : '/'
  const base = idx >= 0 ? abs.slice(idx + 1) : abs
  const info = await serveDir(dir)
  return `${info.baseUrl}/${encodeURIComponent(base)}`
}

export function setupHtmlServer(): void {
  ipcMain.handle('html:resolve', async (_e, path: string) => {
    if (typeof path !== 'string' || !path) throw new Error('html:resolve: path required')
    return resolveHtmlUrl(path)
  })
  app.on('before-quit', () => {
    for (const s of servers.values()) {
      try {
        s.server.close()
      } catch {
        // ignore
      }
    }
    servers.clear()
  })
}
