# Kid Factory — design

Date: 2026-10-18 · Status: approved by owner 2026-10-18

## Intent

A one-click local program that turns a topic ("teach kids to brush their teeth") into a finished
picture-book style video, ready to upload to an existing Thai children's YouTube channel (viewers 4–10).

The person using it is the owner's friend: no technical knowledge at all, works on a Windows PC, uploads
to YouTube by hand. The owner and Claude design, build and maintain it remotely; the friend only types,
clicks, and pays for their own AI usage.

**Why:** the friend wants to produce many short educational stories without learning any tools.
Success = the friend double-clicks an icon, types a topic, clicks through, and gets an MP4 they are happy
to post, without calling the owner.

## Goals

1. Topic → 3 story ideas → pick 1 → (keep the other 2 for later? yes/no) → workroom → images + voice → MP4.
2. Every episode looks like the same picture book: same 3 main characters, same art style.
3. Video looks like a real paper picture book being read: page-turn transitions with visible paper.
4. One AI provider only: **Google Gemini**, one API key, paid by the friend.
5. The owner/Claude can fix and update it without visiting the friend.

## Non-goals

- Uploading to YouTube (friend uploads manually). No upload reminders/checklists either (owner said no).
- Fact research/auditing (simple kids' topics; fact checks are not needed).
- Text on the pages or subtitles. **Picture + narration only.**
- Multiple voices / character dialogue voices.
- A native Windows .exe in v1.

## Anti-goals (would make it a failure even if it "works")

- Characters that copy the style-reference book's characters (see Style). Copyright claims/takedowns on a
  kids' channel are the worst outcome. The channel already had a video blocked by a music claim.
- Music that can get claimed. Only music we generated or that is verifiably royalty-free.
- Anything the friend has to configure beyond pasting one key.
- Owner's keys, names, channel name or home paths in the public repo.

## Constraints

- **Repo `Seeyoulater21/PC-kid-factory` is PUBLIC.** No secrets, no channel name, no reference-book images
  or names, no third-party texture files. Private names are blocked by commit hooks
  (`private/blocked-words.txt` in the workspace).
- Friend's API key lives only on the friend's machine (local config file, git-ignored), never in the repo or logs.
- Owner's Mac: macOS, no Xcode. Friend: Windows 10/11 PC. Code must run on both.
- App UI language: **Thai** (exception to the workspace's English-UI default — the user is Thai and
  non-technical). Code, comments, commits, docs: English.

## Decided by the owner

### Story and characters
- Main character: **น้องปิ่นโต (Pinto)**, a human girl.
- Her friend: a human boy, **never named** — narration calls him "เพื่อน" / "เพื่อนของปิ่นโต".
- An **animal friend: a black cat** with a red scarf (owner, 2026-10-18) — clearly different from the
  reference book's two cats (yellow striped, grey-and-white).
- **Owner picked the look (2026-10-18):** the first Gemini test image (`assets/characters/origin.jpg`) is the
  look for Pinto (short black bob, round face, blush) **and** for the art style of the whole series
  (flat, clean outlines, soft bright palette). The cat in that image becomes black. The boy is designed to match.
- These **3 main characters are locked**: same look in every episode.
- Side characters can appear per episode (mom, teacher, other animals…). They do not need to be locked;
  **matching the art style matters more than matching a fixed design.**
- Topics: simple good-habit lessons (hand washing, brushing teeth…). Story must suit ages 4–10.
- Length: target ~5 minutes; a little over is fine; no hard cap. Pages: about 4 per minute,
  **max 20 pages for a ~5-minute episode**. The page plan must enforce this.

### Storytelling must be fun (owner's top priority)
- The story is the heart of the product: it must be **fun and engaging**, not a lecture. The lesson rides on
  a real little adventure (a problem, a funny moment, a surprise, a happy ending).
- The Gemini prompts are a core deliverable, written and tuned with care (owner asked for this explicitly):
  kid-friendly Thai spoken for reading aloud, short sentences, playful sounds/repetition, a warm narrator,
  each page a clear picturable moment, the habit taught through what Pinto and friends do.
- Prompt quality is checked by reading real outputs (several topics) before v1 is called done.

### Main character art: made by us, built in
- The 3 main character sheets are generated **by the owner + Claude ahead of time** and shipped inside the app as
  reference images. Since the owner chose a Gemini image as the origin, the sheets are made with Gemini using
  `origin.jpg` as the reference (Claude's call; keeps the look identical). The friend never generates or approves main characters.
  (So the earlier "first run: generate characters" screen is dropped; first run = paste the Gemini key only.)
- Per-episode page images are generated by Gemini, using the shipped character sheets as reference images.

### Style
- Taken from a Japanese picture-book series the friend sent (kept privately, not in the repo):
  flat vector look, no 3D shading; thick clean black outlines; bright flat saturated colors (yellow, sky blue,
  pink, green); big round eyes, pink dash blush on cheeks; full-bleed scenes, detailed but uncluttered.
- Use the **style traits only** (as written words in prompts). Never send the book's images to the model as
  references, never reproduce its characters (a panda in a green cap, pink rabbit, two cats, penguin, kappa).

### Voice
- One narrator for the whole story: **Thai, female**, warm storyteller (Gemini TTS).

### Video look
- Pages change **only** by a book page-turn: the page lifts from the right edge and folds over to the left,
  showing the **back of the paper** (plain paper texture with curl lighting), a shadow on the new page,
  and visible page-stack thickness on the right and bottom edges. Pictures carry a light paper texture
  (multiply) and a spine shadow at the left. Book sits on a dark wooden desk background.
- **Page turn = 1.5 seconds.**
- While a page is held, a slow zoom-in keeps it alive.
- Prototype the owner approved (look reference, except speed): `docs/superpowers/specs/page-flip-reference.html`
  in this repo — a 2D fold: fold line travels right→left, the lifted flap shows the paper back.
- Paper texture: **we make our own** (generated/procedural). The texture the owner showed is third-party and
  must not be committed.

### Music
- Soft background music, **reused from a library**: tracks are stored with a mood tag (bright, calm,
  exciting…). A new episode picks from the library first; only when no track fits the mood is a new one made.
- Generate with Gemini's music model if it is good enough; otherwise seed the library with verifiably
  royalty-free tracks. Every track keeps a note of where it came from.

### Channel intro / outro
- Show name: **ปิ่นโตเก่งขึ้นทุกวัน** (owner, 2026-10-18). The owner's finished intro shows it.
- The owner will supply the channel's own intro and outro clips. Each is **locked at 5 seconds**. The app
  adds them automatically at the start and end of every video. The story itself has no cover/title page.
  Owner confirmed; the real clips arrive later. Until then build with a **placeholder 5-second intro and outro**
  (simple generated mockup clips) so the slot works and can be swapped by dropping in the real files.

### Gemini key
- Testing v1 on the owner's Mac uses **the friend's Gemini key**; the owner will put it in the local
  (git-ignored) config. It is never committed, printed or logged.

### Screens (owner approved the mockup)
0. First run only: paste the Gemini key.
1. Type a topic → "คิดเรื่องให้หน่อย" (think of a story).
2. Pick 1 of 3 ideas (title + one line). Then: "keep the other 2 for later?" Keep / Don't keep.
   Kept ideas go to a "saved stories" list the friend can start from later.
3. Workroom: page list on the left; on the right the page's picture and its narration text.
   Friend can edit the narration text. Buttons: generate all images, generate all voice; per page:
   ↻ new image, ▶ play voice, ↻ new voice. Shows page count and estimated length.
4. Assemble: music auto-picked from the library (changeable) → "ประกอบวิดีโอ" with a progress bar →
   ▶ watch / open folder.

### Episode library (owner approved 2026-10-18)
- Start screen shows "คลังตอน": every episode with an automatic number (EP1, EP2, …), title, status
  (story written / images N/M · voices N/M / ready to assemble / video done / needs re-assembly), date, open, delete.
- Delete asks for confirmation first; it cannot be undone.
- Video file names start with the episode number: `EP01 <title>.mp4`.

## Releases (owner decided the order)

1. **v1 — on the owner's Mac:** the whole flow from topic to MP4 works. Owner makes 1 test episode.
2. **v2 — Windows:** installer for the friend's PC + self-update. Owner/Claude install it remotely.
3. **Later:** whatever the friend asks for (goes to GitHub issues first, not into code).

## How it's built (Claude's calls — owner can redirect)

- **Local web app in an app-like window.** A small local server + browser UI, opened as a chromeless
  window (Edge `--app=` on Windows, Chrome/Safari on Mac) from a desktop icon. Chosen because the same code
  runs on Mac and Windows, Claude can build and test it on the Mac, and no Windows build tooling is needed.
- Base it on the owner's existing local "art room" web app (Node, no framework) where it helps — the location
  is in the workspace's private notes, not here. Do not copy anything private from it.
- **Fixed AI prompts inside the app, no agents.** Story ideas → story → page plan → image prompts are fixed
  prompt templates calling Gemini directly. The friend never chats with an AI.
- **Video assembly with ffmpeg**, bundled with the app. The page-turn may be rendered frame-by-frame
  (e.g. drawing frames with a canvas library and piping to ffmpeg) since ffmpeg has no built-in page curl.
- **Remote maintenance (v2):** Tailscale + Windows OpenSSH so Claude can reach the friend's PC; the app
  checks GitHub for a newer version on launch and updates itself (public repo → no token needed).
- **Character sheets are step 1 of the plan** (nothing about images can be tested without them). Each main
  character: front / side / back full body, 4 expressions (happy, surprised, sad, laughing), fixed outfit
  colors written down as text. Owner approves the sheets before page-image work starts.
- **First spike: Gemini character consistency** — generate ~6 pages with the 3 sheets as references and check
  that the characters stay recognisable, before building the workroom.
  **Owner decided:** if Gemini can't keep them identical, accept small differences. No second image provider,
  no sticker-compositing workaround.
- **Music fallback:** if Gemini music is not good enough, seed the library from the YouTube Audio Library
  (free for YouTube videos; the owner/friend downloads in YouTube Studio) or CC0 tracks. Each track stores
  source + licence + download date in a sidecar file. No other sources.
- **Cost visibility:** show an estimated cost per episode after the first real measurement (unknown today).

## Left to the builder

- Exact Gemini models (text, image-with-reference, TTS Thai female voice, music) — check current API docs;
  confirm image generation accepts multiple reference images and keeps characters consistent.
- Page timing (each page lasts as long as its narration + pause), zoom amount, music ducking/levels, loudness target.
- File/folder layout for episodes, saved ideas, music library.
- How story generation keeps stories age-appropriate and within the page budget.
- Error messages in plain Thai for the common failures (bad key, no credit, network down, model refused).
