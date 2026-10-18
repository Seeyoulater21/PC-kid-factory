// Story engine: topic -> 3 ideas -> a validated picture-book story.
import { GeminiError, MODELS } from "./gemini.mjs";
import {
  loadCast, ideasPrompt, storyPrompt, retryNote, IDEAS_SCHEMA, STORY_SCHEMA, FORBIDDEN_LOOKS,
} from "./prompts.mjs";

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

/** Problems with a story, in English (fed back to the model on retry). Empty = ok. */
export function validateStory(s, { minutes = 5 } = {}) {
  if (!s || typeof s !== "object") return ["story is not an object"];
  const problems = [];
  const mainIds = loadCast().characters.map((c) => c.id);

  if (!str(s.title)) problems.push("title is missing");
  if (!MOODS.includes(s.mood)) problems.push(`mood must be one of ${MOODS.join(", ")}`);

  const side = Array.isArray(s.sideCharacters) ? s.sideCharacters : [];
  if (!Array.isArray(s.sideCharacters)) problems.push("sideCharacters must be a list");
  const sideIds = [];
  for (const c of side) {
    const id = str(c?.id);
    if (!id || !str(c?.look)) { problems.push("every side character needs an id and a look"); continue; }
    if (mainIds.includes(id)) problems.push(`side character id "${id}" is a main character id; pick another id`);
    if (sideIds.includes(id)) problems.push(`side character id "${id}" is used twice`);
    for (const w of forbiddenIn(c.look)) problems.push(`side character "${id}" must not be a ${w}`);
    if (/\b(cats?|kittens?|kitty|tabby)\b/i.test(c.look)) problems.push(`side character "${id}" must not be a cat; the only cat is Pinto's black cat`);
    sideIds.push(id);
  }

  const pages = Array.isArray(s.pages) ? s.pages : [];
  const { min, max } = pageBudget(minutes);
  if (pages.length < min || pages.length > max) {
    problems.push(`story has ${pages.length} pages; it must have between ${min} and ${max} pages`);
  }

  const known = new Set([...mainIds, ...sideIds]);
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
      if (!known.has(id)) problems.push(`${at}: cast id "${id}" is not a main character or a declared side character`);
    }
    if (cast.includes("pinto")) pintoSeen = true;
  });
  if (pages.length && !pintoSeen) problems.push("pinto must appear in the story");
  return problems;
}

/** Narration is read aloud by TTS: drop markdown emphasis markers (*, **, _) and keep the words. */
export const stripEmphasis = (s) =>
  s.replace(/(\*\*|\*|_)(?=\S)(.*?\S)\1/g, "$2").replace(/[*_]/g, "");

function normalize(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return {
    title: str(raw.title),
    mood: str(raw.mood),
    sideCharacters: Array.isArray(raw.sideCharacters)
      ? raw.sideCharacters.map((c) => ({ id: str(c?.id).toLowerCase(), look: str(c?.look) }))
      : raw.sideCharacters,
    pages: Array.isArray(raw.pages)
      ? raw.pages.map((p) =>
          p && typeof p === "object"
            ? {
                narration: stripEmphasis(str(p.narration)),
                scene: str(p.scene),
                cast: Array.isArray(p.cast) ? p.cast.map((id) => str(id).toLowerCase()).filter(Boolean) : [],
              }
            : p,
        )
      : raw.pages,
  };
}

export async function writeStory(gemini, idea, { minutes = 5 } = {}) {
  const base = storyPrompt(idea, pageBudget(minutes), loadCast(), minutes);
  let prompt = base;
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const story = normalize(await gemini.json(MODELS.story, prompt, STORY_SCHEMA));
    problems = validateStory(story, { minutes });
    if (!problems.length) return story;
    prompt = base + retryNote(problems);
  }
  throw new GeminiError("empty", `story invalid: ${problems.slice(0, 5).join("; ")}`, THAI_STORY_FAILED);
}
