// Story engine: topic -> 3 ideas -> a validated picture-book story.
import { GeminiError, MODELS } from "./gemini.mjs";
import {
  ideasPrompt, storyPrompt, retryNote, IDEAS_SCHEMA, STORY_SCHEMA, FORBIDDEN_LOOKS, SHOTS,
} from "./prompts.mjs";
import { TAG_RE, KINDS } from "./sheets.mjs";

export { imagePrompt } from "./prompts.mjs";

const MOODS = ["bright", "calm", "playful"];
const MAX_NARRATION = 400;
const THAI_IDEAS_FAILED = "คิดเรื่องไม่สำเร็จ ลองใหม่";
const THAI_STORY_FAILED = "เขียนเรื่องไม่สำเร็จ ลองใหม่";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const chars = (s) => [...String(s ?? "")].length;

/** About 4 pages per minute; never fewer than 60% of the max. */
export function pageBudget(minutes) {
  const max = Math.round(minutes * 4);
  return { min: Math.round(max * 0.6), max };
}

/** Rough video length (s) before real voice durations exist: Thai TTS ~11 chars/s, 1 s hold, 1.5 s turns. */
export function estimateSeconds(pages) {
  const n = pages.length;
  if (!n) return 0;
  const text = pages.reduce((sum, p) => sum + chars(p?.narration), 0);
  return text / 11 + n * 1.0 + (n - 1) * 1.5;
}

export async function ideas(gemini, topic) {
  let got = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await gemini.json(MODELS.ideas, ideasPrompt(topic), IDEAS_SCHEMA);
    got = (Array.isArray(r?.ideas) ? r.ideas : [])
      .map((i) => ({ title: str(i?.title), pitch: str(i?.pitch) }))
      .filter((i) => i.title && i.pitch);
    if (got.length >= 3) return got.slice(0, 3);
  }
  throw new GeminiError("empty", `ideas: model returned ${got.length} usable ideas`, THAI_IDEAS_FAILED);
}

const forbiddenIn = (text) => {
  const low = String(text ?? "").toLowerCase();
  return FORBIDDEN_LOOKS.filter((w) => new RegExp(`\\b${w}s?\\b`).test(low));
};

/**
 * Problems with a story, in English (fed back to the model on retry). Empty = ok.
 * library: the sheet list; page cast and location tags must be in it or in the story's newSheets.
 */
