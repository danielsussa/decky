#!/usr/bin/env node
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Build pipeline do decky-server standalone: bundle único JS em dist/decky-server.js a partir
// do entry CLI em bin/decky-server.ts. Native deps ficam EXTERNAL — o binário final é
// distribuído junto com node_modules contendo os prebuilds (better-sqlite3.node, etc).
//
// Próxima PR (Node SEA) empacota o JS + Node runtime num executável só. Pra o JSON file não
// arrastar a árvore inteira de node_modules, mantemos externals pra tudo que tem .node files.

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, 'dist')
mkdirSync(outDir, { recursive: true })

// Deps que NÃO entram no bundle. better-sqlite3 e node-pty têm .node files; marked é
// dinamicamente carregado por createRequire em card-render. ws é puro JS mas grande e
// estável — manter external reduz bundle e permite swap.
const externals = [
  'better-sqlite3',
  'node-pty',
  'bindings',
  'file-uri-to-path',
  'marked',
  'ws',
  // @handoff/runtime-electron NÃO entra no standalone — Electron-specific.
  '@handoff/runtime-electron'
]

const result = await build({
  entryPoints: [join(__dirname, 'bin/decky-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(outDir, 'decky-server.js'),
  external: externals,
  sourcemap: true,
  minify: false,
  // import.meta.url vira `__filename` em CJS. card-render usa createRequire(import.meta.url)
  // pra resolver marked dinamicamente; createRequire aceita path absoluto.
  define: {
    'import.meta.url': '__filename'
  },
  // Sem shebang banner — esbuild emite "use strict" na linha 1 e o shebang acaba na linha 2,
  // o que faz Node rejeitar. Em vez disso, o instalador final cria um wrapper bash:
  // #!/usr/bin/env bash; exec node /path/to/decky-server.js "$@"
  logLevel: 'info'
})

if (result.errors.length) {
  console.error('build errors:', result.errors)
  process.exit(1)
}

console.log(`✓ built ${outDir}/decky-server.js`)
