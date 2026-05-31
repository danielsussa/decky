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
// page has no notion of where the .md lives on disk; this protocol bridges that, with an
// allow-list confined to any workspace's .decky/cards/ tree so a malicious card can't read
// arbitrary files.
//
// URL shape: decky-asset:///?p=<url-encoded absolute path>
// Example:   decky-asset:///?p=%2FUsers%2Fuser%2Fproj%2F.decky%2Fcards%2Ffoo%2Fbar.svg

const ALLOWED_RE = /\/\.decky\/cards\//

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
      if (!ALLOWED_RE.test(abs)) return new Response('forbidden', { status: 403 })
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
