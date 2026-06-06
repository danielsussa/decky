import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Não externalizar o pacote do monorepo handoff (shipado como source TS): o bundler compila
    // junto. Os demais deps de node_modules seguem externalizados.
    plugins: [externalizeDepsPlugin({ exclude: ['@handoff/runtime-electron'] })]
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
