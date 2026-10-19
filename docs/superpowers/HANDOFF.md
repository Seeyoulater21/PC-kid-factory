# Kid Factory v1 handoff

## Status
v0.5.0 released 2026-10-19: plain everyday-lesson stories (#8). v0.4.0 (same day): video look picker (#7). v0.3.0 (same day): takes per page (#6) and the v1 review fixes (#5). v0.2.0 (same day) added the
Windows installer and launcher (#1), the real outro (#3) and the in-app update button (#2).
Installed on the owner's Mac (`/Applications/KidFactory`, open `start.command`) and Windows PC.
Owner data lives outside the code (Mac `~/Documents/KidFactory`, Windows `%USERPROFILE%\KidFactory`).
No owner check per issue for this app: build, test, review, ship, close; the owner tests the whole app later.

## Built
- Gemini client (ideas, story, images, voice, music) with Thai error messages and retry rules
- Story writer, prompts and cast file (`assets/cast.json`), saved ideas and episode library
- Page images and per-page narration, cost estimate (labelled approximate)
- Music library with licence sidecars
- Book-style renderer (page turn, slow zoom), timeline, MP4 export through ffmpeg
- Local server and Thai web UI, offline fake mode
- `start.command` launcher and README
- Windows installer + launcher (`windows/`, `scripts/make-win.sh`), in-app update from GitHub releases with rollback
- Takes: every image/voice per page is kept (`imageTakes`/`voiceTakes`, files p03.jpg, p03-2.jpg…); the page panel
  switches the take in use (`POST /api/episodes/:id/pages/:n/pick`); old takes are never deleted (owner decision)
- Video looks (`LOOKS` in `src/render/book.mjs`): wood desk (default), pastel pink/blue/cream/mint desk, or `full`
  (picture fills the frame, no desk/shadow/stack/spine). `PATCH /api/episodes/:id/look` saves `ep.look` and
  `lastLook` in config (new episodes start with it); the render stores the look in `ep.video.look`, and the
  status asks for a new render when it differs from `ep.look`

## Owner decisions
- Stories are plain everyday lessons (#8): one daily routine, the habit as copyable steps, one short gentle reason,
  one closing lesson line; no magic, pretend, talking objects, twists, refrain or sound words; cat is a background pet
- Characters locked: girl, unnamed boy friend, black cat with a red scarf; style from `assets/characters/origin.jpg`
- Voice: `en-us-sola`; story model: `gemini-3.8-flash`
- Page turn 1.5 s; intro 5 s, outro 15 s (real clips, swappable files)
- Show name: ปิ่นโตเก่งขึ้นทุกวัน
- Episode library: episodes are saved and listed in the app

## Next (GitHub issues)
- #4 Owner check of the first real episode (EP1); story length (285–346 s vs 300 s) is judged there

## How to ship a fix
Bump `version` in package.json (and package-lock.json), commit, then `scripts/make-release.sh notes.txt`
(one short Thai line per change, shown in the app's update banner) and
`gh release create v<version> build/release/* --title "Kid Factory <version>" --notes-file <english notes>`.
Installed copies then update themselves from the in-app banner.

## Deferred minors
- Gemini `missing()` may label an empty reply as refused (needs real refusal samples to fix safely)
- `makeImages`/`makeVoices` mutate the passed episode; WAV format tag unchecked
- Renderer: flap pops in at small width
- Story text cleanup strips every `*` and `_`; `thaiError` treats any message with Thai characters as already Thai
- `intro.mp4` adds 7.8 MB to the repo
- No render cancel button (a time limit stops a hung ffmpeg); `estimateCost` never gets new tracks; EP1 label vs EP01 file name
- Secret scrubbing works on serialized JSON and would break on a key containing `"` or `\`
