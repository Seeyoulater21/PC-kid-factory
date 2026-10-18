# Kid Factory v1 handoff

## Status
v0.1.0 released 2026-10-18 (macOS MVP). Installed on the owner's Mac at `/Applications/KidFactory`
(open `start.command` there). Owner data lives outside the code (`~/Documents/KidFactory`).
Real-API smoke test passed (one page image + voice through the shipped code). Since the first
review the home screen became the episode library ("+ สร้างเรื่องใหม่" → new-story screen) and each
episode has a left sidebar (steps + back/next).

## Built
- Gemini client (ideas, story, images, voice, music) with Thai error messages and retry rules
- Story writer, prompts and cast file (`assets/cast.json`), saved ideas and episode library
- Page images and per-page narration, cost estimate (labelled approximate)
- Music library with licence sidecars
- Book-style renderer (page turn, slow zoom), timeline, MP4 export through ffmpeg
- Local server and Thai web UI, offline fake mode
- `start.command` launcher and README

## Owner decisions
- Characters locked: girl, unnamed boy friend, black cat with a red scarf; style from `assets/characters/origin.jpg`
- Voice: `en-us-sola`; story model: `gemini-3.8-flash`
- Page turn 1.5 s; intro and outro 5 s each, swappable files
- Show name: ปิ่นโตเก่งขึ้นทุกวัน
- Episode library: episodes are saved and listed in the app

## Next (GitHub issues)
- #1 Windows PC version — the real target is the friend's PC
- #2 In-app update button (friend updates by themselves after a fix is released)
- #3 Real outro clip (placeholder in use)
- #4 Owner check of the first real episode (EP1)
- #5 Deferred small fixes from the v1 reviews (summary of the list below)

## How to ship a fix
Bump `version` in package.json, commit, push, `gh release create v<version>` with a source zip
(`git archive --format=zip -o KidFactory-<version>.zip HEAD`), then reinstall `/Applications/KidFactory`
(unzip + `npm ci`). Once #2 exists the app updates itself from the release.

## Deferred minors
- Gemini: free-tier/quota regexes may treat transient 429s as "credit"; `missing()` may mislabel empty as refused; timeout shows the "no internet" text
- `readConfig` returns `{}` on corrupt JSON, so `saveKey` drops other fields; same pattern in `listSavedIdeas`
- Ideas prompt safety list omits stoves/sockets; cat regex may flag "cat-eared"; cast names hard-coded beside `cast.json`
- Stories run 285-346 s against the 300 s target
- `makeImages`/`makeVoices` mutate the passed episode; WAV format tag unchecked
- Music: corrupt sidecars skipped silently, `addTrack` overwrites an existing id, LRU never-used ordering untested
- Renderer: zoom not clamped; flap shadow not clipped, flap pops in at small width
- Story text cleanup strips every `*` and `_`
- `thaiError` treats any message with Thai characters as already Thai
- `intro.mp4` adds 7.8 MB to the repo
- Render has no timeout/cancel; `estimateCost` never gets new tracks; EP1 label vs EP01 file name
- Secret scrubbing works on serialized JSON and would break on a key containing `"` or `\`
