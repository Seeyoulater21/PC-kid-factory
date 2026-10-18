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

export function createEpisode(idea, story) {
  const now = new Date();
  const base = `ep-${stamp(now)}`;
  let id = base;
  for (let n = 2; fs.existsSync(epDir(id)); n++) id = `${base}-${n}`;
  for (const sub of ["img", "voice", "out"]) fs.mkdirSync(path.join(epDir(id), sub), { recursive: true });
  const ep = {
    id,
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
  let names;
  try {
    names = fs.readdirSync(episodesDir());
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    try {
      const ep = loadEpisode(id);
      out.push({ id: ep.id, title: ep.story.title, createdAt: ep.createdAt });
    } catch {
      // not an episode folder; skip
    }
  }
  return out.sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id, "en", { numeric: true }) : b.createdAt.localeCompare(a.createdAt)));
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
