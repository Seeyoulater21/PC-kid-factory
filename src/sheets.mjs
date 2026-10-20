// The shared sheet library: one picture per character or place, found by tag and reused by every episode.
// Data: <data>/sheets/sheets.json + one JPEG per take (<tag>-1.jpg, <tag>-2.jpg…). Older takes are never deleted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, readJsonFile, renameRetry } from "./data.mjs";
import { sheetPrompt } from "./prompts.mjs";
import { errorText } from "./ai.mjs";

export const TAG_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const KINDS = ["character", "place"];

// fake mode keeps its placeholder sheets apart, so they never become references for real pictures
const sheetsDir = () => path.join(dataDir(), process.env.KIDFACTORY_FAKE === "1" ? "sheets-fake" : "sheets");
const libFile = () => path.join(sheetsDir(), "sheets.json");
const seeds = () => JSON.parse(fs.readFileSync(new URL("../assets/sheets.json", import.meta.url), "utf8"));

/** The house style picture: first attachment of every picture, for drawing technique and colours only. */
export const STYLE_REF = {
  path: fileURLToPath(new URL("../assets/characters/origin.jpg", import.meta.url)),
  label: "house style reference ONLY: copy its drawing technique, black outlines and soft flat colours; do NOT copy its people, faces, eyes, animals (its cat is not our cat), fur colours, room or objects",
};

const blank = ({ tag, kind, name, description }, extra = {}) => ({
  tag, kind, name, description, takes: [], chosen: null, locked: false, usedBy: [], auto: false, state: "todo", ...extra,
});

let cache = null; // { dir, list }: one shared in-memory library per data folder

// The starting sheets ship ready-drawn: assets/sheets/<tag>.jpg
const bundled = (tag) => fileURLToPath(new URL(`../assets/sheets/${tag}.jpg`, import.meta.url));

/** Gives every starting sheet that has no picture yet its ready-drawn one. true when something changed. */
function fillStarting(list) {
  let changed = false;
  for (const seed of seeds()) {
    const s = list.find((x) => x.tag === seed.tag);
    if (!s || s.chosen || s.state === "working" || !fs.existsSync(bundled(seed.tag))) continue;
    let k = s.takes.length + 1;
    while (fs.existsSync(path.join(sheetsDir(), `${s.tag}-${k}.jpg`))) k++;
    const file = `${s.tag}-${k}.jpg`;
    try {
      fs.mkdirSync(sheetsDir(), { recursive: true });
      fs.copyFileSync(bundled(seed.tag), path.join(sheetsDir(), file));
    } catch {
      continue; // disk trouble: this sheet can still be drawn from Settings
    }
    s.takes.push({ file, prompt: sheetPrompt(s), at: new Date().toISOString() });
    s.chosen = file;
    s.state = "done";
    delete s.error;
    changed = true;
  }
  return changed;
}

/** The library (seeded with the ready-drawn starting characters and places on first use). Every caller shares one list. */
export function library() {
  if (cache?.dir === sheetsDir()) return cache.list;
  let list = readJsonFile(libFile(), null);
  const fresh = !Array.isArray(list);
  if (fresh) list = seeds().map((s) => blank(s));
  // "working" means the app stopped mid-picture
  for (const s of list) if (s.state === "working") s.state = s.chosen ? "done" : "todo";
  cache = { dir: sheetsDir(), list };
  if (fillStarting(list) || fresh) saveLibrary();
  return list;
}

let tmp = 0;
export function saveLibrary() {
  const list = library();
  fs.mkdirSync(sheetsDir(), { recursive: true });
  const t = `${libFile()}.${process.pid}.${++tmp}.tmp`;
  fs.writeFileSync(t, JSON.stringify(list, null, 2));
  renameRetry(t, libFile());
}

export const findSheet = (tag) => library().find((s) => s.tag === tag) ?? null;
export const sheetFile = (s) => (s?.chosen ? path.join(sheetsDir(), s.chosen) : null);
export const sheetDir = sheetsDir;

function freeTag(base) {
  let tag = base;
  for (let n = 2; findSheet(tag); n++) tag = `${base}-${n}`;
  return tag;
}

