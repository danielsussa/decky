import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ipcMain } from 'electron'

const DECK_DIR = '.deck'
const FILE = 'workspace.json'

// Serialize writes per-path to avoid clobbering on rapid successive saves.
const writeChains = new Map<string, Promise<void>>()

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:read', async (_e, cwd: string) => {
    try {
      const text = await readFile(join(cwd, DECK_DIR, FILE), 'utf-8')
      return JSON.parse(text)
    } catch {
      return null
    }
  })

  ipcMain.handle('workspace:write', async (_e, cwd: string, state: unknown) => {
    const prev = writeChains.get(cwd) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const dir = join(cwd, DECK_DIR)
        await mkdir(dir, { recursive: true })
        const tmp = join(dir, FILE + '.tmp')
        await writeFile(tmp, JSON.stringify(state, null, 2))
        await rename(tmp, join(dir, FILE))
      })
      .catch((err) => {
        console.error(`[workspace-store] write failed for ${cwd}:`, err)
      })
    writeChains.set(cwd, next)
    await next
    return true
  })
}
