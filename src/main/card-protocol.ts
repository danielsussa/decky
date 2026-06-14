import { protocol, session, type Session } from 'electron'
import { resolveCardRequest } from '@decky/server'

// Substitui o velho http://127.0.0.1 (html-server) por scheme custom card://. Os arquivos
// continuam em <workspace>/.decky[-dev]/cards/; URLs viram card://ws-<8hex>/relative/path.html
// e SÓ Electron WebContents nesta app resolvem — nada em localhost vê nem hita.
//
// Toda a resolução (paths, MIME, CSS default, widgets, marked rewrite, deletion) vive em
// @decky/server/card-protocol. Este shim só registra o scheme em duas sessions (default +
// persist:deckweb pra web cards) e adapta {status, headers, body} → Electron Response.

export { cardUrlFor, cardUrlToAbsPath } from '@decky/server'

export function registerCardScheme(): void {
  // Registro privileged DEVE rodar ANTES do app.whenReady. Standard + secure faz a página
  // carregar como se fosse https (fetch/CORS/cookies se comportam normal). supportFetchAPI é
  // necessário pro fetch('/__decky/cards/delete'). bypassCSP evita brigas com meta-CSP quando
  // cards puxam marked do esm.sh.
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

const cardHandler = async (req: GlobalRequest): Promise<GlobalResponse> => {
  // POST /__decky/cards/delete usa body JSON; só faz parse se for esse caso.
  let json: unknown = undefined
  if (req.method === 'POST') {
    try {
      json = await req.json()
    } catch {
      // resolveCardRequest devolve 400 se faltar id
    }
  }
  const res = await resolveCardRequest({ url: req.url, method: req.method, json })
  // Buffer<ArrayBufferLike> de readFile() ≠ BodyInit no TS 5.7 (mismatch de generics, OK
  // em runtime — fetch.Response aceita Buffer normalmente).
  return new Response((res.body ?? null) as BodyInit | null, {
    status: res.status,
    headers: res.headers
  })
}

// Registra também na persist:deckweb session usada pelos WebContentsView dos card pages —
// senão URLs card:// só resolvem no renderer, não dentro de web cards.
export function setupCardProtocol(): void {
  protocol.handle('card', cardHandler)
  try {
    const webSession: Session = session.fromPartition('persist:deckweb')
    webSession.protocol.handle('card', cardHandler)
  } catch (e) {
    console.error('[card-protocol] failed to register on web session:', e)
  }
}
