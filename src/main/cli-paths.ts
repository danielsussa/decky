import { execSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { CLI_KINDS, type CliKind } from '../shared/cli-spec'
import { getState, setState } from './state-store'

// Stored as { [kind]: absolute path }; null/missing means "no override, use auto-detect".
const STATE_KEY = 'cliPaths'
type CliPathMap = Partial<Record<CliKind, string>>

// In-memory mirror so the sync resolvers (resolveBin, resolveClaudeBin) don't need to await.
// Initialized once at startup via initCliPaths() and kept in sync on every setCustomPath().
let cache: CliPathMap = {}
let hydrated = false

function envVarName(kind: CliKind): string {
  return `DECKY_${kind.toUpperCase()}_BIN`
}

export async function initCliPaths(): Promise<void> {
  if (hydrated) return
  const stored = await getState<CliPathMap>(STATE_KEY)
  cache = stored && typeof stored === 'object' ? { ...stored } : {}
  hydrated = true
}

/**
 * Synchronous override lookup. Env var wins over the persisted setting so a user can
 * temporarily test a wrapper without touching the saved config.
 */
export function getCustomPathSync(kind: CliKind): string | null {
  const env = process.env[envVarName(kind)]
  if (env && existsSync(env)) return env
  const stored = cache[kind]
  if (stored && existsSync(stored)) return stored
  return null
}

export function getAllCustomPaths(): CliPathMap {
  // Reflect env overrides too so the UI shows what's actually in effect.
  const merged: CliPathMap = { ...cache }
  for (const kind of CLI_KINDS) {
    const env = process.env[envVarName(kind)]
    if (env) merged[kind] = env
  }
  return merged
}

export async function setCustomPath(kind: CliKind, path: string | null): Promise<void> {
  if (path === null || path === '') {
    delete cache[kind]
  } else {
    cache[kind] = path
  }
  await setState(STATE_KEY, cache)
}

export interface PathValidation {
  ok: boolean
  error?: string
  version?: string
}

export function validatePath(path: string): PathValidation {
  if (!path) return { ok: false, error: 'caminho vazio' }
  if (!existsSync(path)) return { ok: false, error: 'arquivo não existe' }
  try {
    const st = statSync(path)
    if (!st.isFile()) return { ok: false, error: 'não é um arquivo' }
  } catch (e) {
    return { ok: false, error: `stat falhou: ${(e as Error).message}` }
  }
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return { ok: false, error: 'sem permissão de execução' }
  }
  let version: string | undefined
  try {
    const out = execSync(`"${path}" --version`, { encoding: 'utf-8', timeout: 3000 }).trim()
    version = out.split('\n')[0] || undefined
  } catch {
    // Some wrappers may not implement --version; don't fail validation on that.
  }
  return { ok: true, version }
}
