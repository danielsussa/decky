#!/usr/bin/env bash
# make-signing-cert.sh — cria UMA vez um certificado self-signed ESTÁVEL pra assinar
# o decky localmente, de modo que o macOS (TCC) pare de re-pedir permissões a cada
# build/install.
#
# Por que: ad-hoc signing (codesign --sign -) gera um CDHash novo a cada build, e o
# TCC pina cada permissão concedida nesse CDHash. Build novo => CDHash novo => o macOS
# acha que é "outro app" => re-pergunta tudo. Um cert real (mesmo self-signed) ancora o
# "designated requirement" no CERTIFICADO, não no CDHash, então sobrevive a rebuilds.
#
# Rode UMA vez. Não regere o cert depois — um cert diferente faria o TCC pedir tudo de
# novo. Guarde o .p12 gerado como backup.
#
#   ./build/make-signing-cert.sh
#
set -euo pipefail

CERT_NAME="Decky Local Code Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P12_OUT="$SCRIPT_DIR/decky-signing.p12"

echo "==> certificado de assinatura local do decky"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$CERT_NAME"; then
  echo "✓ identidade '$CERT_NAME' já existe no keychain — nada a fazer."
  echo "  (regerar mudaria o cert e faria o TCC pedir tudo de novo)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.conf" <<EOF
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = v3
[ dn ]
CN = $CERT_NAME
[ v3 ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "==> gerando chave + certificado (validade 10 anos)…"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.conf" 2>/dev/null

# -legacy: o macOS `security import` não lê o formato PKCS12 padrão do OpenSSL 3
# (MAC SHA-256 / AES) → "MAC verification failed". Forçamos os algoritmos antigos.
P12_PW="decky-local"
openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$CERT_NAME" -out "$P12_OUT" -passout "pass:$P12_PW"

echo "==> importando no login keychain…"
security import "$P12_OUT" -k "$KEYCHAIN" -P "$P12_PW" -T /usr/bin/codesign

echo "==> marcando o cert como confiável pra code signing…"
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" 2>/dev/null \
  || echo "   (não consegui marcar trust automático — veja a nota no fim se find-identity não listar)"

echo
echo "==> liberar o codesign a usar a chave sem pop-up a cada build."
echo "    Digite sua SENHA DE LOGIN do macOS (ou só Enter pra pular e clicar"
echo "    'Sempre Permitir' no diálogo do 1º build):"
read -rs LOGIN_PW || true
echo
if [ -n "${LOGIN_PW:-}" ]; then
  if security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$LOGIN_PW" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "✓ partition-list ajustada — sem pop-up de keychain nos próximos builds."
  else
    echo "⚠ não consegui ajustar a partition-list (senha errada?). No 1º build clique 'Sempre Permitir'."
  fi
else
  echo "ok — no 1º build, se aparecer o diálogo do keychain, clique 'Sempre Permitir'."
fi

echo
echo "==> identidades de code signing disponíveis:"
if security find-identity -v -p codesigning | grep -F "$CERT_NAME"; then
  :
else
  echo "⚠ '$CERT_NAME' não apareceu como VÁLIDA. Provavelmente falta trust. Rode:"
  echo "    security add-trusted-cert -r trustRoot -p codeSign -k \"$KEYCHAIN\" <caminho-do-cert.pem>"
  echo "  (ou crie o cert pelo Keychain Access > Certificate Assistant, tipo Code Signing)"
fi

echo
echo "✓ pronto."
echo "  Backup do cert: $P12_OUT"
echo "  GUARDE esse .p12 — ele (mesmo CN + chave) é o que mantém o TCC feliz entre builds."
echo "  NÃO rode este script de novo nem regere o cert."
echo
echo "  Próximo passo: ./build.sh mac (ou build:unpack). O electron-builder vai assinar"
echo "  com '$CERT_NAME' (ver mac.identity no electron-builder.yml)."
