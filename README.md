# Kid Factory

A local app that makes short illustrated story episodes for kids (about 5 minutes each):
it writes the story, draws the pages, records Thai narration, adds music, exports an MP4, and prepares the
YouTube package (cover picture with the Thai title, title, description, hashtags). The app UI is in Thai.

Story and pictures come from ChatGPT (a ChatGPT Plus plan, through Codex); narration from Gemini TTS.
Characters and places live in one shared sheet library (Settings → ตัวละครและสถานที่): every episode reuses
the same sheets, and a story that needs someone or somewhere new adds a tagged sheet that later episodes reuse.

## Start

Double-click `start.command`. It checks for Node.js and ffmpeg (`brew install node ffmpeg`),
installs dependencies the first time, starts the server on port 4848 (or the next free port
up to 4858) and opens a chromeless app window. Closing the Terminal window stops the app.

### Windows 10/11

Run `KidFactory-Setup-<version>.exe` (from the GitHub release). It installs for the current user only
(no admin), with Node.js and ffmpeg bundled, and adds a "Kid Factory" icon to the Desktop and Start menu.
The icon opens the app in a Microsoft Edge app window; closing that window stops the app.
Uninstall from Settings → Apps; the data folder is kept.

Build the installer on macOS: `scripts/make-win.sh` (needs `brew install makensis`) →
`build/KidFactory-Setup-<version>.exe`. It ships the committed code only.

On first run the app asks for a Gemini API key (for the narration); it is stored only in `config.json` inside the
data folder. Then Settings → "เชื่อมต่อ ChatGPT": the first time it downloads the official Codex app server
(pinned version, SHA-256 checked) into the data folder, then opens the ChatGPT sign-in in the browser.
On a Mac with `codex` already installed, that one is used. When the plan's limit is reached, the app says when
it resets and offers "ใช้ Gemini แทน" for that job.

## Updates

The app checks the latest GitHub release on start (and from "ตรวจหาอัปเดต" in the top bar). When a newer
version exists it shows a banner; "อัปเดตเลย" downloads this platform's package, checks its size and SHA-256,
swaps the app folder (the previous one is kept) and restarts. If the new version does not start within
three minutes, the previous one is put back. The data folder is never touched. Updates are refused while
images, voices or a video are being made.

Release a fix: bump `version` in package.json, commit, write the Thai banner lines into a text file, then
`scripts/make-release.sh notes.txt` and `gh release create v<version> build/release/* --title "Kid Factory <version>" --notes-file <notes>`.
Bundled Node/ffmpeg change only with a new installer (`KidFactory-Setup-<version>.exe`, also in the release).

## Data

Everything generated lives in `~/Documents/KidFactory` by default
(Windows: `%USERPROFILE%\KidFactory`, outside the OneDrive-synced Documents).
Set `KIDFACTORY_DATA=/some/folder` to use another location.

## Fake mode

`KIDFACTORY_FAKE=1 node src/server.mjs` runs with an offline fake AI: no key, no ChatGPT, no cost,
placeholder content. Useful for trying the UI.

## Tests

`npm test` (never calls a real API or a real Codex).
