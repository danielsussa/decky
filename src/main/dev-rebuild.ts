import { app, ipcMain, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { deckStateDir } from '@decky/shared/node'
import { loginShellPath } from './pty'
import { diag, type DeckyWsServer } from '@decky/server'

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

// Watchdog ceilings. The renderer's `running` spinner is single-shot — if the child wedges
// (orphan grandchild holding stdio, sandbox stall, hung mv), the IPC promise never resolves
// and the UI is stuck forever. These bound the worst case and force an `error` reply.
const BUILD_TIMEOUT_MS = 6 * 60 * 1000
const STEP_TIMEOUT_MS = 90 * 1000

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { stdio: 'ignore' })
    let settled = false
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        c.kill('SIGKILL')
      } catch {
        // process already gone
      }
      reject(new Error(`${cmd} timed out after ${STEP_TIMEOUT_MS}ms`))
    }, STEP_TIMEOUT_MS)
    c.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      reject(err)
    })
    c.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exit ${code}`))
    })
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
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(code)
    }
    // The build can wedge after the child appears to exit (orphan node/esbuild holds stdio,
    // so `close` never fires). SIGKILL the child group; release the IPC with a non-zero code.
    const t = setTimeout(() => {
      send(`\n✗ build timed out after ${BUILD_TIMEOUT_MS / 1000}s — killing child\n`)
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
      finish(124)
    }, BUILD_TIMEOUT_MS)
    child.stdout.on('data', (b: Buffer) => send(b.toString()))
    child.stderr.on('data', (b: Buffer) => send(b.toString()))
    child.on('error', (err) => {
      send(`spawn error: ${err.message}\n`)
      finish(1)
    })
    child.on('close', (c) => finish(c ?? 1))
  })
}

// JSON-stringified deps block — used to detect when a fast-swap would ship stale
// node_modules (new dep added to package.json but never installed into the bundle).
// Only `dependencies` are compared: electron-builder strips `devDependencies` when
// copying package.json into the bundle (they're build-time only — out/ is precompiled
// against them, so the bundle's runtime never resolves them).
function depsSignature(pkgPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>
    }
    return JSON.stringify(pkg.dependencies ?? {})
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
      [join(repo, 'package.json'), join(swapAppDir, 'package.json')],
      // Native runtime deps the main bundle requires externally (externalizeDepsPlugin keeps
      // them as bare require()s). better-sqlite3 ships a .node that can't be esbuild-bundled, so
      // its runtime closure (better-sqlite3 → bindings → file-uri-to-path) must land on disk in
      // the install's node_modules. The fast-swap clones the prior install's node_modules but a
      // NEWLY-added dep won't be there, so sync each explicitly. Add new native deps here.
      ...['better-sqlite3', 'bindings', 'file-uri-to-path'].map(
        (m): [string, string] => [
          join(repo, 'node_modules', m),
          join(swapAppDir, 'node_modules', m)
        ]
      )
    ]
    send(`→ syncing out/ + bin/ + resources/ + package.json + native deps\n`)
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

async function doRebuild(
  send: (line: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const info = getDevInfo()
  if (!info.enabled || !info.repo) return { ok: false, error: 'dev rebuild not enabled' }
  if (rebuilding) return { ok: false, error: 'already rebuilding' }
  rebuilding = true

  const repo = info.repo
  const explicitTarget = readDevConfig()?.target

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
    //  • built === install — running straight from dist/mac-*/decky.app. Nothing to swap.
    //  • built !== install — running an installed copy. ditto the fresh bundle over it.
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
        await run('mv', [backup, install]).catch(() => {})
        throw err
      }
      // Drop o backup: mesmo CFBundleIdentifier do app vivo, macOS re-prompta TCC.
      await run('rm', ['-rf', backup]).catch(() => {})
    }

    // Don't auto-relaunch: o usuário pode estar ocupado em outra sessão. UI vira botão Restart.
    send('\n✓ built — click Restart when ready\n')
    return { ok: true }
  } catch (err) {
    send(`\n✗ ${(err as Error).message}\n`)
    return { ok: false, error: (err as Error).message }
  } finally {
    rebuilding = false
  }
}

function doRelaunch(): void {
  // LaunchServices (`open <bundle>`) em vez do exec default do app.relaunch — sobrevive ao
  // bundle ter sido swap'd com cdhash novo (exec direto às vezes silently exit nesse caso).
  const bundle = runningBundle()
  diag(`dev:relaunch → ${bundle ? `open ${bundle}` : 'app.relaunch (default exec)'}`)
  if (bundle && process.platform === 'darwin') {
    app.relaunch({ execPath: '/usr/bin/open', args: [bundle] })
  } else {
    app.relaunch()
  }
  app.quit() // goes through before-quit so the workspace state flush still runs
}

export function registerDevRebuildHandlers(
  getWindow: () => BrowserWindow | null,
  getWsServer: () => DeckyWsServer | null
): void {
  // Output streaming: cada linha vai pro renderer (IPC) E pra qualquer WS client conectado.
  const emitOutput = (line: string): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('dev:rebuild-output', line)
    getWsServer()?.broadcast('dev:rebuild-output', line)
  }

  ipcMain.handle('dev:get-info', () => getDevInfo())
  ipcMain.handle('dev:rebuild', () => doRebuild(emitOutput))
  ipcMain.handle('dev:relaunch', () => doRelaunch())

  const ws = getWsServer()
  if (!ws) return
  ws.handle<void, ReturnType<typeof getDevInfo>>('dev:get-info', () => getDevInfo())
  ws.handle<void, { ok: boolean; error?: string }>('dev:rebuild', () => doRebuild(emitOutput))
  ws.handle<void, void>('dev:relaunch', () => doRelaunch())
}
