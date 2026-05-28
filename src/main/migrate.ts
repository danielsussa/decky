import { cp, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { deckStateDir, workspaceDir } from './paths'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// One-time, non-destructive copy of pre-rename data into the new decky locations (after the
// deck→decky rename). Leaves the old dirs in place. Idempotent: skips if the new one exists.

// Global config (~/.deck → ~/.decky). Stable only — dev state is disposable.
export async function migrateGlobalState(): Promise<void> {
  if (process.env.DECKY_DEV) return
  const dest = deckStateDir()
  const src = join(homedir(), '.deck')
  if (dest === src || (await exists(dest)) || !(await exists(src))) return
  try {
    await cp(src, dest, { recursive: true })
    console.log(`[migrate] ${src} → ${dest}`)
  } catch (err) {
    console.warn('[migrate] global failed:', err)
  }
}

// Per-workspace (<cwd>/.deck → <cwd>/.decky, or .deck-dev → .decky-dev for the dev instance).
export async function migrateWorkspaceDir(cwd: string): Promise<void> {
  const dest = workspaceDir(cwd)
  const src = join(cwd, process.env.DECKY_DEV ? '.deck-dev' : '.deck')
  if (dest === src || (await exists(dest)) || !(await exists(src))) return
  try {
    await cp(src, dest, { recursive: true })
    console.log(`[migrate] ${src} → ${dest}`)
  } catch (err) {
    console.warn('[migrate] workspace failed:', err)
  }
}
