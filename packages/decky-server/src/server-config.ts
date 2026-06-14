import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

// Config persistido do decky-server standalone — host, porta, token bearer. Vive em
// $DECKY_SERVER_DIR/ (default ~/.decky-server). Token é gerado uma vez no init e nunca muda
// (a não ser via `decky-server token rotate` futuro). Mode 600 pra escondê-lo de outros users
// do OS.
//
// Embedded mode (Electron com server embarcado) NÃO usa este config — o token fica null e
// só processo local consegue conectar via loopback (o additionalArguments do main passa a URL
// com porta livre direto pro preload).

const DEFAULT_DIR = process.env.DECKY_SERVER_DIR || join(homedir(), '.decky-server')
const TOKEN_FILE = 'admin-token.txt'

export function serverDir(): string {
  return DEFAULT_DIR
}

function tokenPath(): string {
  return join(serverDir(), TOKEN_FILE)
}

/** Gera um token novo, escreve em disco (mode 600), e devolve. */
export function generateAndSaveToken(): string {
  mkdirSync(serverDir(), { recursive: true })
  const token = `d-${randomBytes(24).toString('base64url')}`
  writeFileSync(tokenPath(), token + '\n', 'utf-8')
  try {
    chmodSync(tokenPath(), 0o600)
  } catch {
    // best-effort em Windows
  }
  return token
}

/** Lê o token persistido. Devolve null se ainda não foi gerado. */
export function readSavedToken(): string | null {
  try {
    if (!existsSync(tokenPath())) return null
    return readFileSync(tokenPath(), 'utf-8').trim() || null
  } catch {
    return null
  }
}

/** Lê o token; se não existir, gera. */
export function ensureToken(): string {
  const saved = readSavedToken()
  if (saved) return saved
  return generateAndSaveToken()
}
