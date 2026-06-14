import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  CLI_SPECS,
  CLI_KINDS,
  type CliKind,
  type CliSpec,
  type DetectedCli
} from '@decky/shared'
import { getCustomPathSync } from './cli-paths'

export type { DetectedCli }

let cache: DetectedCli[] | null = null

/** Resolve a single CLI's absolute path, or null if not installed. */
function resolveBin(spec: CliSpec): string | null {
  // User override (env var or persisted setting) wins over auto-detection so wrapper
  // scripts and custom installs work without changing PATH.
  const override = getCustomPathSync(spec.kind)
  if (override) return override

  try {
    // Login shell picks up user-installed locations (oh-my-zsh, asdf, mise, etc.).
    const out = execSync(`zsh -lc "which ${spec.bin}"`, {
      encoding: 'utf-8',
      timeout: 3000
    }).trim()
    if (out && existsSync(out)) return out
  } catch {
    // fall through to candidates
  }
  for (const c of spec.candidates(homedir())) {
    if (existsSync(c)) return c
  }
  return null
}

function readVersion(bin: string): string | undefined {
  try {
    const out = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 2000 }).trim()
    // Most CLIs print `name x.y.z` or just `x.y.z`. Take the first non-empty line.
    return out.split('\n')[0] || undefined
  } catch {
    return undefined
  }
}

/** Detect all known CLIs. Cached; call `invalidateCliCache()` to recheck. */
export function detectAvailableClis(): DetectedCli[] {
  if (cache) return cache
  const found: DetectedCli[] = []
  for (const kind of CLI_KINDS) {
    const spec = CLI_SPECS[kind]
    const bin = resolveBin(spec)
    if (!bin) continue
    found.push({ kind, displayName: spec.displayName, bin, version: readVersion(bin) })
  }
  cache = found
  return found
}

export function invalidateCliCache(): void {
  cache = null
}

/** Look up a previously-detected CLI by kind. Returns null if not installed. */
export function getDetectedCli(kind: CliKind): DetectedCli | null {
  return detectAvailableClis().find((c) => c.kind === kind) ?? null
}
