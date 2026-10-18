# Kid Factory v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the owner's Mac, a double-clickable local app turns a topic into a finished picture-book MP4 (topic → 3 ideas → story pages → images + Thai voice → page-turn video with music and intro/outro).

**Architecture:** A dependency-light Node server (`src/`) serves a plain HTML/JS UI (`public/`) and a JSON API; all AI calls go to the Gemini Interactions API through one client module; episodes live as JSON + media files in a data folder in the user's home. Video frames (book, paper, page turn, slow zoom) are drawn with a canvas library and piped as raw frames into ffmpeg; audio is assembled in Node and mixed by ffmpeg.

**Tech Stack:** Node ≥ 20 (ESM, built-in `fetch`, `node:test`), `@napi-rs/canvas` (prebuilt binaries for macOS arm64 and Windows x64 — no compiler needed), ffmpeg/ffprobe (Homebrew on the Mac for v1; bundled in v2). No web framework, no build step.

**Spec:** `docs/superpowers/specs/2026-10-18-kid-factory-design.md` (read it first; the look reference is `docs/superpowers/specs/page-flip-reference.html`).

## Global Constraints

- Repo is **PUBLIC**: never commit keys, the friend's channel name, the style-reference book's name/images, or third-party textures. Commit hooks block private words; never bypass them (`--no-verify` forbidden).
- The Gemini key is stored only in `<dataDir>/config.json`; never logged, never returned by any API route, never in error messages.
- One AI provider: Gemini Interactions API `POST https://generativelanguage.googleapis.com/v1beta/interactions`, header `x-goog-api-key`.
- Models (one constant `MODELS` in `src/gemini.mjs`): ideas `gemini-3.8-flash`, story `gemini-4-argon`, image `gemini-nano-banana-2.1`, voice `gemini-3.8-flash-tts`, music `lyria-3.5`.
- Images: `response_format: {type:"image", mime_type:"image/png", aspect_ratio:"16:9", image_size:"2K"}`; up to 5 character reference images per call (we send 3 main sheets + up to 2 extra).
- UI copy in **Thai**; code, comments, commits, docs in English.
- Picture + narration only: **no text drawn on pages, no subtitles.** Prompts must forbid text/letters in images.
- Narration: one **Thai female** narrator for the whole episode.
- Page budget: about 4 pages per minute; a ~5-minute episode has **at most 20 pages** (allowed 12–20).
- Page turn **1.5 s**; slow zoom while a page is held; intro and outro **5 s** each, swappable files.
- Main characters (locked): น้องปิ่นโต (girl), เพื่อน (unnamed boy), a cat friend unlike the reference cats. Side characters allowed, style matters more than identity.
- Style traits (words only): flat vector, no 3D shading, thick clean black outlines, bright flat saturated colors, big round eyes, pink dash blush, full-bleed uncluttered scenes.
- Music: only Lyria-generated or verifiably royalty-free tracks; every track has a sidecar with source + licence + date.
- Paths: all generated files are named by ids (`p01.png`), never by Thai titles; only the exported MP4 carries the Thai title. Paths with spaces and Thai characters must work.
- Video: 1920×1080, 30 fps, H.264 `yuv420p`, AAC 48 kHz stereo, loudness −14 LUFS integrated.

## Review Focus

1. Gemini refuses or returns no image/audio for one page → that page shows a plain Thai error with ↻; other pages keep going; nothing crashes. (Task 6 test `one failed page does not stop the others`.)
2. Narration edited after its voice was made → voice marked stale; render is refused with "เสียงหน้า N ยังไม่อัปเดต". (Task 6 test `editing narration marks voice stale`; Task 9 test `render refuses stale voice`.)
3. Bad key / no credit / rate limit (HTTP 400/401/403/429) → plain Thai message, key never appears in the message or logs. (Task 1 test `errors are Thai and never contain the key`.)
4. App closed mid-generation → on reopen pages left `working` become `todo`, no stuck spinner. (Task 5 test `loading resets working pages to todo`.)
5. Data folder or episode title with spaces and Thai characters → generation and render still work. (Task 9 test `renders when paths contain spaces and Thai`.)

