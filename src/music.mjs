import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./data.mjs";

const MOODS = ["bright", "calm", "playful"];
const SOURCES = ["lyria", "youtube-audio-library", "cc0"];
const MOOD_WORDS = {
  bright: "sunny, ukulele, glockenspiel, light bouncy rhythm",
  calm: "cozy, soft piano and music box, slow",
  playful: "curious, pizzicato strings, marimba, light flute, bouncy",
};
const LYRIA_LICENCE =
  "Generated with Google Lyria 3.5 (lyria-3.5) for this project; contains SynthID watermark";
const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "music");

const musicDir = () => path.join(dataDir(), "music");
const jsonPath = (id) => path.join(musicDir(), `${id}.json`);
const mp3Path = (id) => path.join(musicDir(), `${id}.mp3`);

// Copy the bundled seed tracks into the library once (a marker keeps deleted seeds deleted).
export function seedLibrary() {
  const dir = musicDir();
  const marker = path.join(dir, ".seeded");
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(SEED_DIR)) {
    for (const f of fs.readdirSync(SEED_DIR)) {
      if (!f.startsWith("seed-") || !/\.(mp3|json)$/.test(f)) continue;
      const to = path.join(dir, f);
      if (!fs.existsSync(to)) fs.copyFileSync(path.join(SEED_DIR, f), to);
    }
  }
  fs.writeFileSync(marker, "");
}

export function listTracks() {
  seedLibrary();
  const out = [];
  for (const f of fs.readdirSync(musicDir())) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(musicDir(), f), "utf8"));
      if (t && t.id && fs.existsSync(mp3Path(t.id))) out.push(t);
    } catch {}
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function addTrack(track, mp3) {
  if (!track || !MOODS.includes(track.mood)) throw new Error("track needs a valid mood");
  if (!track.id || !/^[A-Za-z0-9_-]+$/.test(track.id)) throw new Error("track needs a safe id");
  if (!SOURCES.includes(track.source)) throw new Error("track needs a valid source");
  if (!track.licence || typeof track.licence !== "string") throw new Error("track needs a licence");
  seedLibrary();
  fs.writeFileSync(mp3Path(track.id), mp3);
  fs.writeFileSync(jsonPath(track.id), JSON.stringify(track, null, 2));
  return track;
}

// Least recently used track of the mood; never-used tracks come first.
export function pickTrack(mood, { exclude = [] } = {}) {
  const c = listTracks().filter((t) => t.mood === mood && !exclude.includes(t.id));
  c.sort((a, b) => (a.lastUsedAt || "").localeCompare(b.lastUsedAt || ""));
  return c[0] || null;
}

export function markUsed(id) {
  const all = listTracks();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error(`unknown track: ${id}`);
  const latest = all.reduce((m, x) => ((x.lastUsedAt || "") > m ? x.lastUsedAt : m), "");
  let ms = Date.now();
  if (latest && ms <= Date.parse(latest)) ms = Date.parse(latest) + 1; // keep order strict
  t.lastUsedAt = new Date(ms).toISOString();
  fs.writeFileSync(jsonPath(id), JSON.stringify(t, null, 2));
}

export async function ensureTrack(mood, gemini) {
  const have = pickTrack(mood);
  if (have) return have;
  if (!MOODS.includes(mood)) throw new Error(`unknown mood: ${mood}`);
  const prompt = `Instrumental background music for a picture book for young kids, ${MOOD_WORDS[mood]}, gentle, about 2 minutes, no vocals.`;
  const mp3 = await gemini.music(prompt);
  const n = listTracks().filter((t) => t.mood === mood).length + 1;
  return addTrack(
    { id: `${mood}-${Date.now()}`, mood, title: `${mood} ${n}`, source: "lyria", licence: LYRIA_LICENCE, addedAt: new Date().toISOString().slice(0, 10) },
    mp3,
  );
}
