import { ipcMain } from 'electron'
import { ensureTagsIndexWatched, rebuildTagsIndex, tagsIndexPath } from '@decky/server'

// IPC bridge — toda lógica de watcher vive em @decky/server.
export function registerTagsIndexHandlers(): void {
  ipcMain.handle('tagsIndex:ensure', async (_e, workspace: string) => {
    await ensureTagsIndexWatched(workspace)
  })
  ipcMain.handle('tagsIndex:rebuild', async (_e, workspace: string) => {
    await rebuildTagsIndex(workspace)
  })
  ipcMain.handle('tagsIndex:path', (_e, workspace: string) => tagsIndexPath(workspace))
}
