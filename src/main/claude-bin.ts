import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

let cached: string | null = null

/**
 * Resolve the absolute path to the `claude` CLI.
 * Tries `which claude` first; falls back to common install locations; finally returns 'claude' (PATH lookup at spawn time).
 */
export function resolveClaudeBin(): string {
  if (cached) return cached

  try {
    // Use a login shell so PATH includes user-installed locations (oh-my-zsh, asdf, mise, etc.)
    const out = execSync('zsh -lc "which claude"', { encoding: 'utf-8', timeout: 3000 }).trim()
    if (out && existsSync(out)) {
      cached = out
      return out
    }
  } catch {
    // fall through
  }

  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      cached = c
      return c
    }
  }

  cached = 'claude'
  return cached
}
