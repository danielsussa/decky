#!/usr/bin/env bash
# build.sh — build/empacota o decky.
#
# uso:
#   ./build.sh            typecheck + electron-vite build (gera out/)
#   ./build.sh unpack     build + electron-builder --dir (app sem instalador)
#   ./build.sh mac        build + empacota .dmg/.zip (macOS)
#   ./build.sh win        build + empacota instalador Windows
#   ./build.sh linux      build + empacota AppImage/deb (Linux)

set -euo pipefail

cd "$(dirname "$0")"

target="${1:-build}"

case "$target" in
  build)  npm run build ;;
  unpack) npm run build:unpack ;;
  mac)    npm run build:mac ;;
  win)    npm run build:win ;;
  linux)  npm run build:linux ;;
  *)
    echo "alvo desconhecido: $target" >&2
    echo "use: build | unpack | mac | win | linux" >&2
    exit 1
    ;;
esac
