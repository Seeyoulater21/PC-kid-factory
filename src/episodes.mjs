import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./data.mjs";

const episodesDir = () => path.join(dataDir(), "episodes");
const ID_RE = /^ep-\d{8}-\d{6}(-\d+)?$/;
const epDir = (id) => {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Bad episode id");
  return path.join(episodesDir(), id);
};
const ideasPath = () => path.join(dataDir(), "saved-ideas.json");

let tmpCounter = 0;
// Atomic write: temp file in the same folder, then rename over the target.
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function loadAll() {
  let names;
  try {
    names = fs.readdirSync(episodesDir());
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    try {
      out.push(loadEpisode(id));
    } catch {
      // not an episode folder; skip
    }
  }
  return out;
}

const numberOf = (ep) => (Number.isInteger(ep.number) && ep.number > 0 ? ep.number : null);

// Highest number among existing episodes + 1 (episodes from before numbering count as 0).
function nextNumber() {
  return loadAll().reduce((m, ep) => Math.max(m, numberOf(ep) ?? 0), 0) + 1;
}

export function createEpisode(idea, story) {
  const now = new Date();
  const base = `ep-${stamp(now)}`;
  let id = base;
  for (let n = 2; fs.existsSync(epDir(id)); n++) id = `${base}-${n}`;
  for (const sub of ["img", "voice", "out"]) fs.mkdirSync(path.join(epDir(id), sub), { recursive: true });
  const ep = {
    id,
    number: nextNumber(),
    createdAt: now.toISOString(),
    idea: structuredClone(idea),
    story: {
      ...structuredClone(story),
      pages: story.pages.map((p) => ({ ...structuredClone(p), image: { state: "todo" }, voice: { state: "todo" } })),
    },
  };
  saveEpisode(ep);
  return ep;
}

export function loadEpisode(id) {
  const ep = JSON.parse(fs.readFileSync(path.join(epDir(id), "episode.json"), "utf8"));
  // A "working" state means the app died mid-job; start over for that item.
  for (const p of ep.story.pages) {
    for (const k of ["image", "voice"]) if (p[k]?.state === "working") p[k] = { state: "todo" };
  }
  return ep;
}

export function saveEpisode(ep) {
  writeJson(path.join(epDir(ep.id), "episode.json"), ep);
}

export function listEpisodes() {
  return loadAll()
    .map((ep) => ({ id: ep.id, number: numberOf(ep), title: ep.story.title, createdAt: ep.createdAt, status: episodeStatus(ep) }))
    .sort((a, b) =>
      (b.number ?? 0) - (a.number ?? 0) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id, "en", { numeric: true }));
}

const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

// The rendered video: ep.video if its file still exists, else the newest .mp4 in out/.
function outputTime(ep) {
  const dir = epDir(ep.id);
  if (ep.video?.file) {
    const t = mtime(path.join(dir, ep.video.file));
    if (t !== null) return t;
  }
  let best = null;
  try {
    for (const f of fs.readdirSync(path.join(dir, "out"))) {
      if (!f.toLowerCase().endsWith(".mp4")) continue;
      const t = mtime(path.join(dir, "out", f));
      if (t !== null && (best === null || t > best)) best = t;
    }
  } catch {}
  return best;
}

/** Library status in Thai, computed from page states and file times (never stored). */
export function episodeStatus(ep) {
  const pages = ep.story?.pages ?? [];
  const m = pages.length;
  const images = pages.filter((p) => p.image?.state === "done").length;
  const voices = pages.filter((p) => p.voice?.state === "done" && p.voice.forText === p.narration).length;
  if (!images && !voices) return "เขียนเรื่องแล้ว";
  if (images < m || voices < m) return `ภาพ ${images}/${m} · เสียง ${voices}/${m}`;
  const out = outputTime(ep);
  if (out === null) return "พร้อมประกอบ";
  const dir = epDir(ep.id);
  const changed = pages
    .flatMap((p) => [p.image?.file, p.voice?.file])
    .filter(Boolean)
    .reduce((t, f) => Math.max(t, mtime(path.join(dir, f)) ?? 0), 0);
  return out >= changed ? "วิดีโอเสร็จ" : "ต้องประกอบใหม่";
}

/** Removes the episode folder for good. */
export function deleteEpisode(id) {
  fs.rmSync(epDir(id), { recursive: true, force: true });
}

// n is the 1-based page number (1 = first page). Returns an updated copy; the caller saves it.
export function editNarration(ep, n, text) {
  if (!Number.isInteger(n) || n < 1 || n > ep.story.pages.length) throw new Error(`No page ${n}`);
  const next = structuredClone(ep);
  const page = next.story.pages[n - 1];
  page.narration = text;
  page.voice = { state: "todo" }; // old audio no longer matches the text
  return next;
}

export function listSavedIdeas() {
  try {
    const a = JSON.parse(fs.readFileSync(ideasPath(), "utf8"));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export function saveIdeas(ideas) {
  const all = listSavedIdeas();
  for (const i of ideas) {
    if (!all.some((x) => x.title === i.title)) all.push({ title: i.title, pitch: i.pitch });
  }
  writeJson(ideasPath(), all);
}

export function removeSavedIdea(title) {
  writeJson(ideasPath(), listSavedIdeas().filter((i) => i.title !== title));
}
