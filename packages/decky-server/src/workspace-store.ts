import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ipcMain } from 'electron'
import { workspaceStatePath, workspaceDir } from '@decky/shared/node'
import { migrateWorkspaceDir } from './migrate'
import type { DeckyWsServer } from './ws-server'

const FILE = 'workspace.json'

// Serialize writes per-path to avoid clobbering on rapid successive saves.
const writeChains = new Map<string, Promise<void>>()

// Keep the transient workspace state out of git but leave cards/ trackable. Contained
// inside .decky/ — doesn't touch the project's root .gitignore.
async function ensureGitignore(cwd: string): Promise<void> {
  const gi = join(workspaceDir(cwd), '.gitignore')
  try {
    await access(gi)
    return
  } catch {
    // doesn't exist yet
  }
  const body =
    '# decky local-only workspace state. cards/ stay trackable (commit to share project docs,\n' +
    '# or add `cards/` below to keep them private).\n' +
    'workspace.json\n' +
    '*.tmp\n'
  try {
    await writeFile(gi, body)
  } catch {
    // best-effort
  }
}

export async function readWorkspaceFile(cwd: string): Promise<unknown> {
  await migrateWorkspaceDir(cwd)
  try {
    const text = await readFile(workspaceStatePath(cwd, FILE), 'utf-8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function writeWorkspaceFile(cwd: string, state: unknown): Promise<boolean> {
  const prev = writeChains.get(cwd) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      const dest = workspaceStatePath(cwd, FILE)
      await mkdir(dirname(dest), { recursive: true })
      await ensureGitignore(cwd)
      const tmp = dest + '.tmp'
      await writeFile(tmp, JSON.stringify(state, null, 2))
      await rename(tmp, dest)
    })
    .catch((err) => {
      console.error(`[workspace-store] write failed for ${cwd}:`, err)
    })
  writeChains.set(cwd, next)
  await next
  return true
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:read', (_e, cwd: string) => readWorkspaceFile(cwd))
  ipcMain.handle('workspace:write', (_e, cwd: string, state: unknown) =>
    writeWorkspaceFile(cwd, state)
  )
}

export function registerWorkspaceWsHandlers(ws: DeckyWsServer): void {
  ws.handle<{ cwd: string }, unknown>('workspace:read', (args) =>
    readWorkspaceFile(args?.cwd ?? '')
  )
  ws.handle<{ cwd: string; state: unknown }, boolean>('workspace:write', (args) =>
    writeWorkspaceFile(args?.cwd ?? '', args?.state)
  )
}
