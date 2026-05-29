import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Claude Code writes an auto-generated `ai-title` into the session .jsonl. Read the
// latest one — it's a stable, persisted name for the session (survives restarts).
export async function readAiTitle(cwd: string, uuid: string): Promise<string | null> {
  // claude encodes cwd by replacing every non-alphanumeric char with '-' (not just '/').
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const p = join(homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`)
  try {
    const text = await readFile(p, 'utf-8')
    let title: string | null = null
    for (const ln of text.split('\n')) {
      if (!ln.includes('"ai-title"')) continue
      try {
        const o = JSON.parse(ln)
        if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle) title = o.aiTitle
      } catch {
        // skip malformed line
      }
    }
    return title
  } catch {
    return null
  }
}

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