export function validateStory(s, { minutes = 5, library = [] } = {}) {
  if (!s || typeof s !== "object") return ["story is not an object"];
  const problems = [];

  if (!str(s.title)) problems.push("title is missing");
  if (!MOODS.includes(s.mood)) problems.push(`mood must be one of ${MOODS.join(", ")}`);
  if (!str(s.timeOfDay)) problems.push("timeOfDay is missing");

  const tags = { character: new Set(), place: new Set() };
  for (const x of library) tags[x.kind]?.add(x.tag);
  const fresh = Array.isArray(s.newSheets) ? s.newSheets : [];
  if (!Array.isArray(s.newSheets)) problems.push("newSheets must be a list");
  for (const n of fresh) {
    const tag = str(n?.tag);
    if (!TAG_RE.test(tag)) { problems.push(`new sheet tag "${tag}" must be a short lowercase English word with dashes`); continue; }
    if (!KINDS.includes(n.kind)) problems.push(`new sheet "${tag}" kind must be character or place`);
    if (!str(n.name) || !str(n.description)) problems.push(`new sheet "${tag}" needs a name and a description`);
    if (tags.character.has(tag) || tags.place.has(tag)) problems.push(`new sheet tag "${tag}" is used twice`);
    for (const w of forbiddenIn(n.description)) problems.push(`new sheet "${tag}" must not be a ${w}`);
    if (n.kind === "character" && /\b(cats?|kittens?|kitty|tabby)\b/i.test(n.description)) problems.push(`new sheet "${tag}" must not be a cat; the only cat is Pinto's black cat`);
    tags[n.kind]?.add(tag);
  }
  const propIds = new Set();
  for (const p of Array.isArray(s.props) ? s.props : []) {
    if (!str(p?.id) || !str(p?.look)) problems.push("every prop needs an id and a look");
    else propIds.add(p.id);
  }

  const pages = Array.isArray(s.pages) ? s.pages : [];
  const { min, max } = pageBudget(minutes);
  if (pages.length < min || pages.length > max) {
    problems.push(`story has ${pages.length} pages; it must have between ${min} and ${max} pages`);
  }

  let pintoSeen = false;
  pages.forEach((p, i) => {
    const at = `page ${i + 1}`;
    if (!p || typeof p !== "object") { problems.push(`${at} is not an object`); return; }
    const n = str(p.narration);
    if (!n) problems.push(`${at}: narration is empty`);
    else if (chars(n) > MAX_NARRATION) problems.push(`${at}: narration is ${chars(n)} characters; keep it under ${MAX_NARRATION}`);
    const foreign = [...new Set(n.match(/[^\P{L}฀-๿]/gu) ?? [])];
    if (foreign.length) problems.push(`${at}: narration has non-Thai letters (${foreign.join("")}); write Thai only`);
    if (!str(p.scene)) problems.push(`${at}: scene is empty`);
    for (const w of forbiddenIn(p.scene)) problems.push(`${at}: scene must not show a ${w}`);
    const cast = Array.isArray(p.cast) ? p.cast : [];
    if (!cast.length) problems.push(`${at}: cast is empty`);
    for (const id of cast) {
      if (!tags.character.has(id)) problems.push(`${at}: cast tag "${id}" is not a library character or a newSheets character`);
    }
    if (!Object.hasOwn(SHOTS, p.shot ?? "")) problems.push(`${at}: shot "${p.shot}" is not one of ${Object.keys(SHOTS).join(", ")}`);
    if (p.location && !tags.place.has(p.location)) problems.push(`${at}: location "${p.location}" is not a library place or a newSheets place`);
    for (const id of p.props ?? []) if (!propIds.has(id)) problems.push(`${at}: prop "${id}" is not in props`);
    if (cast.includes("pinto")) pintoSeen = true;
  });
  if (pages.length && !pintoSeen) problems.push("pinto must appear in the story");
  return problems;
}

/** Narration is read aloud by TTS: drop markdown emphasis markers (*, **, _) and keep the words. */
export const stripEmphasis = (s) =>
  s.replace(/(\*\*|\*|_)(?=\S)(.*?\S)\1/g, "$2").replace(/[*_]/g, "");

const tag = (v) => str(v).toLowerCase().replace(/[\s_]+/g, "-");
const list = (v, f) => (Array.isArray(v) ? v.map(f) : v);

// Trims and lowercases what the model wrote; a new sheet whose tag the library already has is dropped (that sheet is reused).
function normalize(raw, library) {
  if (!raw || typeof raw !== "object") return raw;
  const known = new Set(library.map((x) => x.tag));
  return {
    title: str(raw.title),
    mood: str(raw.mood),
    timeOfDay: str(raw.timeOfDay),
    props: list(raw.props, (p) => ({ id: tag(p?.id), look: str(p?.look) })),
    newSheets: Array.isArray(raw.newSheets)
      ? raw.newSheets.map((n) => ({ tag: tag(n?.tag), kind: str(n?.kind), name: str(n?.name), description: str(n?.description) }))
          .filter((n) => !known.has(n.tag))
      : raw.newSheets,
    pages: list(raw.pages, (p) =>
      p && typeof p === "object"
        ? {
            narration: stripEmphasis(str(p.narration)),
            scene: str(p.scene),
            cast: Array.isArray(p.cast) ? p.cast.map(tag).filter(Boolean) : [],
            location: tag(p.location),
            props: Array.isArray(p.props) ? p.props.map(tag).filter(Boolean) : [],
            shot: tag(p.shot),
          }
        : p),
  };
}

export async function writeStory(gemini, idea, { minutes = 5, library = [] } = {}) {
  const base = storyPrompt(idea, pageBudget(minutes), library, minutes);
  let prompt = base;
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const story = normalize(await gemini.json(MODELS.story, prompt, STORY_SCHEMA), library);
    problems = validateStory(story, { minutes, library });
    if (!problems.length) return story;
    prompt = base + retryNote(problems);
  }
  throw new GeminiError("empty", `story invalid: ${problems.slice(0, 5).join("; ")}`, THAI_STORY_FAILED);
}