/** A new sheet in the library (not drawn yet). tag is made from the kind when it is missing or not a plain English word. */
export function addSheet({ kind, name, description, tag, auto = false }) {
  if (!KINDS.includes(kind)) throw new Error("bad kind");
  const clean = String(tag ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (clean && TAG_RE.test(clean) && findSheet(clean)) throw new Error(`tag ${clean} exists`);
  const s = blank({
    tag: clean && TAG_RE.test(clean) ? clean : freeTag(kind === "place" ? "place" : "character"),
    kind, name: String(name).trim(), description: String(description).trim(),
  }, { auto });
  library().push(s);
  saveLibrary();
  return s;
}

/** Adds a story's newSheets that the library does not have yet; an existing tag is reused as it is. Returns the added tags. */
export function addNewSheets(newSheets = []) {
  const added = [];
  for (const n of newSheets) {
    if (!TAG_RE.test(n.tag) || findSheet(n.tag)) continue;
    library().push(blank(n, { auto: true }));
    added.push(n.tag);
  }
  if (added.length) saveLibrary();
  return added;
}

/** Use take number `take` (1 = first) of a sheet again. */
export function pickSheetTake(tag, take) {
  const s = findSheet(tag);
  const t = s?.takes[take - 1];
  if (!t) throw new Error(`No take ${take} for ${tag}`);
  if (s.locked) throw new Error("locked");
  s.chosen = t.file;
  saveLibrary();
}

export function lockSheet(tag, locked) {
  const s = findSheet(tag);
  if (!s) throw new Error(`No sheet ${tag}`);
  if (locked && !s.chosen) throw new Error("nothing to lock");
  s.locked = Boolean(locked);
  saveLibrary();
}

/** Remembers that episode epId used these tags. */
export function markUsed(tags, epId) {
  let changed = false;
  for (const tag of tags) {
    const s = findSheet(tag);
    if (s && !s.usedBy.includes(epId)) { s.usedBy.push(epId); changed = true; }
  }
  if (changed) saveLibrary();
}

/** Attachments for drawing a sheet: the house style, and for a new character the main girl's sheet as a drawing example. */
export function sheetRefs(s) {
  const refs = [STYLE_REF];
  const pinto = findSheet("pinto");
  if (s.kind === "character" && s.tag !== "pinto" && sheetFile(pinto)) {
    refs.push({ path: sheetFile(pinto), label: "example of how characters are drawn in this series (dot eyes, proportions, outlines); do NOT copy this girl" });
  }
  return refs;
}

/**
 * Draws one new take of a sheet with ai.image and makes it the one in use.
 * feedback (Thai) = change the take in use as the user says; empty = a fresh take.
 */
export async function makeSheet(tag, ai, { feedback = null, onChange = () => {} } = {}) {
  const s = findSheet(tag);
  if (!s) throw new Error(`No sheet ${tag}`);
  if (s.locked) throw new Error("locked");
  const last = s.takes.find((t) => t.file === s.chosen);
  const edit = feedback && last ? sheetFile(s) : null;
  s.state = "working";
  delete s.error;
  saveLibrary();
  onChange();
  try {
    const r = await ai.image({
      prompt: edit ? (last.prompt ?? sheetPrompt(s)) : sheetPrompt(s),
      refs: sheetRefs(s),
      editTarget: edit,
      feedback: edit ? feedback : null,
      context: `${s.kind === "place" ? "Place" : "Character"} reference sheet: ${s.name}`,
      keepShape: true, // a sheet is never cropped: heads and feet stay on it
    });
    let k = s.takes.length + 1;
    while (fs.existsSync(path.join(sheetsDir(), `${tag}-${k}.jpg`))) k++;
    const file = `${tag}-${k}.jpg`;
    fs.mkdirSync(sheetsDir(), { recursive: true });
    fs.writeFileSync(path.join(sheetsDir(), file), r.bytes);
    s.takes.push({ file, prompt: r.prompt, ...(edit ? { feedback } : {}), at: new Date().toISOString() });
    s.chosen = file;
    s.state = "done";
  } catch (e) {
    s.state = s.chosen ? "done" : "error";
    s.error = errorText(e);
    throw e;
  } finally {
    saveLibrary();
    onChange();
  }
}
