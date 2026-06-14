import { ipcMain } from 'electron'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DeckyWsServer } from './ws-server'

export type DiffStats = {
  isRepo: boolean
  additions: number
  deletions: number
  branch?: string
}

function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, '.git'))
}

function run(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve('')
      else resolve(stdout)
    })
  })
}

async function diffStats(cwd: string): Promise<DiffStats> {
  if (!cwd || !isGitRepo(cwd)) return { isRepo: false, additions: 0, deletions: 0 }
  const [numstat, headRef] = await Promise.all([
    run('git diff HEAD --numstat', cwd, 1500),
    run('git rev-parse --abbrev-ref HEAD', cwd, 1500)
  ])
  let add = 0
  let del = 0
  for (const line of numstat.split('\n')) {
    if (!line) continue
    const [a, d] = line.split('\t')
    // binary files report "-" — skip them
    if (a === '-' || d === '-') continue
    const ai = parseInt(a, 10)
    const di = parseInt(d, 10)
    if (Number.isFinite(ai)) add += ai
    if (Number.isFinite(di)) del += di
  }
  const branchRaw = headRef.trim()
  // Detached HEAD prints "HEAD" — show short sha in that case so the chip still has signal.
  let branch = branchRaw || undefined
  if (branchRaw === 'HEAD') {
    const sha = (await run('git rev-parse --short HEAD', cwd, 1500)).trim()
    branch = sha ? `(${sha})` : 'HEAD'
  }
  return { isRepo: true, additions: add, deletions: del, branch }
}

async function diffText(cwd: string): Promise<string> {
  if (!cwd || !isGitRepo(cwd)) return ''
  return run('git diff HEAD', cwd, 4000)
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:diff-stats', (_e, cwd: string) => diffStats(cwd))
  ipcMain.handle('git:diff-text', (_e, cwd: string) => diffText(cwd))
}

export function registerGitWsHandlers(ws: DeckyWsServer): void {
  ws.handle<{ cwd: string }, DiffStats>('git:diff-stats', (args) => diffStats(args?.cwd ?? ''))
  ws.handle<{ cwd: string }, string>('git:diff-text', (args) => diffText(args?.cwd ?? ''))
}
