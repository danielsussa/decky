import { app, ipcMain, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { deckStateDir } from './paths'
import { loginShellPath } from './pty'
import { diag } from './diag'

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

export function getDevInfo(): DevInfo {
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

function runBuild(
  repo: string,
  target: string,
  send: (line: string) => void
): Promise<number> {
  return new Promise<number>((resolve) => {
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
}

// JSON-stringified deps block — used to detect when a fast-swap would ship stale
// node_modules (new dep added to package.json but never installed into the bundle).
function depsSignature(pkgPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return JSON.stringify({
      d: pkg.dependencies ?? {},
      // devDeps matter too: vite plugins live there and a swap would yield an out/
      // built against versions the bundle's node_modules doesn't carry.
      e: pkg.devDependencies ?? {}
    })
  } catch {
    return ''
  }
}

interface FastSwapEligibility {
  ok: boolean
  reason?: string
}

// Fast-swap requires the install in the loose (asar-disabled) layout AND matching
// package.json deps — otherwise the swapped main bundle would reference missing modules.
function checkFastSwapEligibility(repo: string, install: string): FastSwapEligibility {
  const looseAppDir = join(install, 'Contents', 'Resources', 'app')
  const asarFile = join(install, 'Contents', 'Resources', 'app.asar')
  if (existsSync(asarFile)) return { ok: false, reason: 'install is asar-packed' }
  if (!existsSync(looseAppDir)) return { ok: false, reason: 'install has no Resources/app/' }
  const repoSig = depsSignature(join(repo, 'package.json'))
  const installSig = depsSignature(join(looseAppDir, 'package.json'))
  if (!repoSig || !installSig) return { ok: false, reason: 'cannot read package.json' }
  if (repoSig !== installSig) return { ok: false, reason: 'package.json deps changed' }
  return { ok: true }
}

const SIGNING_IDENTITY = 'Decky Local Code Signing'

// Hot-swap path: skip electron-builder entirely. APFS-clone the install (instant on
// same-volume APFS), overwrite just the source-derived bits (out/, bin/, resources/,
// package.json), re-sign the clone, then mv it into place over the running install.
// The running process keeps its mmap'd inodes on the .bak; relaunch picks the new clone.
async function fastSwap(
  repo: string,
  install: string,
  send: (line: string) => void
): Promise<{ ok: boolean; error?: string }> {
  send(`$ ./build.sh fast\n`)
  const code = await runBuild(repo, 'fast', send)
  if (code !== 0) {
    send(`\n✗ build failed (exit ${code})\n`)
    return { ok: false, error: `build exit ${code}` }
  }

  const swap = `${install}.swap`
  const backup = `${install}.bak`
  send(`\n→ APFS-cloning install → ${swap}\n`)
  await run('rm', ['-rf', swap, backup])
  // -c = APFS clonefile (COW, ~ms for a ~1GB bundle on the same volume)
  await run('cp', ['-cR', install, swap])

  try {
    const swapAppDir = join(swap, 'Contents', 'Resources', 'app')
    const syncs: Array<[string, string]> = [
      [join(repo, 'out'), join(swapAppDir, 'out')],
      [join(repo, 'bin'), join(swapAppDir, 'bin')],
      [join(repo, 'resources'), join(swapAppDir, 'resources')],
      [join(repo, 'package.json'), join(swapAppDir, 'package.json')]
    ]
    send(`→ syncing out/ + bin/ + resources/ + package.json\n`)
    for (const [src, dst] of syncs) {
      await run('rm', ['-rf', dst])
      await run('ditto', [src, dst])
    }

    // Re-sign WITHOUT --deep: we only changed files inside Resources/app/, so just
    // the top-level code object needs its resource hash recomputed. Helpers and
    // the Electron Framework are untouched and keep their existing signatures.
    send(`→ re-signing (top-level only)\n`)
    const entitlements = join(repo, 'build', 'entitlements.mac.plist')
    await run('codesign', [
      '--force',
      '--sign',
      SIGNING_IDENTITY,
      '--entitlements',
      entitlements,
      swap
    ])

    // Swap in place. Renaming the running install aside is safe: the live process
    // keeps its mmap'd inodes on the .bak path. Cleanup the .bak immediately to
    // avoid TCC re-prompting on the duplicate CFBundleIdentifier next launch.
    await run('mv', [install, backup])
    try {
      await run('mv', [swap, install])
    } catch (err) {
      await run('mv', [backup, install]).catch(() => {})
      throw err
    }
    await run('rm', ['-rf', backup]).catch(() => {})
  } catch (err) {
    await run('rm', ['-rf', swap]).catch(() => {})
    throw err
  }

  send('\n✓ fast-swap done — click Restart when ready\n')
  return { ok: true }
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
    const explicitTarget = readDevConfig()?.target
    const send = (line: string): void => {
      const w = getWindow()
      if (w && !w.isDestroyed()) w.webContents.send('dev:rebuild-output', line)
    }

    try {
      const install = runningBundle()
      if (!install) {
        send('\n✗ could not resolve the running .app bundle\n')
        return { ok: false, error: 'install bundle not found' }
      }

      // Default path: hot-swap in place (no electron-builder). Skipped when dev.json
      // sets target explicitly (user wants the full prod-shaped build) or when the
      // install layout / deps don't line up for a safe swap.
      if (!explicitTarget) {
        const elig = checkFastSwapEligibility(repo, install)
        if (elig.ok) return await fastSwap(repo, install, send)
        send(`(fast-swap not eligible: ${elig.reason}) — falling back to dev-unpack\n`)
      }

      // Fallback / explicit-target path: full electron-builder build → ditto bundle.
      const target = explicitTarget || 'dev-unpack'
      send(`$ ./build.sh ${target}\n`)
      const code = await runBuild(repo, target, send)
      if (code !== 0) {
        send(`\n✗ build failed (exit ${code})\n`)
        return { ok: false, error: `build exit ${code}` }
      }

      const built = builtBundle(repo)
      if (!built) {
        send('\n✗ built .app not found under dist/mac-*/\n')
        return { ok: false, error: 'built app not found' }
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
        // Drop the backup: same CFBundleIdentifier as the live app, so macOS
        // treats it as a second install and re-prompts TCC ("decky.app.bak
        // would like to access data from other apps") on every launch.
        await run('rm', ['-rf', backup]).catch(() => {})
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
    // Relaunch through LaunchServices (`open <bundle>`) instead of app.relaunch()'s default
    // direct exec of process.execPath. After a rebuild we just `mv`'d a freshly self-signed
    // bundle into place; LaunchServices re-registers its new cdhash, whereas a bare direct
    // exec of the just-swapped bundle was seen to silently exit ("rebuild → won't open").
    // app.relaunch still owns the wait-for-this-PID-to-die handoff; we only swap WHAT it runs.
    const bundle = runningBundle()
    diag(`dev:relaunch → ${bundle ? `open ${bundle}` : 'app.relaunch (default exec)'}`)
    if (bundle && process.platform === 'darwin') {
      app.relaunch({ execPath: '/usr/bin/open', args: [bundle] })
    } else {
      app.relaunch()
    }
    app.quit() // goes through before-quit so the workspace state flush still runs
  })
}
