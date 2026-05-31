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
const { chmodSync, mkdirSync } = require('node:fs')
const esbuild = require('esbuild')

exports.default = async function afterPack(context) {
  const projectDir = context.packager.info.projectDir
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const src = path.join(projectDir, 'bin', 'dky-mcp')
  const out = path.join(resourcesDir, 'app.asar.unpacked', 'bin', 'dky-mcp')

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
