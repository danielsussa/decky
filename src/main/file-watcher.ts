import { watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  applyAutoFix,
  readTextFile,
  readBinaryFile,
  writeTextFile,
  type DeckyWsServer
} from '@decky/server'

const DEBOUNCE_MS = 150

// Watcher state vive aqui no shim por enquanto — vira broadcast WS unificado quando o
// transport for o único caminho. Hoje emite NOS DOIS canais (IPC pro Electron renderer +
// WS pra qualquer client conectado), pra a migração ficar reversível.
export function registerFileWatchHandlers(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): void {
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
        // Card .mds: auto-repair broken `![](...)` refs before notifying the renderer, so a
        // wrong path written by an author/agent renders correctly (and the .md becomes
        // filesystem-correct, so VSCode/GitHub render it too). The fix's own write will
        // re-fire the watcher; the second pass finds nothing broken and is a no-op, so the
        // loop converges in one extra cycle.
        const isCardMd = path.endsWith('.md') && path.includes('/.decky/cards/')
        const finish = (): void => {
          const win = getWindow()
          if (win && !win.isDestroyed()) win.webContents.send('file:changed', { path })
          getWsServer()?.broadcast('file:changed', { path })
        }
        if (isCardMd) {
          void applyAutoFix(path).finally(finish)
        } else {
          finish()
        }
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

  function watchPath(path: string): boolean {
    if (!path) return false
    const n = (refcounts.get(path) ?? 0) + 1
    refcounts.set(path, n)
    if (n === 1) {
      const dir = dirname(path)
      if (!dirPaths.has(dir)) dirPaths.set(dir, new Set())
      dirPaths.get(dir)!.add(path)
      ensureDirWatcher(dir)
    }
    // First-open auto-fix: a card written by an agent (or with stale paths from a rename)
    // gets repaired on first open, before the renderer's read. Fire-and-forget; if it
    // rewrites the file, the watcher set up above picks up the change and the renderer
    // gets a fresh `file:changed` with the fixed content moments later.
    if (path.endsWith('.md') && path.includes('/.decky/cards/')) {
      void applyAutoFix(path)
    }
    return true
  }

  function unwatchPath(path: string): boolean {
    if (!path) return false
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
  }

  // ── IPC (legado, sai quando file:* completamente migrar pro WS) ────────────
  ipcMain.handle('file:watch', (_e, path: string) => watchPath(path))
  ipcMain.handle('file:unwatch', (_e, path: string) => unwatchPath(path))
  ipcMain.handle('file:read-text', (_e, path: string) => readTextFile(path))
  ipcMain.handle('file:read-binary', (_e, path: string) => readBinaryFile(path))
  ipcMain.handle('file:write', (_e, path: string, content: string) => writeTextFile(path, content))

  // ── WS (canal real do remote engine) ───────────────────────────────────────
  // file:read-binary fica de fora — Uint8Array não serializa por JSON. Vira quando o
  // protocolo aceitar binário (base64 ou frames ArrayBuffer).
  const ws = getWsServer()
  if (!ws) return
  ws.handle<{ path: string }, boolean>('file:watch', (args) => watchPath(args?.path ?? ''))
  ws.handle<{ path: string }, boolean>('file:unwatch', (args) => unwatchPath(args?.path ?? ''))
  ws.handle<{ path: string }, string | null>('file:read-text', (args) =>
    readTextFile(args?.path ?? '')
  )
  ws.handle<{ path: string; content: string }, boolean>('file:write', (args) =>
    writeTextFile(args?.path ?? '', args?.content ?? '')
  )
}
