import { writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain } from 'electron'
import { cardFilePath } from './paths'

// Serialize writes per-file so rapid successive updates to the same card don't clobber.
const writeChains = new Map<string, Promise<void>>()

// Main owns where a card file lives (<workspace>/.decky/cards/<id>.md). The renderer only
// passes (workspace, cardId, content) and gets back the resolved abs path to store on the
// source + watch. Returns null on failure.
export function registerCardsHandlers(): void {
  ipcMain.handle(
    'cards:write',
    async (_e, workspace: string, cardId: string, content: string): Promise<string | null> => {
      const path = cardFilePath(workspace, cardId)
      const prev = writeChains.get(path) ?? Promise.resolve()
      let ok = true
      const next = prev
        .then(async () => {
          await mkdir(dirname(path), { recursive: true })
          const tmp = path + '.tmp'
          await writeFile(tmp, content, 'utf-8')
          await rename(tmp, path)
        })
        .catch((err) => {
          ok = false
          console.error(`[cards-store] write failed for ${path}:`, err)
        })
      writeChains.set(path, next)
      await next
      return ok ? path : null
    }
  )
}
