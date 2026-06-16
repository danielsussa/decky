import { readFile, unlink } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { getCardsDirForHost } from './card-host-registry'
import {
  DEFAULT_CSS_PATH,
  MIME,
  getDefaultCardCss,
  getVirtualRoutes,
  injectBridgeBootstrap,
  injectDefaultCss,
  rewriteMarkedImports,
  wrapMarkdownAsHtml
} from './card-render'

// Resolver puro para o scheme card://. Recebe a request abstrata (URL + method + body JSON
// opcional) e devolve {status, headers, body}. O shim Electron empacota como Response;
// quando o transport virar HTTP (modo remoto), o mesmo resolver atende rotas /cards/*.

export interface CardRequest {
  url: string
  method: string
  // Body parsed (apenas POST /__decky/cards/delete usa). Opcional.
  json?: unknown
}

export interface CardResponse {
  status: number
  headers?: Record<string, string>
  body?: Buffer | string
}

export async function resolveCardRequest(req: CardRequest): Promise<CardResponse> {
  try {
    const url = new URL(req.url)
    const host = url.hostname
    const cardsDir = getCardsDirForHost(host)
    if (!cardsDir) {
      return { status: 404, body: 'unknown workspace host: ' + host }
    }
    const pathname = decodeURIComponent(url.pathname) // starts with "/"

    // POST /__decky/cards/delete — sanitize id, unlink .html + .md siblings.
    if (req.method === 'POST' && pathname === '/__decky/cards/delete') {
      try {
        const body = req.json as { id?: unknown } | undefined
        const id = typeof body?.id === 'string' ? body.id : ''
        if (!id) {
          return {
            status: 400,
            headers: { 'content-type': 'application/json' },
            body: '{"error":"id required"}'
          }
        }
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
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}'
        }
      } catch (err) {
        return {
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: '{"error":"' + String(err) + '"}'
        }
      }
    }

    // Virtual stylesheet — o tema workspace-default injetado quando o HTML card não traz o seu.
    if (pathname === DEFAULT_CSS_PATH) {
      return {
        status: 200,
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' },
        body: getDefaultCardCss()
      }
    }

    // Widget runtime bundlado (mermaid/flow/checklist).
    const virt = getVirtualRoutes()[pathname]
    if (virt) {
      return {
        status: 200,
        headers: { 'content-type': virt.mime, 'cache-control': 'no-store' },
        body: virt.body
      }
    }

    // Arquivo real. Tira leading slash, resolve sob cardsDir, rejeita traversal.
    const target = join(cardsDir, pathname.replace(/^\/+/, ''))
    const rel = relative(cardsDir, target)
    if (rel.startsWith('..') || rel === '..') {
      return { status: 403, body: 'forbidden' }
    }
    try {
      const buf = await readFile(target)
      const ext = extname(target).toLowerCase()
      // .md → wrap em scaffold HTML (marked client-side) pra cards .md legados ainda
      // renderizarem corretamente também via este protocol.
      if (ext === '.md') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          body: wrapMarkdownAsHtml(buf.toString('utf-8'))
        }
      }
      const mime = MIME[ext] ?? 'application/octet-stream'
      // cardId for the bridge bootstrap = the pathname minus leading slash + extension.
      const cardId = pathname.replace(/^\/+/, '').replace(/\.html?$/i, '')
      const body =
        ext === '.html' || ext === '.htm'
          ? injectBridgeBootstrap(
              rewriteMarkedImports(injectDefaultCss(buf.toString('utf-8'))),
              cardId
            )
          : buf
      return {
        status: 200,
        headers: { 'content-type': mime, 'cache-control': 'no-store' },
        body
      }
    } catch {
      return { status: 404, body: 'not found' }
    }
  } catch (e) {
    return { status: 500, body: String(e) }
  }
}
