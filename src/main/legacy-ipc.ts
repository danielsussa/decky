import { ipcMain } from 'electron'
import {
  // state
  getState,
  setState,
  loadAllState,
  // cli
  cliGetDefault,
  cliSetDefault,
  cliIsFirstRun,
  cliMarkFirstRunDone,
  cliSetPath,
  cliValidatePath,
  detectAvailableClis,
  getAllCustomPaths,
  getInstallHints,
  invalidateCliCache,
  // git
  diffStats,
  diffText,
  // workspace
  readWorkspaceFile,
  writeWorkspaceFile,
  // history
  listRecentVisits,
  suggestVisits,
  getWorkspaceMeta,
  setWorkspaceIsolated,
  // widget
  applyWidgetReply
} from '@decky/server'
import type { CliKind } from '@decky/shared'

// IPCs legados do renderer Electron. Quando o preload já fala WS pra todos os domínios, este
// arquivo vira opcional — esses handlers respondem caso o renderer caia pra IPC, mas o caminho
// real é WS. Ficam registrados durante a transição.
export function registerLegacyIpcBridges(): void {
  // state:*
  ipcMain.handle('state:get', (_e, key: string) => getState(key))
  ipcMain.handle('state:set', async (_e, key: string, value: unknown) => {
    await setState(key, value)
    return true
  })
  ipcMain.handle('state:get-all', () => loadAllState())

  // cli:*
  ipcMain.handle('cli:list', () => detectAvailableClis())
  ipcMain.handle('cli:recheck', () => {
    invalidateCliCache()
    return detectAvailableClis()
  })
  ipcMain.handle('cli:install-hints', () => getInstallHints())
  ipcMain.handle('cli:get-default', () => cliGetDefault())
  ipcMain.handle('cli:set-default', (_e, kind: CliKind) => cliSetDefault(kind))
  ipcMain.handle('cli:is-first-run', () => cliIsFirstRun())
  ipcMain.handle('cli:mark-first-run-done', () => cliMarkFirstRunDone())
  ipcMain.handle('cli:get-paths', () => getAllCustomPaths())
  ipcMain.handle('cli:set-path', (_e, kind: CliKind, path: string | null) => cliSetPath(kind, path))
  ipcMain.handle('cli:validate-path', (_e, path: string) => cliValidatePath(path))

  // git:*
  ipcMain.handle('git:diff-stats', (_e, cwd: string) => diffStats(cwd))
  ipcMain.handle('git:diff-text', (_e, cwd: string) => diffText(cwd))

  // workspace:*
  ipcMain.handle('workspace:read', (_e, cwd: string) => readWorkspaceFile(cwd))
  ipcMain.handle('workspace:write', (_e, cwd: string, state: unknown) =>
    writeWorkspaceFile(cwd, state)
  )

  // history:*
  ipcMain.handle('history:list-recent', (_e, payload) => listRecentVisits(payload))
  ipcMain.handle('history:suggest', (_e, payload) => suggestVisits(payload))
  ipcMain.handle('history:get-workspace-meta', (_e, cwd: string) => getWorkspaceMeta(cwd))
  ipcMain.handle('history:set-workspace-isolated', (_e, cwd: string, isolated: boolean) => {
    setWorkspaceIsolated(cwd, isolated)
    return true
  })

  // widget:* — reply chega via send (não handle).
  ipcMain.on('widget:call-reply', (_e, msg) => applyWidgetReply(msg))
}
