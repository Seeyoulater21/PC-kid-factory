// Page images and voices, saved after every page. Pictures: five at a time with ChatGPT, three with Gemini.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./data.mjs";
import { saveEpisode } from "./episodes.mjs";
import { GeminiError } from "./gemini.mjs";
import { loadCast, imagePrompt } from "./prompts.mjs";
import { errorText, stopsJob } from "./ai.mjs";
import { library, findSheet, sheetFile, makeSheet, markUsed, STYLE_REF } from "./sheets.mjs";
import { wavSeconds } from "./audio.mjs";

const GENERIC_ERROR = "เกิดข้อผิดพลาด ลองใหม่";
const epFile = (ep, rel) => path.join(dataDir(), "episodes", ep.id, rel);
const pad = (n) => String(n).padStart(2, "0");
const IMAGE_REFUSED = "Gemini ไม่ยอมวาดหน้านี้ ลองกด ↻ ภาพใหม่ อีกครั้ง";
const errText = (e, key) => {
  if (!(e instanceof GeminiError)) return errorText(e);
  if (key === "image" && e.code === "refused") return IMAGE_REFUSED;
  if (key === "voice" && e.code === "refused") return "Gemini ไม่ยอมอ่านหน้านี้ ลองแก้คำเล่าแล้วกด ↻";
  if (key === "voice" && e.code === "empty") return "Gemini ไม่ส่งเสียงหน้านี้กลับมา ลองกด ↻ อีกครั้ง";
  return e.thai || GENERIC_ERROR;
};

/** 1-based numbers of pages whose voice is missing or no longer matches the narration. */
export function staleVoices(ep) {
  const out = [];
  ep.story.pages.forEach((p, i) => {
    if (p.voice?.state !== "done" || p.voice.forText !== p.narration) out.push(i + 1);
  });
  return out;
}

async function runPages(ep, nums, concurrency, work, stopped = () => false) {
  const queue = [...nums];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined && !stopped(); n = queue.shift()) {
      try {
        await work(n);
      } catch {
        // step() already records failures per page; never let one page kill the worker
      }
    }
  };
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 3);
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
  return ep;
}

function pick(ep, pages, wanted) {
  const total = ep.story.pages.length;
  const nums = pages ?? Array.from({ length: total }, (_, i) => i + 1).filter(wanted);
  return [...new Set(nums)].filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
}

// Saving and the UI callback must never break a page: failures there are ignored.
function persist(ep, onChange) {
  try { saveEpisode(ep); } catch { /* disk trouble: in-memory state stays correct */ }
  try { onChange?.(ep); } catch { /* UI callback trouble */ }
}

// Take k of page n: p03.jpg is take 1, then p03-2.jpg, p03-3.jpg… An earlier take is never overwritten.
function takeFile(ep, n, dir, ext, page, key) {
  for (let k = (page[`${key}Takes`]?.length ?? 0) + 1; ; k++) {
    const file = `${dir}/p${pad(n)}${k > 1 ? `-${k}` : ""}.${ext}`;
    if (!fs.existsSync(epFile(ep, file))) return file;
  }
}

// Every finished take is kept in page.imageTakes / page.voiceTakes; page.image / page.voice is the one in use.
// An error that stops the whole job (ChatGPT limit, not signed in) puts the page back as it was and is rethrown.
async function step(ep, n, key, onChange, call, onDone) {
  const page = ep.story.pages[n - 1];
  const before = page[key];
  page[key] = { state: "working" };
  persist(ep, onChange);
  try {
    const take = await onDone(await call(page));
    (page[`${key}Takes`] ??= []).push(take);
    page[key] = { state: "done", ...take };
  } catch (e) {
    if (stopsJob(e)) {
      page[key] = before?.state === "done" ? before : { state: "todo" };
      throw e;
    }
    page[key] = { state: "error", error: errText(e, key) };
  } finally {
    if (page[key].state === "working") page[key] = { state: "error", error: GENERIC_ERROR };
    persist(ep, onChange);
  }
}

/** Attachments for one page: the house style, the sheets of its characters, and its place sheet (not for close-ups). */
export function pageRefs(page) {
  const refs = [STYLE_REF];
  for (const tag of page.cast ?? []) {
    const s = findSheet(tag);
    if (s?.kind === "character" && sheetFile(s)) refs.push({ path: sheetFile(s), label: `character sheet of ${s.name} (${tag})` });
  }
  const place = page.location ? findSheet(page.location) : null;
  if (place?.kind === "place" && sheetFile(place)) {
    refs.push({
      path: sheetFile(place),
      label: `place anchor for ${place.name} (${place.tag}): use ONLY for this place's architecture, furniture and materials; never for people; do not copy its framing or camera angle`,
    });
  }
  return refs;
}

/** Library tags (characters and places) that the given pages show. */
export function tagsOf(ep, nums) {
  const tags = new Set();
  for (const n of nums) {
    const p = ep.story.pages[n - 1];
    for (const t of p.cast ?? []) tags.add(t);
    if (p.location) tags.add(p.location);
  }
  return [...tags];
}

/** Draws every library sheet these tags still miss (one at a time), then records the episode as their user. */
export async function ensureSheets(tags, ai, epId, onChange) {
  for (const tag of tags) {
    const s = findSheet(tag);
    if (!s || s.chosen) continue;
    try {
      await makeSheet(tag, ai, { onChange });
    } catch (e) {
      if (stopsJob(e)) throw e;
      // pages drawn without this sheet would not match later pages: stop and say which sheet
      throw new Error(`วาดแผ่น ${s.name} ไม่สำเร็จ: ${errorText(e)}`);
    }
  }
  markUsed(tags.filter((t) => findSheet(t)), epId);
}

