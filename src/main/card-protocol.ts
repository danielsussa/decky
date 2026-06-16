import { protocol, session, type Session } from 'electron'
import { resolveCardRequest } from '@decky/server'
import { resolveRemoteCardRequest } from './remote-card-fetcher'

// Substitui o velho http://127.0.0.1 (html-server) por scheme custom card://. Os arquivos
// continuam em <workspace>/.decky[-dev]/cards/; URLs viram card://ws-<8hex>/relative/path.html
// e SÓ Electron WebContents nesta app resolvem — nada em localhost vê nem hita.
//
// Toda a resolução LOCAL (paths, MIME, CSS default, widgets, marked rewrite, deletion) vive em
// @decky/server/card-protocol. Este shim:
//   - registra o scheme em duas sessions (default + persist:deckweb pra web cards);
//   - INTERCEPTA hosts remotos (resolveRemoteCardRequest) ANTES do resolver local, lendo o
//     arquivo via WS no engine remoto — sem isso, cards de workspaces remotos batiam ENOENT.

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
  // Host remoto? Lê via WS no engine dono. Retorna null se host é local — flui pro resolver
  // local. GET-only por enquanto (POST delete continua roteado pra @decky/server local; a
  // listagem do cards remoto vem por outro caminho).
  if (req.method === 'GET') {
    const remote = await resolveRemoteCardRequest({ url: req.url, method: req.method })
    if (remote) {
      return new Response((remote.body ?? null) as BodyInit | null, {
        status: remote.status,
        headers: remote.headers
      })
    }
  }
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
