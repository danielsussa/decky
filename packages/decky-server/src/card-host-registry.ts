import { createHash } from 'node:crypto'
import { join, relative, resolve as resolvePath } from 'node:path'

// Registry de hosts pro scheme card://. Cada workspace cards-dir vira um host slug estável
// (8 hex do SHA1 do path absoluto), pra URLs serem reproduzíveis entre launches.
// Puro — sem Electron API. Tanto o protocol.handle do main quanto rotas HTTP do server
// (em modo remoto) usam este registry pra mapear host → dir e vice-versa.

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

export function getCardsDirForHost(host: string): string | null {
  return hostToDir.get(host) ?? null
}

// URL builder usado pelo renderer-bridge: devolve a URL card:// completa pra um arquivo.
export function cardUrlFor(absPath: string, cardsDir: string): string {
  const host = registerCardsDir(cardsDir)
  const rel = relative(cardsDir, absPath)
  return `card://${host}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

// Sobe a partir de um path de arquivo até achar um segmento `.decky/cards` ou `.decky-dev/cards`;
// devolve o prefixo inteiro (o cards-root). null se não houver. Usado pelo html:resolve pra
// determinar qual diretório registrar como host de card://.
export function findCardsRoot(absPath: string): string | null {
  const m = absPath.match(/^(.+\/\.decky(?:-dev)?\/cards)\//)
  return m ? m[1] : null
}

// Reverso de cardUrlFor: card://host/path → arquivo absoluto no disco. Usado pelo renderer
// quando will-navigate intercepta um clique e pergunta "que arquivo essa URL aponta?".
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