---

## File Structure

```
package.json            scripts: start, test; deps: @napi-rs/canvas
.gitignore              node_modules/, .DS_Store
start.command           macOS double-click launcher
src/server.mjs          HTTP server: static files, JSON API, job runner, opens app window
src/data.mjs            data folder layout + config (key) read/write
src/gemini.mjs          Interactions client: text/json, image, speech, music; retries; Thai errors
src/prompts.mjs         prompt builders (ideas, story, page image) — the core creative asset
src/story.mjs           ideas(topic), writeStory(idea), validateStory()
src/episodes.mjs        episode + saved-ideas store
src/pages.mjs           per-page image + voice generation, stale tracking
src/music.mjs           music library: list, pick by mood, generate
src/audio.mjs           WAV read/write, durations, narration track assembly
src/timeline.mjs        pure: pages + durations → timed segments
src/render/paper.mjs    procedural paper texture
src/render/book.mjs     draws one frame: desk, page stack, page, page turn
src/render/video.mjs    frames → ffmpeg, audio mix, intro/outro concat, export
public/index.html, public/app.js, public/style.css   the four screens
assets/characters/      pinto.png, friend.png, cat.png, characters.md (Task 2)
assets/style.md         style prompt text (Task 2)
assets/clips/intro.mp4, outro.mp4   placeholders (Task 9), replaced by owner's real clips
scripts/spike.mjs       Task 3 real-API spike (kept as a dev tool)
scripts/make-placeholder-clips.mjs
test/*.test.mjs
```

Data folder: `<home>/KidFactory/` (override with env `KIDFACTORY_DATA` for tests) containing `config.json`, `saved-ideas.json`, `episodes/<id>/episode.json` + `img/`, `voice/`, `out/`, and `music/<trackId>.mp3` + `.json`.

---

### Task 1: Project scaffold, data folder, Gemini client

**Files:**
- Create: `package.json`, `.gitignore`, `src/data.mjs`, `src/gemini.mjs`
- Test: `test/data.test.mjs`, `test/gemini.test.mjs`

**Interfaces:**
- Produces:
  - `dataDir(): string`; `readConfig(): {key?: string}`; `saveKey(key: string): void`; `hasKey(): boolean`
  - `MODELS` (values in Global Constraints)
  - `createGemini({key, fetch = globalThis.fetch, sleep}): Gemini` with
    - `json(model, prompt: string, schema: object): Promise<any>` — `response_format {type:"text", mime_type:"application/json", schema}`, returns parsed object
    - `image(prompt: string, refs: {data: Buffer, mime: string}[]): Promise<Buffer>` — PNG bytes
    - `speech(text: string, {voice, style}): Promise<Buffer>` — WAV bytes (body shape below)
    - `music(prompt: string): Promise<Buffer>` — MP3 bytes
  - `class GeminiError extends Error { code: "key"|"credit"|"busy"|"refused"|"network"|"empty"; thai: string }`

