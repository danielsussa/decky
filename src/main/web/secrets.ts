// Credential lookup for web automation (used by adapters; the `decky web secret get` CLI reads the
// Keychain directly without a server round-trip). Ported from handoff sdk/secrets.ts.
//
// Priority: macOS Keychain service "decky", then "handoff" (so creds already stored for handoff keep
// working during the consolidation), then process.env[UPPER_SNAKE(name)]. Returns null if none.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const SERVICES = ['decky', 'handoff']

export function envKeyFor(account: string): string {
  return account.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

async function fromKeychain(service: string, account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('security', [
      'find-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w'
    ])
    const v = stdout.replace(/\n$/, '')
    return v.length > 0 ? v : null
  } catch {
    return null // not in this keychain service, or not macOS
  }
}

export async function getSecret(account: string): Promise<string | null> {
  for (const service of SERVICES) {
    const v = await fromKeychain(service, account)
    if (v != null) return v
  }
  return process.env[envKeyFor(account)] ?? null
}

export async function requireSecret(account: string): Promise<string> {
  const v = await getSecret(account)
  if (v == null) {
    throw new Error(
      `secret "${account}" not found. Store it with:\n` +
        `  security add-generic-password -s decky -a ${account} -U -A -w\n` +
        `(or set ${envKeyFor(account)} in the environment)`
    )
  }
  return v
}
