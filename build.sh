#!/usr/bin/env bash
# build.sh — build/empacota o decky.
#
# uso:
#   ./build.sh             typecheck + electron-vite build (gera out/)
#   ./build.sh unpack      build + electron-builder --dir (app sem instalador)
#   ./build.sh dev-unpack  iteração de dev: sem typecheck, sem asar, sem hardened runtime
#                          (mesmo cert → TCC sobrevive; ~2x mais rápido que unpack)
#   ./build.sh fast        só electron-vite build (gera out/). Usado pelo botão Rebuild p/
#                          hot-swap em loco no /Applications/decky.app — sem electron-builder
#   ./build.sh mac         build + empacota .dmg/.zip (macOS)
#   ./build.sh win         build + empacota instalador Windows
#   ./build.sh linux       build + empacota AppImage/deb (Linux)

set -euo pipefail

cd "$(dirname "$0")"

# Snapshot the current commit so the running app can show "qual versão é essa?" (About panel +
# View → Rebuild label). electron.vite.config.ts reads these and inlines them via vite `define`.
export DECKY_BUILD_SHA="${DECKY_BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
export DECKY_BUILD_DATE="${DECKY_BUILD_DATE:-$(date -u +%Y-%m-%d)}"

target="${1:-build}"

case "$target" in
  build)      npm run build ;;
  unpack)     npm run build:unpack ;;
  dev-unpack) npm run build:dev-unpack ;;
  fast)       npm run build:fast ;;
  mac)        npm run build:mac ;;
  win)        npm run build:win ;;
  linux)      npm run build:linux ;;
  *)
    echo "alvo desconhecido: $target" >&2
    echo "use: build | unpack | dev-unpack | fast | mac | win | linux" >&2
    exit 1
    ;;
esac
