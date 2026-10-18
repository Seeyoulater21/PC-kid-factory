#!/bin/bash
# Build everything a release needs into build/release/ (ships the committed code only):
#   KidFactory-Setup-<v>.exe                 Windows installer (first install)
#   KidFactory-<v>-win32-x64.tar.gz          app folder for the in-app updater (Windows)
#   KidFactory-<v>-darwin-arm64.tar.gz       app folder for the in-app updater (Mac)
#   update.json                              version, Thai notes, size + SHA-256 of each package
# Usage: scripts/make-release.sh notes.txt   (one short Thai line per change; shown in the app's update banner)
# Then:  gh release create v<v> build/release/* --title "Kid Factory <v>" --notes-file <english notes>
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES=${1:?usage: scripts/make-release.sh notes.txt}
[[ -z "$(git status --porcelain)" ]] || { echo "Commit first: the release is built from HEAD"; exit 1; }

VERSION=$(node -p 'require("./package.json").version')
OUT=build/release
rm -rf "$OUT" build/mac
mkdir -p "$OUT" build/mac/app

scripts/make-win.sh
cp "build/KidFactory-Setup-$VERSION.exe" "$OUT/"

git archive HEAD package.json package-lock.json src public assets start.command | tar -x -C build/mac/app
(cd build/mac/app && npm ci --omit=dev --os=darwin --cpu=arm64 --no-audit --no-fund --loglevel=error)

export COPYFILE_DISABLE=1 # no macOS ._ files inside the archives
tar -czf "$OUT/KidFactory-$VERSION-win32-x64.tar.gz" -C build/win/app .
tar -czf "$OUT/KidFactory-$VERSION-darwin-arm64.tar.gz" -C build/mac/app .

node - "$VERSION" "$NOTES" "$OUT" <<'JS'
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const [version, notesFile, out] = process.argv.slice(2);
const notes = fs.readFileSync(notesFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const packages = {};
for (const key of ["win32-x64", "darwin-arm64"]) {
  const file = `KidFactory-${version}-${key}.tar.gz`;
  const buf = fs.readFileSync(path.join(out, file));
  packages[key] = { file, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}
fs.writeFileSync(path.join(out, "update.json"), JSON.stringify({ version, notes, packages }, null, 2) + "\n");
JS
ls -lh "$OUT"
