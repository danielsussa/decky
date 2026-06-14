// Startup diagnostics. Packaged Electron on macOS detaches the main process's stdio, so
// console.log/console.error in a GUI launch never reaches a terminal OR the unified log —
// a crash during startup looks like "decky opens and does nothing" with a 0-byte stdout.
// This writes to a real file (always inspectable) and installs last-resort global handlers
// so an uncaught exception/rejection during init is RECORDED instead of vanishing.
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG = join(homedir(), 'Library', 'Logs', 'decky-startup.log')

function ts(): string {
  // new Date() is fine in app code (the Date restriction is a workflow-script constraint).
  return new Date().toISOString()
}

export function diag(msg: string): void {
  const line = `${ts()} [diag] ${msg}\n`
  try {
    appendFileSync(LOG, line)
  } catch {
    // logs dir should always exist on macOS; ignore if not.
  }
  // Also try stderr — harmless when detached, useful under `npm run dev`.
  try {
    process.stderr.write(line)
  } catch {
    /* ignore */
  }
}

let installed = false
export function installCrashLogging(): void {
  if (installed) return
  installed = true
  diag(`--- main start pid=${process.pid} packaged-ish exec=${process.execPath} ---`)
  process.on('uncaughtException', (err) => {
    diag(`UNCAUGHT EXCEPTION: ${err?.stack || err}`)
  })
  process.on('unhandledRejection', (reason) => {
    diag(`UNHANDLED REJECTION: ${(reason as Error)?.stack || reason}`)
  })
  process.on('exit', (code) => {
    diag(`process exit code=${code}`)
  })
}
