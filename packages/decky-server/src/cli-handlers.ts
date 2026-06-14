import { ipcMain } from 'electron'
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

export function registerCliHandlers(): void {
  ipcMain.handle('cli:list', (): DetectedCli[] => detectAvailableClis())

  ipcMain.handle('cli:recheck', (): DetectedCli[] => {
    invalidateCliCache()
    return detectAvailableClis()
  })

  ipcMain.handle('cli:install-hints', (): CliInstallHint[] => getInstallHints())

  ipcMain.handle('cli:get-default', async (): Promise<CliKind | null> => {
    const v = await getState<CliKind>('defaultCli')
    return isCliKind(v) ? v : null
  })

  ipcMain.handle('cli:set-default', async (_e, kind: CliKind): Promise<true> => {
    if (!isCliKind(kind)) throw new Error(`unknown cli kind: ${String(kind)}`)
    await setState('defaultCli', kind)
    return true
  })

  ipcMain.handle('cli:is-first-run', async (): Promise<boolean> => {
    const done = await getState<boolean>('firstRunDone')
    return done !== true
  })

  ipcMain.handle('cli:mark-first-run-done', async (): Promise<true> => {
    await setState('firstRunDone', true)
    return true
  })

  ipcMain.handle('cli:get-paths', (): Partial<Record<CliKind, string>> => getAllCustomPaths())

  ipcMain.handle(
    'cli:set-path',
    async (_e, kind: CliKind, path: string | null): Promise<DetectedCli[]> => {
      if (!isCliKind(kind)) throw new Error(`unknown cli kind: ${String(kind)}`)
      await setCustomPath(kind, path)
      invalidateCliCache()
      return detectAvailableClis()
    }
  )

  ipcMain.handle('cli:validate-path', (_e, path: string): PathValidation => validatePath(path))
}

// Versão WS dos mesmos handlers. Cada arg vem como objeto JSON (mais explícito que positional)
// — `cli:set-path` espera { kind, path } em vez de (kind, path). Roda em paralelo aos IPCs
// na Fase 2; quando o preload migrar pra WS (PR seguinte), os ipcMain.handle viram redundantes.
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
