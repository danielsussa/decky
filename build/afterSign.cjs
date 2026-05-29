// electron-builder afterSign hook (runs after signing, before the DMG/zip are built).
//
// Ad-hoc signing (no Developer ID) on recent macOS leaves the Electron Framework's signature
// inconsistent with the main binary ("Library not loaded ... different Team IDs" → SIGABRT at
// launch). A single deep ad-hoc re-sign fixes it; doing it here means the packaged .app AND the
// DMG/zip ship launchable. No-op on non-mac and when a real signing identity is configured.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  // Only needed for the ad-hoc / unsigned case; a real identity already signs consistently.
  const identity = context.packager.platformSpecificBuildOptions?.identity
  if (identity && identity !== null && identity !== '-') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`[afterSign] deep ad-hoc re-sign: ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
