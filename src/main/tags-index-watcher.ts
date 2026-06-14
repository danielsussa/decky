import { watch, type FSWatcher } from 'node:fs'
import { ipcMain } from 'electron'
import { workspaceCardsDir } from '@decky/shared/node'
import { writeTagsIndex, tagsIndexFileName } from '@decky/server'

// Watches each workspace's .decky/cards/ directory; on any change to an .html/.md inside,
// regenerates <cardsDir>/tags-index.html. Ignores changes to the index file itself so
// regen → file event → regen loop is broken.

const watchers = new Map<string, FSWatcher>() // cardsDir -> watcher
const debounces = new Map<string, NodeJS.Timeout>() // cardsDir -> pending timer
const DEBOUNCE_MS = 300

function scheduleRegen(cardsDir: string): void {
  const cur = debounces.get(cardsDir)
  if (cur) clearTimeout(cur)
  const t = setTimeout(() => {
    debounces.delete(cardsDir)
    void writeTagsIndex(cardsDir)
  }, DEBOUNCE_MS)
  debounces.set(cardsDir, t)
}

export async function ensureTagsIndexWatched(workspace: string): Promise<void> {
  const cardsDir = workspaceCardsDir(workspace)
  if (watchers.has(cardsDir)) {
    // Already watched — still regenerate now in case the index file is stale (workspace
    // re-opened after files changed while watcher was down).
    scheduleRegen(cardsDir)
    return
  }
  // Initial bake: write the index now so the first session/tab sees something.
  await writeTagsIndex(cardsDir)
  try {
    const w = watch(cardsDir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        // Best-effort: regen on any unknown event too.
        scheduleRegen(cardsDir)
        return
      }
      // Ignore changes to the index itself.
      const f = String(filename)
      if (f === tagsIndexFileName() || f.endsWith(`/${tagsIndexFileName()}`)) return
      // Only care about .md / .html files (where tags live).
      if (!f.endsWith('.md') && !f.endsWith('.html') && !f.endsWith('.htm')) return
      scheduleRegen(cardsDir)
    })
    w.on('error', (err) => {
      console.error('[tags-index-watcher] watch err:', cardsDir, err)
    })
    watchers.set(cardsDir, w)
  } catch (err) {
    console.error('[tags-index-watcher] could not watch:', cardsDir, err)
  }
}

export function registerTagsIndexHandlers(): void {
  ipcMain.handle('tagsIndex:ensure', async (_e, workspace: string) => {
    await ensureTagsIndexWatched(workspace)
  })
  ipcMain.handle('tagsIndex:rebuild', async (_e, workspace: string) => {
    await writeTagsIndex(workspaceCardsDir(workspace))
  })
  ipcMain.handle('tagsIndex:path', (_e, workspace: string) => {
    return `${workspaceCardsDir(workspace)}/${tagsIndexFileName()}`
  })
}

export function stopAllTagsIndexWatchers(): void {
  for (const t of debounces.values()) clearTimeout(t)
  debounces.clear()
  for (const w of watchers.values()) w.close()
  watchers.clear()
}
