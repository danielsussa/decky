import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Caminho do socket Unix por sessão de pty. UM socket POR SESSÃO em
// /tmp/handoff-decky-<sessionId>.sock — cada pty exporta HANDOFF_SOCKET apontando pro seu,
// então o CLI/SDK/MCP do handoff spawnado dentro da sessão cai no backend isolado. Resolve
// o vazamento cross-session que o socket global (/tmp/handoff-decky.sock) tinha.
export function sessionHandoffSocketPath(sessionId: string): string {
  // sessionId vem do pty (DECKY_SESSION_ID); slugify defensivamente — hoje é UUID mas se um
  // dia for arbitrário, não quero `/` no path.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(tmpdir(), `handoff-decky-${safe}.sock`)
}

// address-bar → URL canônica. Mesmo afordance do normalizeAddress dos outros hosts:
//  - já tem scheme suportado → mantém
//  - localhost / 127.0.0.1 → assume http://
//  - tem ponto e nada de espaço → assume https:// (domain.tld)
//  - resto → vira busca no Google
export function normalizeAddressBarUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return 'about:blank'
  if (/^(https?|file|about|data|chrome):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?(\/|$)/i.test(s))
    return `http://${s}`
  if (/^[^\s]+\.[^\s]{2,}/.test(s) && !/\s/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