Speech body (proven in the owner's other project):
```json
{"model": "...", "input": [{"type":"user_input","content":[{"type":"text","text":"...",
  "annotations":[{"type":"speech_metadata","style":"..."}]}]}],
 "response_format":{"type":"audio"}, "generation_config":{"speech_config":[{"voice":"..."}]}}
```
Outputs for all calls: iterate `resp.steps` where `type == "model_output"`, take the last `content` block of the wanted `type` (`text` → `.text`, `image`/`audio` → base64 `.data`).

- [ ] **Step 1: Write failing tests** — `test/gemini.test.mjs` with a fake `fetch`:
  - `json parses model_output text` → returns `{a: 1}` from a step `{type:"model_output", content:[{type:"text", text:'{"a":1}'}]}`
  - `image sends refs and 16:9 2K` → captured body has 1 text + N `{type:"image", mime_type, data}` parts and `response_format.aspect_ratio === "16:9"`, `image_size === "2K"`
  - `retries 429 then succeeds` → fake returns 429, 429, 200; result ok; `sleep` called twice
  - `errors are Thai and never contain the key` → 400 (`API key not valid`) ⇒ `code "key"`; 403 ⇒ `"key"`; 429 after 4 retries ⇒ `"busy"`; body mentioning quota/billing ⇒ `"credit"`; response without image ⇒ `"empty"`; safety block ⇒ `"refused"`; for each, `!err.message.includes(KEY) && !err.thai.includes(KEY)`
  - `test/data.test.mjs`: `saveKey then readConfig` round-trips in a temp `KIDFACTORY_DATA`; `hasKey()` false on empty dir
- [ ] **Step 2: Run** `npm test` → FAIL (modules missing)
- [ ] **Step 3: Implement** `src/data.mjs`, `src/gemini.mjs`. Retry 429/5xx up to 4 times with 5 s × 2^n backoff; timeout 300 s via `AbortSignal.timeout`. Thai messages: key → "คีย์ Gemini ไม่ถูกต้อง ลองวางใหม่", credit → "เครดิต Gemini หมด เติมเงินที่ Google AI Studio", busy → "Gemini ไม่ว่าง ลองใหม่อีกครั้ง", refused → "Gemini ไม่ยอมสร้างหน้านี้ ลองแก้คำเล่าแล้วกด ↻", network → "ต่ออินเทอร์เน็ตไม่ได้", empty → "Gemini ไม่ส่งผลลัพธ์กลับมา ลองใหม่".
- [ ] **Step 4: Run** `npm test` → PASS
- [ ] **Step 5: Commit** `feat: scaffold, data folder and Gemini client`

### Task 2: Main character sheets and style guide (owner-gated)

**Files:**
- Create: `assets/style.md`, `assets/characters/{pinto,friend,cat}.png`, `assets/characters/characters.md`

**Interfaces:**
- Produces: `assets/style.md` — one paragraph of style traits (Global Constraints) + "no text, letters or numbers in the image"; `characters.md` — for each of `pinto`, `friend`, `cat`: Thai name, one-line look, fixed outfit colors as words. Later tasks read these files verbatim.

- [ ] **Step 1:** Draft `characters.md` (Claude's design, in the spec's style): Pinto — Thai girl ~6, short black bob, fixed outfit; friend — boy ~6, fixed outfit, never named; cat — a species-appropriate cat whose colors/markings/outfit differ clearly from a yellow striped cat and a grey-and-white cat (e.g. a cream-orange calico with a scarf — final call by owner).
- [ ] **Step 2:** Generate each sheet with **Codex image generation** (owner's decision; Codex CLI from the ChatGPT app): white background, front / side / back full body + 4 expressions (happy, surprised, sad, laughing), 16:9, using `style.md` + the character's lines. Save PNGs (≤ 2 MB each) to `assets/characters/`.
- [ ] **Step 3:** Check each PNG has no text, the cat is unlike the reference cats, and none resemble the reference book's characters.
- [ ] **Step 4: Owner gate** — show the 3 sheets; regenerate until the owner approves. Do not continue without approval.
- [ ] **Step 5: Commit** `feat: main character sheets and style guide`

### Task 3: Real-API spike — consistency, voice, music (owner-gated)

**Files:**
- Create: `scripts/spike.mjs`

**Interfaces:**
- Consumes: `createGemini`, `MODELS`, `readConfig` (Task 1); `assets/*` (Task 2)
- Produces: decisions written into `assets/characters/characters.md` (`voice:` line, `voice_style:` line) and into the plan's notes below: whether images need the extra "style anchor" reference.

- [ ] **Step 1:** `node scripts/spike.mjs images` → 6 page images (hand-written scenes about brushing teeth, mixing 1–3 main characters and one side character "แม่") into `<dataDir>/spike/`. Check: characters recognisable, style flat/outlined, no text.
- [ ] **Step 2:** If consistency is weak, retry adding the best approved page as a 4th "style anchor" reference; keep the better approach. Owner decided: small differences are accepted; no second provider.
- [ ] **Step 3:** `node scripts/spike.mjs voices` → the same Thai paragraph in 4 female prebuilt voices with a warm storyteller style → `<dataDir>/spike/voices/`. **Owner picks one** by listening; record it in `characters.md`.
- [ ] **Step 4:** `node scripts/spike.mjs music` → 3 instrumental tracks (bright / calm / playful, ~2 min, no vocals) → owner listens. If acceptable, Lyria is the music source; otherwise Task 7 seeds from YouTube Audio Library / CC0 (spec).
- [ ] **Step 5:** Note measured cost per image / per minute of speech / per track in `characters.md` (from `usage` in responses) for the cost display.
- [ ] **Step 6: Commit** `chore: spike script and recorded voice/music decisions`

### Task 4: Story engine and prompts

**Files:**
- Create: `src/prompts.mjs`, `src/story.mjs`
- Test: `test/story.test.mjs`

**Interfaces:**
- Consumes: `createGemini().json`, `MODELS.ideas`, `MODELS.story`; `assets/characters/characters.md`
- Produces:
  - `Idea = {title: string, pitch: string}`
  - `Page = {narration: string, scene: string, cast: string[]}` — `cast` uses `"pinto"|"friend"|"cat"` or a side-character id
  - `Story = {title, mood: "bright"|"calm"|"playful", sideCharacters: {id, look}[], pages: Page[]}`
  - `ideas(gemini, topic: string): Promise<Idea[]>` (exactly 3)
  - `writeStory(gemini, idea: Idea, {minutes = 5}): Promise<Story>`
  - `validateStory(s): string[]` — list of problems, empty = ok
  - `pageBudget(minutes): {min, max}` → `pageBudget(5)` = `{min: 12, max: 20}`; `max = round(minutes*4)`, `min = round(max*0.6)`
  - `estimateSeconds(pages): number` — `Σ narration chars / 14 + pages × 1.0 + (pages−1) × 1.5` (Thai ~14 chars/s; replaced by real durations after voice)
  - `imagePrompt(page, story, style): string`

- [ ] **Step 1: Write failing tests** (fake gemini):
  - `ideas returns 3` and rejects/retries when the model returns 2
  - `validateStory` flags: 21 pages; 11 pages; empty narration; a page `cast` id not in main characters or `sideCharacters`; narration > 400 chars
  - `writeStory retries once on invalid story then succeeds`; throws `GeminiError` code `"empty"` with Thai "เขียนเรื่องไม่สำเร็จ ลองใหม่" after a second invalid result
  - `imagePrompt` contains style text, every cast member's look, and the phrase forbidding text in images; never mentions any word from a small `FORBIDDEN` list (test lists the reference characters' descriptions: "green cap panda", "pink rabbit", "penguin", "kappa")
  - `estimateSeconds` of 18 pages × 210 chars = 313.5 s (±0.5)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement.** The prompts are the product's heart (spec "Storytelling must be fun"): the story prompt sets a warm Thai storyteller voice for ages 4–10; the lesson is carried by a small adventure with a problem, a funny moment, a surprise and a happy ending; short spoken sentences, playful sounds and repetition; Pinto leads, the boy is only ever "เพื่อน"/"เพื่อนของปิ่นโต"; each page is one picturable moment; page count inside `pageBudget`; unsafe or odd topics are steered to a gentle kid-safe version. Ideas prompt: 3 clearly different angles, Thai title + one-line pitch.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Prompt quality pass (real API):** run `writeStory` for 4 topics (ล้างมือ, แปรงฟัน, เก็บของเล่น, กินผัก). Read every story as a parent reading aloud; tune prompts until each is fun, varied and within budget. Save one sample story to show the owner in Task 11.
- [ ] **Step 6: Commit** `feat: story engine and prompts`

### Task 5: Episode and saved-ideas store

**Files:**
- Create: `src/episodes.mjs`
- Test: `test/episodes.test.mjs`

**Interfaces:**
- Consumes: `dataDir()`; `Idea`, `Story`
- Produces:
  - `EpisodePage = Page & {image: Status, voice: Status & {seconds?: number, forText?: string}}`, `Status = {state: "todo"|"working"|"done"|"error", file?: string, error?: string}`
  - `Episode = {id, createdAt, idea: Idea, story: Story & {pages: EpisodePage[]}, musicId?: string, output?: string}`
  - `createEpisode(idea, story): Episode` (id `ep-YYYYMMDD-HHMMSS`)
  - `loadEpisode(id): Episode`; `saveEpisode(ep): void` (atomic write via temp file + rename); `listEpisodes(): {id, title, createdAt}[]`
  - `editNarration(ep, n, text): Episode`
  - `saveIdeas(ideas: Idea[]): void`; `listSavedIdeas(): Idea[]`; `removeSavedIdea(title): void`

- [ ] **Step 1: Write failing tests:** `create → load round-trips`; `loading resets working pages to todo` (image and voice); `saveIdeas appends and listSavedIdeas returns them`; `removeSavedIdea`; `files are named by id, not title` (title "ปิ่นโต ล้างมือ" ⇒ folder `ep-…`)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: episode store`

### Task 6: Page images and voice

**Files:**
- Create: `src/pages.mjs`, `src/audio.mjs`
- Test: `test/pages.test.mjs`, `test/audio.test.mjs`

**Interfaces:**
- Consumes: Tasks 1, 4, 5; voice + style from `characters.md`
- Produces:
  - `makeImages(ep, gemini, {pages?: number[], concurrency = 3, onChange}): Promise<Episode>`
  - `makeVoices(ep, gemini, {pages?: number[], concurrency = 3, onChange}): Promise<Episode>`
  - `staleVoices(ep): number[]` — 1-based page numbers whose `voice.forText !== narration` or not done
  - `readWav(buf): {rate, channels, samples: Int16Array}`; `writeWav({rate, channels, samples}): Buffer`; `wavSeconds(buf): number`
  - `narrationTrack(parts: {wav: Buffer, at: number}[], totalSeconds: number, rate = 24000): Buffer` — mono WAV with each part placed at `at` seconds, silence elsewhere

- [ ] **Step 1: Write failing tests:**
  - `one failed page does not stop the others` — fake gemini throws `GeminiError("refused")` on page 2 ⇒ page 2 `state "error"` with Thai text, pages 1 and 3 `done`, files exist
  - `editing narration marks voice stale` — after `makeVoices`, `editNarration(ep, 1, "...")` ⇒ `staleVoices(ep)` = `[1]`
  - `image refs are the 3 main sheets` — captured refs length 3 (+1 if style anchor was kept in Task 3)
  - `wav round-trip` and `wavSeconds` of 24000 samples @24 kHz = 1.0
  - `narrationTrack places parts` — two 0.5 s tones at 0 and 2 ⇒ 3.0 s total, silence at 1.0 s, signal at 2.1 s
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement.** Images saved `img/pNN.png`, voices `voice/pNN.wav`; `onChange` after each page so the UI can poll; `saveEpisode` after each page.
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: page images and voice`

### Task 7: Music library

**Files:**
- Create: `src/music.mjs`
- Test: `test/music.test.mjs`

**Interfaces:**
- Consumes: `createGemini().music`, `dataDir()`
- Produces:
  - `Track = {id, mood: "bright"|"calm"|"playful", title, source: "lyria"|"youtube-audio-library"|"cc0", licence: string, addedAt}`; stored `music/<id>.mp3` + `music/<id>.json`
  - `listTracks(): Track[]`; `pickTrack(mood, {exclude = []}): Track | null` — least-recently-used track of that mood (tracks record `lastUsedAt`)
  - `ensureTrack(mood, gemini): Promise<Track>` — pick, else generate with Lyria (instrumental, gentle, kids' picture-book, ~3 min, no vocals) and add
  - `markUsed(id): void`

- [ ] **Step 1: Write failing tests:** `pickTrack prefers least recently used`; `ensureTrack generates only when the mood is missing` (fake gemini call count 0 then 1); `every track has source and licence` (adding without them throws)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: reusable music library`

### Task 8: Paper and book frame renderer

**Files:**
- Create: `src/render/paper.mjs`, `src/render/book.mjs`
- Test: `test/book.test.mjs`

**Interfaces:**
- Produces:
  - `paperTexture(w, h, seed = 1): Canvas` — procedural (noise + soft fibres), light warm grey like the approved prototype; deterministic for a seed
  - `createBook({width = 1920, height = 1080}): Book` with
    - `Book.frame(ctx, {page: Image, zoom: number})` — hold frame
    - `Book.turn(ctx, {from: Image, fromZoom, to: Image, progress: 0..1})` — page-turn frame
  - Look (copy from `page-flip-reference.html`): dark wooden desk; book inset 4% sides / 6% top-bottom; page-stack edges right and bottom; picture with paper texture multiplied at 0.55 and left spine shade; turn = vertical fold line travelling right→left with ease-in-out, lifted flap shows paper back with curl lighting, shadow cast on the new page, flap shadow peaks mid-turn.
  - Zoom applies to the picture only (inside the page), from 1.00 to 1.06.

- [ ] **Step 1: Write failing tests:** `paperTexture is deterministic` (same seed ⇒ same pixel sample); `frame fills 1920×1080`; `turn at 0 equals hold of from`, `turn at 1 equals hold of to` (pixel samples at 5 points within tolerance); `mid-turn shows paper at the flap` (pixel at fold−40 px is paper-grey, not the picture colour, using solid red/blue test pages)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** with `@napi-rs/canvas`
- [ ] **Step 4: Run** → PASS; also write `turn` frames at progress 0/0.25/0.5/0.75 to PNG and look at them against the prototype
- [ ] **Step 5: Commit** `feat: book and page-turn renderer`

### Task 9: Timeline, audio mix, video export

**Files:**
- Create: `src/timeline.mjs`, `src/render/video.mjs`, `scripts/make-placeholder-clips.mjs`, `assets/clips/intro.mp4`, `assets/clips/outro.mp4`
- Test: `test/timeline.test.mjs`, `test/video.test.mjs`

**Interfaces:**
- Consumes: Tasks 5–8
- Produces:
  - `TIMING = {lead: 0.4, tail: 1.0, turn: 1.5, fps: 30, zoomEnd: 1.06, introOutro: 5}`
  - `buildTimeline(voiceSeconds: number[]): Segment[]` where `Segment = {kind: "hold", page, start, end, voiceAt} | {kind: "turn", from, to, start, end}`; hold length = `lead + voice + tail`
  - `renderEpisode(ep, {onProgress}): Promise<string>` — returns the exported MP4 path `out/<Thai title>.mp4`; throws Thai `"เสียงหน้า N ยังไม่อัปเดต"` if `staleVoices(ep)` is non-empty, `"ภาพหน้า N ยังไม่เสร็จ"` if an image is not done
  - Steps inside: frames (raw RGBA to `ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i -`) → `main.mp4`; `narrationTrack` at each hold's `voiceAt`; music looped under narration at −20 dB relative, 2 s fade-in, 3 s fade-out; `loudnorm I=-14`; concat `intro.mp4` + main + `outro.mp4` (scale/pad to 1920×1080, 30 fps, 48 kHz stereo); `markUsed(musicId)`
  - Placeholder clips: 5 s each, the book on the desk with a closed cover and a soft chime-free silence (no text), generated by `make-placeholder-clips.mjs` with the Task 8 renderer. Owner's real clips replace these files later, same names; any length is trimmed/padded to exactly 5 s.

- [ ] **Step 1: Write failing tests:**
  - `buildTimeline` for voices `[3, 4]` ⇒ hold 0–4.4, turn 4.4–5.9, hold 5.9–11.3; `voiceAt` 0.4 and 6.3
  - `render refuses stale voice` ⇒ Thai error naming the page
  - `renders a tiny episode` — 2 solid-colour pages, 1 s tones, a 4 s silent music file, render at 320×180 (test option `{width, height}`) ⇒ `ffprobe` duration ≈ 5 + (0.4+1+1) + 1.5 + (0.4+1+1) + 5 = 16.3 s (±0.2), has video and audio streams
  - `renders when paths contain spaces and Thai` — same as above with `KIDFACTORY_DATA` = temp dir `"คลัง วิดีโอ"` and title `"ปิ่นโต ล้างมือ"`
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement.** Spawn ffmpeg with argument arrays (never a shell string). ffmpeg path: `KIDFACTORY_FFMPEG` env or `ffmpeg` on PATH (v2 bundles it).
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat: timeline and video export`

### Task 10: Server API and the four screens

**Files:**
- Create: `src/server.mjs`, `public/index.html`, `public/app.js`, `public/style.css`
- Test: `test/server.test.mjs`

**Interfaces:**
- Consumes: everything above
- Produces routes (JSON; errors `{error: thai}` with status 400/500):
  - `GET /api/state` → `{hasKey, savedIdeas, episodes}` (never the key)
  - `POST /api/key {key}`
  - `POST /api/ideas {topic}` → `{ideas}`
  - `POST /api/episodes {idea, keep: Idea[]}` → writes story, saves kept ideas → `{id}`
  - `GET /api/episodes/:id` → episode + `estimateSeconds` / real length + `staleVoices`
  - `PATCH /api/episodes/:id/pages/:n {narration}`
  - `POST /api/episodes/:id/images {pages?}`, `POST /api/episodes/:id/voices {pages?}`, `POST /api/episodes/:id/render {musicId?}` — start a background job, return at once; one job per kind per episode (409 Thai "กำลังทำอยู่" if running)
  - `GET /api/episodes/:id/job` → `{images?, voices?, render?: {progress: 0..1, error?}}`
  - `GET /api/music` → tracks; `GET /media/:id/<file>` → episode media (only inside that episode's folder)
  - `POST /api/episodes/:id/open-folder` → reveals `out/` in Finder/Explorer
- Screens (copy in Thai, as the approved mockup): first-run key; topic → "คิดเรื่องให้หน่อย" → 3 idea cards → "เก็บอีก 2 เรื่องไว้ทำทีหลังไหม?" เก็บ / ไม่เก็บ, plus a "เรื่องที่เก็บไว้" list and recent episodes on the start screen; workroom (page list, picture, editable narration, "เจนภาพทั้งหมด", "เจนเสียงทั้งหมด", per-page ↻ ภาพใหม่ / ▶ ฟังเสียง / ↻ เสียงใหม่, page count + length); assemble (music picker with auto-pick by `story.mood`, "ประกอบวิดีโอ", progress bar, ▶ ดูวิดีโอ, เปิดโฟลเดอร์). UI polls `/job` every second while a job runs. The workroom also shows "ค่าใช้จ่ายประมาณ … บาท" for the episode, from the per-item costs measured in Task 3 (constants in `src/pages.mjs`). Compact, warm paper-like look matching the mockup.

- [ ] **Step 1: Write failing tests** (server on a random port, fake gemini injected): `state never contains the key`; `media route blocks ../ traversal` (404); `second images job returns 409`; `ideas error returns Thai message`
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** server, then UI
- [ ] **Step 4: Run** → PASS; drive the UI once in a browser against a fake gemini (`KIDFACTORY_FAKE=1` uses bundled sample images/voices) to check every button
- [ ] **Step 5: Commit** `feat: server and screens`

### Task 11: Mac launcher and first real episode (owner-gated)

**Files:**
- Create: `start.command`, `README.md` (short, owner-facing, English)

**Interfaces:**
- Produces: double-click `start.command` → installs deps if `node_modules` missing → starts server on port 4848 (next free if busy) → opens a chromeless window (`open -na "Google Chrome" --args --app=<url>`, else default browser); closing the terminal stops it.

- [ ] **Step 1:** Write `start.command`; `chmod +x`; double-click test by Claude via `open start.command`; `curl /api/state` answers
- [ ] **Step 2:** Owner puts the friend's key in through the first-run screen
- [ ] **Step 3: Owner gate** — owner makes 1 full episode (topic of their choice) and watches the MP4. Give the owner a short checklist: story fun? characters consistent enough? page turn feels right? voice/music levels? total length ≈ 5 min?
- [ ] **Step 4:** Fix what the owner reports; record v1 status in `docs/superpowers/HANDOFF.md`
- [ ] **Step 5: Commit** `feat: mac launcher; v1 done`
