import { watch, type FSWatcher } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'

const DEBOUNCE_MS = 150

export function registerFileWatchHandlers(getWindow: () => BrowserWindow | null): void {
  const refcounts = new Map<string, number>() // abs path -> refcount
  const dirWatchers = new Map<string, FSWatcher>() // dir -> watcher
  const dirPaths = new Map<string, Set<string>>() // dir -> set of watched abs paths
  const debounceTimers = new Map<string, NodeJS.Timeout>()

  const emitChanged = (path: string): void => {
    const prev = debounceTimers.get(path)
    if (prev) clearTimeout(prev)
    debounceTimers.set(
      path,
      setTimeout(() => {
        debounceTimers.delete(path)
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('file:changed', { path })
      }, DEBOUNCE_MS)
    )
  }

  // Watch the parent directory (survives atomic saves that recreate the file inode)
  // and filter events by the exact paths we care about.
  const ensureDirWatcher = (dir: string): void => {
    if (dirWatchers.has(dir)) return
    try {
      const w = watch(dir, (_event, filename) => {
        if (!filename) return
        const full = join(dir, filename.toString())
        if (dirPaths.get(dir)?.has(full)) emitChanged(full)
      })
      dirWatchers.set(dir, w)
    } catch (err) {
      console.error('[file-watcher] watch dir failed:', dir, err)
    }
  }

  ipcMain.handle('file:watch', (_e, path: string) => {
    const n = (refcounts.get(path) ?? 0) + 1
    refcounts.set(path, n)
    if (n === 1) {
      const dir = dirname(path)
      if (!dirPaths.has(dir)) dirPaths.set(dir, new Set())
      dirPaths.get(dir)!.add(path)
      ensureDirWatcher(dir)
    }
    return true
  })

  ipcMain.handle('file:unwatch', (_e, path: string) => {
    const n = (refcounts.get(path) ?? 0) - 1
    if (n > 0) {
      refcounts.set(path, n)
      return true
    }
    refcounts.delete(path)
    const dir = dirname(path)
    const set = dirPaths.get(dir)
    if (set) {
      set.delete(path)
      if (set.size === 0) {
        dirWatchers.get(dir)?.close()
        dirWatchers.delete(dir)
        dirPaths.delete(dir)
      }
    }
    return true
  })

  ipcMain.handle('file:read-text', async (_e, path: string) => {
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  })

  ipcMain.handle('file:read-binary', async (_e, path: string) => {
    try {
      const buf = await readFile(path)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch {
      return null
    }
  })

  ipcMain.handle('file:write', async (_e, path: string, content: string) => {
    try {
      // Safety net for a recurring corruption bug: a stray save has, more than once, written
      // the tail of the built index.html on top of package.json, leaving invalid JSON that
      // bricks the next build (Electron can't read `main` → app won't launch). A renderer save
      // should never put non-JSON into a package.json; refuse it rather than corrupt the file.
      if (basename(path) === 'package.json') {
        try {
          JSON.parse(content)
        } catch {
          console.error('[file-watcher] refusing to write invalid JSON to package.json:', path)
          return false
        }
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf-8')
      return true
    } catch (err) {
      console.error('[file-watcher] write failed:', path, err)
      return false
    }
  })
}
