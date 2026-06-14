import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

// Resolver puro para o custom scheme decky-asset://. Sem Electron API — recebe a URL e
// devolve um envelope { status, headers, body? } que o shim do main converte em Response
// (ou que o servidor WS empacota como mensagem). Pra trocar de transport (Electron protocol.handle
// → HTTP em modo remoto) só muda quem chama esta função.
//
// Allow-list (request é permitido se QUALQUER uma:):
//   1. Path mora sob algum .decky/cards/ — cobre cards materializados.
//   2. Path mora sob o diretório do card, passado em ?base=<abs dir> — cobre preview_show
//      num .md solto em qualquer ponto do disco referenciando arquivos vizinhos.
//
// URL shape: decky-asset://card/<encoded abs path>?base=<encoded abs dir>

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
}

const ALLOWED_RE = /\/\.decky\/cards\//

function isUnder(abs: string, baseDir: string): boolean {
  if (!baseDir) return false
  const normalizedBase = baseDir.endsWith('/') ? baseDir.slice(0, -1) : baseDir
  return abs === normalizedBase || abs.startsWith(normalizedBase + '/')
}

export interface AssetResponse {
  status: number
  headers?: Record<string, string>
  body?: Buffer | string
}

export async function resolveAssetRequest(rawUrl: string): Promise<AssetResponse> {
  try {
    // URL shape: decky-asset://card/<encoded segments> — authority deve ser non-empty,
    // Chromium silenciosamente dropa <img> requests pra custom schemes com authority vazio.
    const url = new URL(rawUrl)
    const segs = url.pathname.split('/').map((s) => decodeURIComponent(s))
    const abs = resolve(segs.join('/'))
    const base = url.searchParams.get('base')
    const baseAbs = base ? resolve(base) : ''
    if (!ALLOWED_RE.test(abs) && !isUnder(abs, baseAbs)) {
      return { status: 403, body: 'forbidden' }
    }
    const buf = await readFile(abs)
    const mime = MIME[extname(abs).toLowerCase()]
    return {
      status: 200,
      headers: mime ? { 'Content-Type': mime } : undefined,
      body: buf
    }
  } catch (e) {
    // ENOENT vira 404; tudo o mais que cair aqui é 500.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 404, body: 'not found' }
    }
    return { status: 500, body: String(e) }
  }
}
