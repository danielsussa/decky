import { randomUUID } from 'node:crypto'
import { extname, join, relative } from 'node:path'
import WebSocket from 'ws'
import {
  getCardsDirForHost,
  MIME,
  getDefaultCardCss,
  getVirtualRoutes,
  injectDefaultCss,
  rewriteMarkedImports,
  wrapMarkdownAsHtml,
  DEFAULT_CSS_PATH
} from '@decky/server'
import type { Engine } from '@decky/shared'

// Pra cards de workspaces REMOTOS o handler card:// (em src/main/card-protocol.ts) não consegue
// readFile do disco — o arquivo vive no host remoto. Este módulo:
//   1. registra o mapeamento host(ws-XXX) → engineId quando o renderer pede html:resolve com
//      um path que pertence a workspace remoto (setRemoteCardEngine);
//   2. expõe resolveRemoteCardRequest(req): se o host é remoto, faz file:read-text via WS no
//      engine dono, aplica os mesmos transforms (CSS inject, marked rewrite, md→html) e
//      devolve {status, body, headers}. Senão devolve null → handler segue o fluxo local.
//
// Sem este módulo, o WebContentsView que carrega card://ws-XXX/foo.html mostrava "not found"
// pra todos os cards do engine remoto.

// host → engineId. Cacheamos só o ID — a Engine atual (URL/token) vem do provider injetado
// pelo main, que SEMPRE devolve a versão fresca de `rendererEngines`. Sem isso, quando o
// reconnect abre tunnel com porta nova, o cached Engine ficava com URL morta e o próximo
// fetch dava ECONNREFUSED → "remote read failed" → 502 no card://.
const hostToEngineId = new Map<string, string>()

let engineLookup: (id: string) => Engine | undefined = () => undefined

export function setRemoteCardEngineLookup(fn: (id: string) => Engine | undefined): void {
  engineLookup = fn
}

export function setRemoteCardEngine(host: string, engine: Engine): void {
  hostToEngineId.set(host, engine.id)
}

export function getRemoteCardEngine(host: string): Engine | undefined {
  const id = hostToEngineId.get(host)
  if (!id) return undefined
  return engineLookup(id)
}

// Conexão WS short-lived por request. Boa o suficiente pra começar (cards são poucos por session
// e o tunnel SSH já reusa); se virar gargalo, dá pra cachear por engineId.
function wsInvoke<T>(
  url: string,
  token: string | undefined,
  kind: string,
  args: unknown,
  timeoutMs = 8000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const fullUrl = token
      ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
      : url
    let ws: WebSocket
    try {
      ws = new WebSocket(fullUrl)
    } catch (err) {
      reject(err)
      return
    }
    const reqId = randomUUID()
    let settled = false
    const settle = (err: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // ignore
      }
      if (err) reject(err)
      else resolve(value as T)
    }
    const timer = setTimeout(() => settle(new Error(`ws ${kind} timed out`)), timeoutMs)
    ws.on('open', () => {
      ws.send(JSON.stringify({ v: 1, kind, reqId, args }))
    })
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          kind?: string
          reqId?: string
          ok?: boolean
          result?: unknown
          error?: string
        }
        if (msg.kind !== 'reply' || msg.reqId !== reqId) return
        clearTimeout(timer)
        if (msg.ok) settle(null, msg.result as T)
        else settle(new Error(msg.error ?? 'ws error'))
      } catch (e) {
        clearTimeout(timer)
        settle(e as Error)
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      settle(err)
    })
    ws.on('close', () => {
      if (!settled) {
        clearTimeout(timer)
        settle(new Error(`ws ${kind} closed`))
      }
    })
  })
}

export interface RemoteCardResult {
  status: number
  headers?: Record<string, string>
  body?: string | Buffer
}

export async function resolveRemoteCardRequest(req: {
  url: string
  method: string
}): Promise<RemoteCardResult | null> {
  let parsed: URL
  try {
    parsed = new URL(req.url)
  } catch {
    return null
  }
  const host = parsed.hostname
  const engine = getRemoteCardEngine(host)
  if (!engine) return null // local — handler delega

  const cardsDir = getCardsDirForHost(host)
  if (!cardsDir) return null

  const pathname = decodeURIComponent(parsed.pathname)

  // Rotas virtuais (CSS default, marked.js bundlado) NÃO precisam ir pro remoto — o conteúdo é
  // estático e vive em @decky/server. Atende localmente pra evitar round-trip + latência.
  if (pathname === DEFAULT_CSS_PATH) {
    return {
      status: 200,
      headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' },
      body: getDefaultCardCss()
    }
  }
  const virt = getVirtualRoutes()[pathname]
  if (virt) {
    return {
      status: 200,
      headers: { 'content-type': virt.mime, 'cache-control': 'no-store' },
      body: virt.body
    }
  }

  // Arquivo real no host remoto. Tira leading slash, junta sob cardsDir, rejeita traversal
  // (mesma regra do resolver local em @decky/server/card-protocol).
  const target = join(cardsDir, pathname.replace(/^\/+/, ''))
  const rel = relative(cardsDir, target)
  if (rel.startsWith('..') || rel === '..') {
    return { status: 403, body: 'forbidden' }
  }

  const ext = extname(target).toLowerCase()
  // Extensões binárias: lê via base64 e decodifica num Buffer. PNG/JPG/etc lidos como UTF-8
  // viram string corrompida — sem este branch, imagens em cards remotos quebravam.
  const BINARY_EXTS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.wasm',
    '.pdf'
  ])
  if (BINARY_EXTS.has(ext)) {
    let b64: string | null
    try {
      b64 = await wsInvoke<string | null>(engine.url, engine.token, 'file:read-binary-base64', {
        path: target
      })
    } catch (err) {
      return { status: 502, body: `remote read failed: ${(err as Error).message}` }
    }
    if (b64 == null) return { status: 404, body: 'not found' }
    const mime = MIME[ext] ?? 'application/octet-stream'
    return {
      status: 200,
      headers: {
        'content-type': mime,
        'cache-control': 'no-store',
        // CORS open: o card HTML carrega de card:// e referencia `./img.png` que vira
        // outra origem card:// pro browser. Sem ACAO, alguns user agents bloqueiam.
        'access-control-allow-origin': '*'
      },
      body: Buffer.from(b64, 'base64')
    }
  }

  let content: string | null
  try {
    content = await wsInvoke<string | null>(engine.url, engine.token, 'file:read-text', {
      path: target
    })
  } catch (err) {
    return {
      status: 502,
      body: `remote read failed: ${(err as Error).message}`
    }
  }
  if (content == null) return { status: 404, body: 'not found' }

  // .md → wrap como HTML scaffold (marked client-side) — paridade com fluxo local.
  if (ext === '.md') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: wrapMarkdownAsHtml(content)
    }
  }
  if (ext === '.html' || ext === '.htm') {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: rewriteMarkedImports(injectDefaultCss(content))
    }
  }
  // Outros textuais (css/js/svg/json) — devolve como veio.
  const mime = MIME[ext] ?? 'text/plain; charset=utf-8'
  return {
    status: 200,
    headers: { 'content-type': mime, 'cache-control': 'no-store' },
    body: content
  }
}
