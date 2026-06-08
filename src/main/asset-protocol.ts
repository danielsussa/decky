import { protocol, net } from 'electron'
import { resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
}

// Custom scheme used by markdown cards to reference local files (SVGs, images) via paths
// relative to the .md. ReactMarkdown alone can't resolve relative <img src> because the renderer
// page has no notion of where the .md lives on disk; this protocol bridges that.
//
// Allow-list (request is allowed if EITHER matches):
//   1. Path lives under some `.decky/cards/` tree — covers materialized cards.
//   2. Path lives under the card's own directory, passed as `?base=<abs dir>` — covers
//      preview_show on a stray .md anywhere on disk that references neighbor files.
// Either way a malicious card can only reach files near itself, not arbitrary disk.
//
// URL shape: decky-asset://card/<encoded abs path>?base=<encoded abs dir>
// Example:   decky-asset://card/Users/u/p/img.jpg?base=%2FUsers%2Fu%2Fp

const ALLOWED_RE = /\/\.decky\/cards\//

function isUnder(abs: string, baseDir: string): boolean {
  if (!baseDir) return false
  const normalizedBase = baseDir.endsWith('/') ? baseDir.slice(0, -1) : baseDir
  return abs === normalizedBase || abs.startsWith(normalizedBase + '/')
}

export function registerAssetScheme(): void {
  // Privileged registration must happen BEFORE app is ready. Mark the scheme as standard +
  // secure so the renderer treats it like https for fetch/img purposes. bypassCSP lets us
  // serve images even when the renderer's meta-CSP doesn't list this scheme explicitly.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'decky-asset',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

export function setupAssetProtocol(): void {
  protocol.handle('decky-asset', async (req) => {
    try {
      // URL shape: decky-asset://card/<encoded segments> — authority must be non-empty,
      // Chromium silently drops <img> requests for custom schemes with an empty authority.
      const url = new URL(req.url)
      const segs = url.pathname.split('/').map((s) => decodeURIComponent(s))
      const abs = resolve(segs.join('/'))
      const base = url.searchParams.get('base')
      const baseAbs = base ? resolve(base) : ''
      if (!ALLOWED_RE.test(abs) && !isUnder(abs, baseAbs)) {
        return new Response('forbidden', { status: 403 })
      }
      const fileUrl = pathToFileURL(abs).toString()
      const res = await net.fetch(fileUrl)
      if (!res.ok) return new Response('not found', { status: 404 })
      const mime = MIME[extname(abs).toLowerCase()]
      const buf = await res.arrayBuffer()
      return new Response(buf, {
        status: 200,
        headers: mime ? { 'Content-Type': mime } : undefined
      })
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })
}
