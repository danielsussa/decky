import { protocol } from 'electron'
import { resolveAssetRequest } from '@decky/server'

// Custom scheme usado por markdown cards pra referenciar arquivos locais (SVGs, imagens) via
// paths relativos ao .md. ReactMarkdown sozinho não resolve <img src> relativo porque a
// renderer page não sabe onde o .md mora no disco; este protocol faz a ponte.
//
// Toda a resolução vive em @decky/server/asset-protocol (puro). Este shim só lida com a
// integração Electron: registro privileged + adapter de Response.

export function registerAssetScheme(): void {
  // Registro privileged DEVE acontecer ANTES do app ready. Marca como standard + secure pra
  // que o renderer trate como https pra fetch/img. bypassCSP permite servir imagens mesmo
  // quando o meta-CSP do renderer não lista esse scheme explicitamente.
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
    const res = await resolveAssetRequest(req.url)
    // Buffer<ArrayBufferLike> de readFile() ≠ BodyInit no TS 5.7 (mismatch de generics, OK
    // em runtime — fetch.Response aceita Buffer normalmente).
    return new Response((res.body ?? null) as BodyInit | null, {
      status: res.status,
      headers: res.headers
    })
  })
}
