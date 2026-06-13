import { protocol, net, session, type Session } from 'electron'
import { readFile, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join, relative, resolve as resolvePath } from 'node:path'

// Replaces the HTTP localhost server (html-server.ts) with a custom `card://` protocol.
// The card files are still served from `<workspace>/.decky[-dev]/cards/`, but the URLs
// look like `card://ws-<8hex>/relative/path.html` and ONLY Electron WebContents in this
// app resolve them — nothing on localhost can sniff or hit them.

// host → abs cards dir registry. Host slug is a deterministic 8-char SHA1 prefix of the
// abs dir so the URL is stable across launches (URLs you bookmark won't break).
const hostToDir = new Map<string, string>()
const dirToHost = new Map<string, string>()

function slugFor(absDir: string): string {
  return 'ws-' + createHash('sha1').update(absDir).digest('hex').slice(0, 8)
}

export function registerCardsDir(absDir: string): string {
  const abs = resolvePath(absDir)
  const cached = dirToHost.get(abs)
  if (cached) return cached
  const host = slugFor(abs)
  dirToHost.set(abs, host)
  hostToDir.set(host, abs)
  return host
}

// URL builder used by the renderer-bridge: returns the full `card://` URL for a file.
export function cardUrlFor(absPath: string, cardsDir: string): string {
  const host = registerCardsDir(cardsDir)
  const rel = relative(cardsDir, absPath)
  return `card://${host}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

// Reverse of cardUrlFor: card://host/path → abs file on disk. Used by the renderer when
// will-navigate intercepts a click and asks main "what file does this URL point at?".
export function cardUrlToAbsPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'card:') return null
    const dir = hostToDir.get(u.hostname)
    if (!dir) return null
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')
    return join(dir, rel)
  } catch {
    return null
  }
}

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

// Same default CSS + widget runtime as html-server: shared via re-export so cards keep
// rendering identically when this protocol replaces the http server.
import {
  getDefaultCardCss,
  getVirtualRoutes,
  injectDefaultCss,
  rewriteMarkedImports,
  wrapMarkdownAsHtml
} from './html-server'

const DEFAULT_CSS_PATH = '/__decky/default.css'

export function registerCardScheme(): void {
  // Privileged registration must run BEFORE app.whenReady. Standard + secure makes the page
  // load as if it were https (fetch/CORS/cookies behave normally). supportFetchAPI is needed
  // for the dialog/filter JS doing fetch('/__decky/cards/delete'). bypassCSP avoids extra
  // meta-CSP fights when cards pull marked from esm.sh.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'card',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ])
}

// Register on the persistent web partition (`persist:deckweb`) used by WebContentsView
// card pages — otherwise card:// URLs only resolve in the renderer, not inside web cards.
export function setupCardProtocol(): void {
  protocol.handle('card', cardHandler)
  try {
    const webSession: Session = session.fromPartition('persist:deckweb')
    webSession.protocol.handle('card', cardHandler)
  } catch (e) {
    console.error('[card-protocol] failed to register on web session:', e)
  }
}

const cardHandler = async (req: GlobalRequest): Promise<GlobalResponse> => {
    try {
      const url = new URL(req.url)
      const host = url.hostname
      const cardsDir = hostToDir.get(host)
      if (!cardsDir) {
        return new Response('unknown workspace host: ' + host, { status: 404 })
      }
      const pathname = decodeURIComponent(url.pathname) // starts with "/"

      // POST /__decky/cards/delete — sanitize id, unlink .html + .md siblings.
      if (req.method === 'POST' && pathname === '/__decky/cards/delete') {
        try {
          const body = await req.json()
          const id = typeof body?.id === 'string' ? body.id : ''
          if (!id) return new Response('{"error":"id required"}', { status: 400 })
          const safe = id
            .split('/')
            .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, '-'))
            .filter(Boolean)
            .join('/')
          await Promise.all(
            ['.html', '.md'].map(async (ext) => {
              const target = join(cardsDir, safe + ext)
              const rel = relative(cardsDir, target)
              if (rel.startsWith('..') || rel === '..') return
              try {
                await unlink(target)
              } catch {
                // missing sibling is fine
              }
            })
          )
          return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        } catch (err) {
          return new Response('{"error":"' + String(err) + '"}', { status: 500 })
        }
      }

      // Virtual stylesheet — the workspace-default theme injected when an HTML card doesn't
      // ship its own.
      if (pathname === DEFAULT_CSS_PATH) {
        return new Response(getDefaultCardCss(), {
          status: 200,
          headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }
        })
      }

      // Bundled widget runtime (mermaid/flow/checklist).
      const virt = getVirtualRoutes()[pathname]
      if (virt) {
        return new Response(virt.body, {
          status: 200,
          headers: { 'content-type': virt.mime, 'cache-control': 'no-store' }
        })
      }

      // Real file. Strip leading slash, resolve under cardsDir, reject traversal.
      const target = join(cardsDir, pathname.replace(/^\/+/, ''))
      const rel = relative(cardsDir, target)
      if (rel.startsWith('..') || rel === '..') {
        return new Response('forbidden', { status: 403 })
      }
      try {
        const buf = await readFile(target)
        const ext = extname(target).toLowerCase()
        // .md → wrap in HTML scaffold (marked client-side render) so legacy .md cards
        // still look correct via this protocol too.
        if (ext === '.md') {
          return new Response(wrapMarkdownAsHtml(buf.toString('utf-8')), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
          })
        }
        const mime = MIME[ext] ?? 'application/octet-stream'
        const body =
          ext === '.html' || ext === '.htm'
            ? rewriteMarkedImports(injectDefaultCss(buf.toString('utf-8')))
            : buf
        return new Response(body, {
          status: 200,
          headers: { 'content-type': mime, 'cache-control': 'no-store' }
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
}

// Stub to keep the net import "used" — Response is what handle returns, net.fetch was
// helpful in asset-protocol's pathToFileURL roundtrip but here we readFile directly.
void net