/**
 * Page pictures. Missing library sheets are drawn first. feedback (Thai) = change the picture in use as the user says
 * (a fresh picture when the page has none). A ChatGPT limit stops the job: finished pages stay, the rest wait.
 */
export async function makeImages(ep, ai, { pages, feedback = null, concurrency, onChange, onSheets } = {}) {
  library();
  const nums = pick(ep, pages, (n) => ep.story.pages[n - 1].image?.state !== "done");
  await ensureSheets(tagsOf(ep, nums), ai, ep.id, onSheets);
  // the picture in use before this job (step() marks the page "working" before the call)
  const inUse = new Map(nums.map((n) => [n, ep.story.pages[n - 1].image?.state === "done" ? ep.story.pages[n - 1].image.file : null]));
  let stop = null;
  await runPages(ep, nums, concurrency ?? (ai.provider === "chatgpt" ? 5 : 3), (n) =>
    step(
      ep, n, "image", onChange,
      (page) => {
        const last = inUse.get(n) ? page.imageTakes?.find((t) => t.file === inUse.get(n)) : null;
        const edit = feedback && last ? epFile(ep, last.file) : null;
        return ai.image({
          prompt: edit ? (last.prompt ?? imagePrompt(page, ep.story, library())) : imagePrompt(page, ep.story, library()),
          refs: pageRefs(page),
          editTarget: edit,
          feedback: edit ? feedback : null,
          context: `Picture-book page ${n}. Narration: ${page.narration}`,
        }).then((r) => ({ ...r, feedback: edit ? feedback : null }));
      },
      ({ bytes, prompt, feedback: fb }) => {
        const file = takeFile(ep, n, "img", "jpg", ep.story.pages[n - 1], "image");
        fs.mkdirSync(path.dirname(epFile(ep, file)), { recursive: true });
        fs.writeFileSync(epFile(ep, file), bytes);
        return { file, prompt, ...(fb ? { feedback: fb } : {}) };
      },
    ).catch((e) => { stop ??= e; }),
  () => stop !== null);
  if (stop) throw stop;
  return ep;
}

export async function makeVoices(ep, ai, { pages, concurrency = 3, onChange } = {}) {
  const cast = loadCast();
  const stale = new Set(staleVoices(ep));
  const nums = pick(ep, pages, (n) => stale.has(n));
  return runPages(ep, nums, concurrency, (n) =>
    step(
      ep, n, "voice", onChange,
      (page) => {
        // the text being spoken, captured now: the narration may be edited while this call runs
        const text = page.narration;
        return ai.speech(text, { voice: cast.voice, style: cast.voiceStyle }).then((wav) => ({ wav, text }));
      },
      ({ wav, text }) => {
        const file = takeFile(ep, n, "voice", "wav", ep.story.pages[n - 1], "voice");
        fs.mkdirSync(path.dirname(epFile(ep, file)), { recursive: true });
        fs.writeFileSync(epFile(ep, file), wav);
        return { file, seconds: wavSeconds(wav), forText: text };
      },
    ));
}

/** Use take number `take` (1 = first) of page n's image or voice again. Changes ep in place; the caller saves it. */
export function pickTake(ep, n, key, take) {
  const page = ep.story.pages[n - 1];
  const t = key === "image" || key === "voice" ? page?.[`${key}Takes`]?.[take - 1] : undefined;
  if (!t) throw new Error(`No take ${take} for page ${n}`);
  if (page[key]?.state === "done" && page[key].file === t.file) return; // already in use: the video stays valid
  page[key] = { state: "done", ...t, pickedAt: Date.now() };
  // a voice take matches the text it was read from: bring that text back
  if (key === "voice" && typeof t.forText === "string") page.narration = t.forText;
}

/**
 * Rough per-item prices in USD (Gemini price list, checked 2026-10-18; shown to the user as "ประมาณ").
 * story: ideas + story calls together; ttsPer10s: per 10 s of narration audio; musicTrack: one new Lyria track.
 */
export const COSTS = { image: 0.0504, story: 0.012, ttsPer10s: 0.00225, musicTrack: 0.08, thbPerUsd: 33 };
const THAI_CHARS_PER_SECOND = 11; // same rate as story.estimateSeconds

/**
 * One full pass for the episode: every page voice, plus every page image and the story when Gemini draws and writes
 * (with ChatGPT they come with the plan). newTracks = new Lyria tracks.
 */
export function estimateCost(ep, { newTracks = 0, gemini = false } = {}) {
  const pages = ep.story.pages;
  const voiceSeconds = pages.reduce((sum, p) => {
    if (p.voice?.state === "done" && Number.isFinite(p.voice.seconds)) return sum + p.voice.seconds;
    return sum + [...String(p.narration ?? "")].length / THAI_CHARS_PER_SECOND;
  }, 0);
  const drawn = gemini ? pages.length * COSTS.image + COSTS.story : 0;
  const usd = drawn + (voiceSeconds / 10) * COSTS.ttsPer10s + newTracks * COSTS.musicTrack;
  return { usd, thb: usd * COSTS.thbPerUsd };
}
