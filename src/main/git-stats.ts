import { ipcMain } from 'electron'
import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type DiffStats = { isRepo: boolean; additions: number; deletions: number }

function isGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, '.git'))
}

function run(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) resolve('')
      else resolve(stdout)
    })
  })
}

async function diffStats(cwd: string): Promise<DiffStats> {
  if (!cwd || !isGitRepo(cwd)) return { isRepo: false, additions: 0, deletions: 0 }
  const out = await run('git diff HEAD --numstat', cwd, 1500)
  let add = 0
  let del = 0
  for (const line of out.split('\n')) {
    if (!line) continue
    const [a, d] = line.split('\t')
    // binary files report "-" — skip them
    if (a === '-' || d === '-') continue
    const ai = parseInt(a, 10)
    const di = parseInt(d, 10)
    if (Number.isFinite(ai)) add += ai
    if (Number.isFinite(di)) del += di
  }
  return { isRepo: true, additions: add, deletions: del }
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:diff-stats', (_e, cwd: string) => diffStats(cwd))
}
