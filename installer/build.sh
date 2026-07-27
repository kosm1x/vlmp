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

# Pinned payloads. NODE_MAJOR selects the portable runtime that ships inside the
# installer. There is no longer an ABI to keep in step with it: both native
# bindings are N-API, so a Node major bump does not need new binaries.
NODE_MAJOR=22
NSSM_VERSION=2.24
NSSM_SHA256=727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743

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

echo "==> better-sqlite3 $BS3_VERSION win32-x64 prebuild (bundled in the npm package)"
# v13 changed how this binding ships. v12 fetched a per-ABI tarball from GitHub
# releases (`prebuild-install || node-gyp rebuild`), which is why this step used
# to pin a version and a SHA256 by hand — a GitHub asset is not integrity-checked
# by npm, so it needed its own control. v13 bundles a prebuild for every platform
# inside the npm tarball and resolves it ahead of any node-gyp output, so:
#   * integrity now rides on package-lock.json's sha512, checked by `npm ci`
#     above — stronger than a hand-copied hash, and it cannot go stale
#   * the binding is N-API, so it survives a Node major bump
# Nothing is downloaded here any more; the staged `npm ci` already placed it.
# Same shape as the bcrypt prune below: keep our platform, drop the other seven
# (~15MB of darwin/linux/musl/arm binaries that no Windows user can load).
find "$STAGE/node_modules/better-sqlite3/prebuilds" -mindepth 1 -maxdepth 1 \
  ! -name 'win32-x64.node' -exec rm -rf {} +
file "$STAGE/node_modules/better-sqlite3/prebuilds/win32-x64.node" | grep -q "PE32+" ||
  { echo "better-sqlite3 win32-x64 prebuild missing from npm package"; exit 1; }
rm -rf "$STAGE/node_modules/better-sqlite3/deps" "$STAGE/node_modules/better-sqlite3/src"

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
