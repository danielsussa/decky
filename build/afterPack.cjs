// electron-builder afterPack hook (runs after the app dir is assembled, BEFORE code signing).
//
// `dky-mcp` is spawned by an EXTERNAL plain `node` (claude reads ~/.claude.json and runs
// `node <path>`), so it must resolve its deps from disk — but `@modelcontextprotocol/sdk`
// (and its big closure: express/hono/ajv/jose/zod…) lives INSIDE app.asar, which a non-Electron
// node can't see. Result in the packaged app: "Cannot find package '@modelcontextprotocol/sdk'"
// → the MCP server dies → none of the decky preview tools show up.
//
// Fix: replace the unpacked copy with a single self-contained esbuild bundle (zero runtime
// node_modules dependency). Done here (before signing) so the bundle is covered by the signature.
// The committed bin/dky-mcp stays the readable source — dev runs it directly from the repo where
// node_modules is present, so it never needs bundling.
const path = require('node:path')
const { chmodSync, existsSync, mkdirSync, readFileSync } = require('node:fs')
const esbuild = require('esbuild')

// Guard against the recurring package.json-corruption bug: a stray renderer save has, more than
// once, written the tail of the built index.html on top of package.json, leaving invalid JSON.
// electron-builder copies that verbatim into app.asar; Electron then can't read `main` and the
// app dies instantly on launch ("opens and does nothing", no startup log). Validate here — BEFORE
// signing/install — so a corrupt package.json aborts the build loudly instead of shipping a brick.
function assertValidPackageJson(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json')
  let raw
  try {
    raw = readFileSync(pkgPath, 'utf-8')
  } catch (err) {
    throw new Error(`[afterPack] cannot read ${pkgPath}: ${err.message}`)
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `[afterPack] package.json is CORRUPT (invalid JSON) — refusing to ship a bundle that won't ` +
        `launch. Restore it (\`git checkout -- package.json\`) and rebuild. Parse error: ${err.message}`
    )
  }
  if (!pkg.main) {
    throw new Error('[afterPack] package.json is missing the "main" entry — bundle would not launch.')
  }
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir
  assertValidPackageJson(projectDir)
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const src = path.join(projectDir, 'bin', 'dky-mcp')
  // Two layouts depending on asar: with asar (default), the file lives under
  // app.asar.unpacked/ (per asarUnpack: bin/**). With asar disabled (dev-unpack target),
  // it's just under app/.
  const asarUnpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  const baseDir = existsSync(asarUnpackedDir) ? asarUnpackedDir : path.join(resourcesDir, 'app')
  const out = path.join(baseDir, 'bin', 'dky-mcp')

  mkdirSync(path.dirname(out), { recursive: true })
  await esbuild.build({
    entryPoints: [src],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    allowOverwrite: true
  })
  chmodSync(out, 0o755)
  console.log(`[afterPack] bundled self-contained dky-mcp → ${out}`)
}
