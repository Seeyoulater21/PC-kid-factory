#!/bin/bash
# Build the Windows installer on macOS: build/KidFactory-Setup-<version>.exe
# Bundles Node and ffmpeg (no installs on the PC). Ships the committed code only (git archive HEAD).
# Needs: makensis (brew install makensis), npm, curl, unzip.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION=24.22.0
NODE_SHA256=f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba

VERSION=$(node -p 'require("./package.json").version')
CACHE=build/cache
STAGE="$PWD/build/win" # absolute: makensis runs from the script folder
mkdir -p "$CACHE"

fetch() { # url file sha256
  if [[ ! -f "$CACHE/$2" ]] || ! shasum -a 256 -c <<<"$3  $CACHE/$2" >/dev/null 2>&1; then
    echo "Downloading $2…"
    curl -fL --progress-bar -o "$CACHE/$2" "$1"
    shasum -a 256 -c <<<"$3  $CACHE/$2" >/dev/null || { echo "Checksum mismatch: $2"; exit 1; }
  fi
}
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" "node-$NODE_VERSION-win-x64.zip" "$NODE_SHA256"
fetch "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$FFMPEG_VERSION-essentials_build.zip" "ffmpeg-$FFMPEG_VERSION-essentials.zip" "$FFMPEG_SHA256"

rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$STAGE/runtime"
git archive HEAD package.json package-lock.json src public assets | tar -x -C "$STAGE/app"
(cd "$STAGE/app" && npm ci --omit=dev --os=win32 --cpu=x64 --no-audit --no-fund --loglevel=error)
[[ -d "$STAGE/app/node_modules/@napi-rs/canvas-win32-x64-msvc" ]] || { echo "Windows canvas binary missing"; exit 1; }

unzip -q -j "$CACHE/node-$NODE_VERSION-win-x64.zip" "node-v$NODE_VERSION-win-x64/node.exe" -d "$STAGE/runtime"
unzip -q -j "$CACHE/ffmpeg-$FFMPEG_VERSION-essentials.zip" "*/bin/ffmpeg.exe" "*/bin/ffprobe.exe" -d "$STAGE/runtime"
cp windows/icon.ico "$STAGE/"

makensis -V2 -DSTAGE="$STAGE" windows/launcher.nsi
makensis -V2 -DSTAGE="$STAGE" -DVERSION="$VERSION" -DOUT="$PWD/build/KidFactory-Setup-$VERSION.exe" windows/installer.nsi
echo "Built build/KidFactory-Setup-$VERSION.exe"
