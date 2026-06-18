#!/usr/bin/env bash
# setup.sh — instala o decky do zero numa máquina macOS nova.
#
# One-shot: instala deps (recompilando os módulos nativos pra ABI do Electron),
# garante o cert de assinatura local estável, builda o bundle e instala em
# /Applications, e grava o marker de dev (habilita o botão ⟳ Rebuild).
#
# uso:
#   ./setup.sh              # build dev-unpack (rápido) + instala em /Applications
#   ./setup.sh unpack       # build "de verdade" (typecheck + asar + hardened)
#   ./setup.sh --no-install # só builda, não copia pra /Applications
#
# Pré-requisito único que o script NÃO instala: Xcode Command Line Tools
# (necessário pro codesign + node-gyp). Se faltar, ele avisa e roda
# `xcode-select --install` pra você.

set -euo pipefail
cd "$(dirname "$0")"
REPO="$(pwd)"

BUILD_TARGET="dev-unpack"
DO_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    unpack|dev-unpack) BUILD_TARGET="$arg" ;;
    --no-install)      DO_INSTALL=0 ;;
    *) echo "arg desconhecido: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── plataforma ───────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "este script é só pra macOS."

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) DIST_DIR="mac-arm64" ;;
  x86_64) DIST_DIR="mac" ;;   # convenção do electron-builder pra x64
  *) die "arquitetura não suportada: $ARCH" ;;
esac
say "máquina: macOS / $ARCH  →  dist/$DIST_DIR"

# ── Xcode Command Line Tools (codesign + node-gyp) ───────────────────────────
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools ausente — necessário pro codesign e pra compilar"
  warn "os módulos nativos. Vou disparar o instalador; rode o setup de novo quando terminar."
  xcode-select --install || true
  die "instale o Command Line Tools e rode ./setup.sh novamente."
fi

# ── toolchain ────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node não encontrado no PATH."
command -v npm  >/dev/null 2>&1 || die "npm não encontrado no PATH."
say "node $(node -v) / npm $(npm -v)"

# Python do sistema pro node-gyp. O Python 3.14 do Homebrew tem pyexpat quebrado
# (Symbol not found: _XML_SetAllocTrackerActivationThreshold) e mata o node-gyp.
if [ -x /usr/bin/python3 ]; then
  export npm_config_python=/usr/bin/python3
  say "node-gyp usando $npm_config_python ($(/usr/bin/python3 --version 2>&1))"
else
  warn "/usr/bin/python3 não existe — se o npm install falhar no node-gyp, instale o CLT."
fi

# ── deps (postinstall recompila better-sqlite3 + node-pty pra ABI do Electron) ─
say "npm install (recompila módulos nativos pra ABI do Electron)…"
npm install

# ── cert de assinatura local estável ─────────────────────────────────────────
# mac.identity no electron-builder.yml aponta pra "Decky Local Code Signing".
# Sem ele, o empacotamento falha na hora de assinar.
CERT_NAME="Decky Local Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CERT_NAME"; then
  say "cert '$CERT_NAME' já está no keychain."
elif [ -f "$REPO/build/decky-signing.p12" ]; then
  # Importa o cert commitado (mesma identidade da máquina original). TCC é
  # per-máquina, então reusar ou gerar novo dá no mesmo — reusar é 1 passo.
  say "importando cert commitado build/decky-signing.p12…"
  security import "$REPO/build/decky-signing.p12" -k "$KEYCHAIN" -P decky-local -T /usr/bin/codesign \
    || warn "import falhou — caindo no make-signing-cert.sh"
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CERT_NAME"; then
    "$REPO/build/make-signing-cert.sh"
  fi
else
  say "gerando cert de assinatura local…"
  "$REPO/build/make-signing-cert.sh"
fi
security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CERT_NAME" \
  || die "cert '$CERT_NAME' não ficou válido no keychain — veja a nota do make-signing-cert.sh sobre trust."

# ── build ────────────────────────────────────────────────────────────────────
say "build.sh $BUILD_TARGET…"
./build.sh "$BUILD_TARGET"

APP_SRC="$REPO/dist/$DIST_DIR/decky.app"
[ -d "$APP_SRC" ] || die "build não produziu $APP_SRC."

# ── instalar em /Applications (dir diferente do bundle em execução; nunca o mesmo) ─
if [ "$DO_INSTALL" = "1" ]; then
  say "instalando em /Applications/decky.app…"
  # ditto pra um path temporário + rename-swap, pra não mexer num bundle em uso.
  TMP_APP="/Applications/.decky.app.new"
  rm -rf "$TMP_APP"
  ditto "$APP_SRC" "$TMP_APP"
  rm -rf "/Applications/decky.app"
  mv "$TMP_APP" "/Applications/decky.app"
else
  say "--no-install: bundle pronto em $APP_SRC (não copiado pra /Applications)."
fi

# ── marker de dev (habilita ⟳ Rebuild / ⌘⇧B) ─────────────────────────────────
say "gravando ~/.decky/dev.json com o repo desta máquina…"
mkdir -p "$HOME/.decky"
cat > "$HOME/.decky/dev.json" <<EOF
{
  "repo": "$REPO"
}
EOF

# ── fim ──────────────────────────────────────────────────────────────────────
cat <<EOF

$(printf '\033[1;32m✓ pronto.\033[0m')

  • App:    /Applications/decky.app
  • Repo:   $REPO
  • Rebuild: dentro do app, ⌘⇧B (ou o botão ⟳) faz hot-swap dos próximos builds.

  No 1º launch o macOS vai pedir permissões (Documents/Downloads/câmera/mic);
  como o cert é estável, conceder uma vez sobrevive a rebuilds.

  Abrir agora:  open /Applications/decky.app
EOF
