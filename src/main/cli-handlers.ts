import { ipcMain } from 'electron'
import { getState, setState } from './state-store'
import { detectAvailableClis, invalidateCliCache } from './cli-detector'
import { getAllCustomPaths, setCustomPath, validatePath, type PathValidation } from './cli-paths'
import {
  CLI_SPECS,
  CLI_KINDS,
  type CliKind,
  type DetectedCli,
  type CliInstallHint
} from '../shared/cli-spec'

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
