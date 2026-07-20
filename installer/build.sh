#!/usr/bin/env bash
# Builds the VLMP Windows installer (.exe) from Linux/macOS.
# Needs: node/npm, curl, tar, unzip, sha256sum, file, makensis (apt install nsis).
# Output: installer/dist/vlmp-setup-<version>-win-x64.exe
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST="$ROOT/installer"
STAGE="$INST/staging/app"
CACHE="$INST/cache"
OUT="$INST/dist"

# Pinned payloads. Node major and its module ABI move together (Node 22 = 127);
# bump both when moving to a new Node line, and re-check that better-sqlite3
# publishes a prebuilt for that ABI.
NODE_MAJOR=22
NODE_ABI=127
NSSM_VERSION=2.24
NSSM_SHA256=727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743
# better-sqlite3 prebuilt pin — a native binary shipped to every Windows user
# must not ride on an unverified GitHub asset. Bump version + hash together.
BS3_PIN_VERSION=12.6.2
BS3_SHA256=2609fd25d59c4c16b43758c1fb2b4afa653925e04941cadae5be28f2d6cd2dc8

VERSION=$(node -p "require('$ROOT/package.json').version")
BS3_VERSION=$(node -p "require('$ROOT/node_modules/better-sqlite3/package.json').version")

command -v makensis >/dev/null || { echo "makensis not found (apt install nsis)"; exit 1; }

echo "==> Building server (tsc)"
(cd "$ROOT" && npm run build)

echo "==> Staging app files"
rm -rf "$INST/staging" "$OUT"
mkdir -p "$STAGE" "$CACHE" "$OUT"
cp -r "$ROOT/dist/server" "$STAGE/server"
mkdir -p "$STAGE/client"
cp -r "$ROOT/client/public" "$STAGE/client/public"
rm -rf "$STAGE/client/public/previews" # design mockups, not part of the app
cp "$ROOT/package.json" "$STAGE/"      # nearest package.json must carry "type": "module"

echo "==> Production node_modules (install scripts skipped; native bindings swapped below)"
cp "$ROOT/package-lock.json" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
rm -rf "$STAGE/node_modules/.bin" "$STAGE/package-lock.json"

echo "==> better-sqlite3 $BS3_VERSION win32-x64 prebuilt (node ABI $NODE_ABI)"
[ "$BS3_VERSION" = "$BS3_PIN_VERSION" ] ||
  { echo "better-sqlite3 is now $BS3_VERSION but the prebuilt pin is $BS3_PIN_VERSION — update BS3_PIN_VERSION + BS3_SHA256"; exit 1; }
BS3_TGZ="$CACHE/better-sqlite3-v$BS3_VERSION-node-v$NODE_ABI-win32-x64.tar.gz"
[ -f "$BS3_TGZ" ] || curl -fsSL -o "$BS3_TGZ" \
  "https://github.com/WiseLibs/better-sqlite3/releases/download/v$BS3_VERSION/better-sqlite3-v$BS3_VERSION-node-v$NODE_ABI-win32-x64.tar.gz"
echo "$BS3_SHA256  $BS3_TGZ" | sha256sum -c --quiet
mkdir -p "$STAGE/node_modules/better-sqlite3/build/Release"
tar -xzf "$BS3_TGZ" -C "$STAGE/node_modules/better-sqlite3" # ships build/Release/better_sqlite3.node
file "$STAGE/node_modules/better-sqlite3/build/Release/better_sqlite3.node" | grep -q "PE32+" ||
  { echo "better-sqlite3 prebuilt is not a Windows PE binary"; exit 1; }
rm -rf "$STAGE/node_modules/better-sqlite3/deps" # sqlite source, build-time only

# bcrypt ships every platform's prebuild in the npm package — keep only ours.
find "$STAGE/node_modules/bcrypt/prebuilds" -mindepth 1 -maxdepth 1 ! -name win32-x64 -exec rm -rf {} +
file "$STAGE/node_modules/bcrypt/prebuilds/win32-x64/"*.node | grep -q "PE32+" ||
  { echo "bcrypt win32-x64 prebuild missing from npm package"; exit 1; }

echo "==> Portable Node.js (latest v$NODE_MAJOR win-x64, checksum-verified)"
SHAS=$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt")
NODE_ZIP_NAME=$(echo "$SHAS" | grep -oE "node-v$NODE_MAJOR[0-9.]*-win-x64\.zip" | head -1)
NODE_SHA=$(echo "$SHAS" | awk -v f="$NODE_ZIP_NAME" '$2 == f { print $1 }')
[ -n "$NODE_ZIP_NAME" ] && [ -n "$NODE_SHA" ] || { echo "could not resolve Node win-x64 zip from SHASUMS"; exit 1; }
NODE_ZIP="$CACHE/$NODE_ZIP_NAME"
if ! { [ -f "$NODE_ZIP" ] && echo "$NODE_SHA  $NODE_ZIP" | sha256sum -c --status; }; then
  curl -fsSL -o "$NODE_ZIP" "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$NODE_ZIP_NAME"
  echo "$NODE_SHA  $NODE_ZIP" | sha256sum -c --quiet
fi
mkdir -p "$STAGE/node"
unzip -p "$NODE_ZIP" "*/node.exe" >"$STAGE/node/node.exe"
unzip -p "$NODE_ZIP" "*/LICENSE" >"$STAGE/node/LICENSE"
file "$STAGE/node/node.exe" | grep -q "PE32+" || { echo "extracted node.exe is not a Windows PE binary"; exit 1; }

echo "==> NSSM $NSSM_VERSION (service helper)"
NSSM_ZIP="$CACHE/nssm-$NSSM_VERSION.zip"
[ -f "$NSSM_ZIP" ] || curl -fsSL -o "$NSSM_ZIP" "https://nssm.cc/release/nssm-$NSSM_VERSION.zip"
echo "$NSSM_SHA256  $NSSM_ZIP" | sha256sum -c --quiet
mkdir -p "$STAGE/nssm"
unzip -p "$NSSM_ZIP" "nssm-$NSSM_VERSION/win64/nssm.exe" >"$STAGE/nssm/nssm.exe"

echo "==> Launcher + service scripts (CRLF for cmd.exe)"
for f in start-vlmp.cmd install-service.cmd remove-service.cmd vlmp.env.example; do
  sed 's/\r$//; s/$/\r/' "$INST/windows/$f" >"$STAGE/$f"
done

echo "==> makensis"
(cd "$INST" && makensis -V2 -DVERSION="$VERSION" vlmp.nsi)

EXE="$OUT/vlmp-setup-$VERSION-win-x64.exe"
[ -f "$EXE" ] || { echo "makensis did not produce $EXE"; exit 1; }
echo "==> Done"
ls -lh "$EXE"
sha256sum "$EXE"
