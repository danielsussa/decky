import { app, ipcMain, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { deckStateDir } from './paths'
import { loginShellPath } from './pty'

// Dev-only "rebuild & relaunch" button. It exists solely for developing decky against the
// REAL installed .app: the packaged bundle loads its code from inside app.asar (NOT from out/),
// so to see source changes you must repackage the bundle and relaunch it. The button is gated
// on a marker file (`<stateDir>/dev.json` → { repo, target? }) that only the developer's
// machine has — that's what scopes it to "só existe enquanto eu desenvolvo".

interface DevConfig {
  repo: string
  // build.sh target that produces a runnable bundle. Default 'unpack' (electron-builder --dir).
  target?: string
}

export interface DevInfo {
  enabled: boolean
  repo?: string
  accel: string
}

const ACCEL = process.platform === 'darwin' ? 'Cmd+Shift+B' : 'Ctrl+Shift+B'

function readDevConfig(): DevConfig | null {
  try {
    const raw = readFileSync(join(deckStateDir(), 'dev.json'), 'utf-8')
    const cfg = JSON.parse(raw) as DevConfig
    return cfg && typeof cfg.repo === 'string' ? cfg : null
  } catch {
    return null
  }
}

function getDevInfo(): DevInfo {
  // Only meaningful for the packaged macOS app — that's the bundle the swap+relaunch targets.
  if (!app.isPackaged || process.platform !== 'darwin') return { enabled: false, accel: ACCEL }
  const cfg = readDevConfig()
  if (!cfg || !existsSync(join(cfg.repo, 'build.sh'))) return { enabled: false, accel: ACCEL }
  return { enabled: true, repo: cfg.repo, accel: ACCEL }
}

// The running .app bundle root, derived from the executable path
// (/Applications/decky.app/Contents/MacOS/decky → /Applications/decky.app).
function runningBundle(): string | null {
  const m = app.getPath('exe').match(/^(.*\.app)\//)
  return m ? m[1] : null
}

// The freshly built bundle under dist/ (electron-builder --dir → dist/mac-<arch>/<product>.app).
function builtBundle(repo: string): string | null {
  const dist = join(repo, 'dist')
  try {
    for (const d of readdirSync(dist)) {
      if (!d.startsWith('mac')) continue
      const p = join(dist, d, 'decky.app')
      if (existsSync(p)) return p
    }
  } catch {
    // dist missing
  }
  return null
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'ignore' })
    c.on('error', reject)
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))))
  })
}

let rebuilding = false

export function registerDevRebuildHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('dev:get-info', () => getDevInfo())

  ipcMain.handle('dev:rebuild', async (): Promise<{ ok: boolean; error?: string }> => {
    const info = getDevInfo()
    if (!info.enabled || !info.repo) return { ok: false, error: 'dev rebuild not enabled' }
    if (rebuilding) return { ok: false, error: 'already rebuilding' }
    rebuilding = true

    const repo = info.repo
    const target = readDevConfig()?.target || 'unpack'
    const send = (line: string): void => {
      const w = getWindow()
      if (w && !w.isDestroyed()) w.webContents.send('dev:rebuild-output', line)
    }

    try {
      send(`$ ./build.sh ${target}\n`)
      const code = await new Promise<number>((resolve) => {
        const child = spawn('bash', ['build.sh', target], {
          cwd: repo,
          // GUI launch gives the app launchd's minimal PATH; build.sh → npm/electron-builder
          // need the user's real toolchain (nvm/homebrew/node). Same fix pty.ts uses for claude.
          env: { ...process.env, FORCE_COLOR: '0', PATH: loginShellPath() }
        })
        child.stdout.on('data', (b: Buffer) => send(b.toString()))
        child.stderr.on('data', (b: Buffer) => send(b.toString()))
        child.on('error', (err) => {
          send(`spawn error: ${err.message}\n`)
          resolve(1)
        })
        child.on('close', (c) => resolve(c ?? 1))
      })
      if (code !== 0) {
        send(`\n✗ build failed (exit ${code})\n`)
        return { ok: false, error: `build exit ${code}` }
      }

      const built = builtBundle(repo)
      const install = runningBundle()
      if (!built) {
        send('\n✗ built .app not found under dist/mac-*/\n')
        return { ok: false, error: 'built app not found' }
      }
      if (!install) {
        send('\n✗ could not resolve the running .app bundle\n')
        return { ok: false, error: 'install bundle not found' }
      }

      // Two cases, depending on where decky was launched from:
      //
      //  • built === install — running straight from dist/mac-*/decky.app (the dev's normal
      //    case). electron-builder already overwrote that bundle in place; the live process
      //    survived on its unlinked inodes. Nothing to swap — just relaunch the same path.
      //
      //  • built !== install — running an installed copy (e.g. /Applications). Building wrote to
      //    dist/, so we ditto the fresh bundle over the running one. Renaming the running .app
      //    aside is safe on macOS (the live process keeps its mmap'd inode); relaunch fires only
      //    after we exit.
      if (built !== install) {
        send(`\n→ swapping build into ${install}\n`)
        const staging = `${install}.new`
        const backup = `${install}.bak`
        await run('rm', ['-rf', staging])
        await run('ditto', [built, staging])
        await run('rm', ['-rf', backup])
        await run('mv', [install, backup])
        try {
          await run('mv', [staging, install])
        } catch (err) {
          // Restore the original so we never leave the user without an app.
          await run('mv', [backup, install]).catch(() => {})
          throw err
        }
      }

      // Don't auto-relaunch: the user may be busy in another decky session and a rebuild can
      // take a while. The renderer flips to a "Restart" button and fires dev:relaunch when the
      // user is ready. The bundle on disk is already the new one — only the live process is old.
      send('\n✓ built — click Restart when ready\n')
      return { ok: true }
    } catch (err) {
      send(`\n✗ ${(err as Error).message}\n`)
      return { ok: false, error: (err as Error).message }
    } finally {
      rebuilding = false
    }
  })

  ipcMain.handle('dev:relaunch', () => {
    app.relaunch() // re-spawns process.execPath (= the now-updated bundle) after exit
    app.quit() // goes through before-quit so the workspace state flush still runs
  })
}
