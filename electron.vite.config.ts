import { resolve } from 'path'
import { execSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Snapshot the build identity at vite-config eval time so the main bundle can show it
// (About panel, View → Rebuild label). build.sh exports these envs before invoking the build;
// `npm run dev` falls back to reading git so the dev process still has a real sha.
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}
const buildSha = process.env.DECKY_BUILD_SHA || gitShortSha()
const buildDate = process.env.DECKY_BUILD_DATE || new Date().toISOString().slice(0, 10)
const buildDefines = {
  __DECKY_BUILD_SHA__: JSON.stringify(buildSha),
  __DECKY_BUILD_DATE__: JSON.stringify(buildDate)
}

export default defineConfig({
  main: {
    // Não externalizar packages do monorepo (shipados como source TS): o bundler compila
    // junto. Os demais deps de node_modules seguem externalizados.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@handoff/runtime-electron', '@decky/server', '@decky/shared']
      })
    ],
    define: buildDefines
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
