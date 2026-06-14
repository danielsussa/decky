import { getState, setState } from './state-store'
import { detectAvailableClis, invalidateCliCache } from './cli-detector'
import { getAllCustomPaths, setCustomPath, validatePath, type PathValidation } from './cli-paths'
import type { DeckyWsServer } from './ws-server'
import {
  CLI_SPECS,
  CLI_KINDS,
  type CliKind,
  type DetectedCli,
  type CliInstallHint
} from '@decky/shared'

function isCliKind(v: unknown): v is CliKind {
  return typeof v === 'string' && (CLI_KINDS as string[]).includes(v)
}

export function getInstallHints(): CliInstallHint[] {
  return CLI_KINDS.map((kind) => ({
    kind,
    displayName: CLI_SPECS[kind].displayName,
    installHint: CLI_SPECS[kind].installHint
  }))
}

// Helpers puros usados tanto pelo handler WS quanto pelo bridge IPC em src/main.
export async function cliGetDefault(): Promise<CliKind | null> {
  const v = await getState<CliKind>('defaultCli')
  return isCliKind(v) ? v : null
}

export async function cliSetDefault(kind: CliKind): Promise<boolean> {
  if (!isCliKind(kind)) throw new Error(`unknown cli kind: ${String(kind)}`)
  await setState('defaultCli', kind)
  return true
}

export async function cliIsFirstRun(): Promise<boolean> {
  const done = await getState<boolean>('firstRunDone')
  return done !== true
}

export async function cliMarkFirstRunDone(): Promise<boolean> {
  await setState('firstRunDone', true)
  return true
}

export async function cliSetPath(kind: CliKind, path: string | null): Promise<DetectedCli[]> {
  if (!isCliKind(kind)) throw new Error(`unknown cli kind: ${String(kind)}`)
  await setCustomPath(kind, path)
  invalidateCliCache()
  return detectAvailableClis()
}

export { validatePath as cliValidatePath } from './cli-paths'

// Versão WS dos mesmos handlers. Cada arg vem como objeto JSON (mais explícito que positional).
export function registerCliWsHandlers(ws: DeckyWsServer): void {
  ws.handle<void, DetectedCli[]>('cli:list', () => detectAvailableClis())

  ws.handle<void, DetectedCli[]>('cli:recheck', () => {
    invalidateCliCache()
    return detectAvailableClis()
  })

  ws.handle<void, CliInstallHint[]>('cli:install-hints', () => getInstallHints())

  ws.handle<void, CliKind | null>('cli:get-default', async () => {
    const v = await getState<CliKind>('defaultCli')
    return isCliKind(v) ? v : null
  })

  ws.handle<{ kind: CliKind }, boolean>('cli:set-default', async (args) => {
    if (!isCliKind(args?.kind)) throw new Error(`unknown cli kind: ${String(args?.kind)}`)
    await setState('defaultCli', args.kind)
    return true
  })

  ws.handle<void, boolean>('cli:is-first-run', async () => {
    const done = await getState<boolean>('firstRunDone')
    return done !== true
  })

  ws.handle<void, boolean>('cli:mark-first-run-done', async () => {
    await setState('firstRunDone', true)
    return true
  })

  ws.handle<void, Partial<Record<CliKind, string>>>('cli:get-paths', () => getAllCustomPaths())

  ws.handle<{ kind: CliKind; path: string | null }, DetectedCli[]>('cli:set-path', async (args) => {
    if (!isCliKind(args?.kind)) throw new Error(`unknown cli kind: ${String(args?.kind)}`)
    await setCustomPath(args.kind, args.path)
    invalidateCliCache()
    return detectAvailableClis()
  })

  ws.handle<{ path: string }, PathValidation>('cli:validate-path', (args) =>
    validatePath(args?.path ?? '')
  )
}
