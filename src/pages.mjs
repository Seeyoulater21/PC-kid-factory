// Page images and voices: one Gemini call per page, a few at a time, saved after every page.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./data.mjs";
import { saveEpisode } from "./episodes.mjs";
import { GeminiError } from "./gemini.mjs";
import { loadCast, imagePrompt } from "./prompts.mjs";
import { wavSeconds } from "./audio.mjs";

const GENERIC_ERROR = "เกิดข้อผิดพลาด ลองใหม่";
const repoFile = (rel) => new URL(`../${rel}`, import.meta.url);
const epFile = (ep, rel) => path.join(dataDir(), "episodes", ep.id, rel);
const pad = (n) => String(n).padStart(2, "0");
const IMAGE_REFUSED = "Gemini ไม่ยอมวาดหน้านี้ ลองกด ↻ ภาพใหม่ อีกครั้ง";
const SOFTEN = "A gentle, wholesome children's picture-book illustration.\n\n";
const errText = (e, key) => {
  if (!(e instanceof GeminiError)) return GENERIC_ERROR;
  if (key === "image" && e.code === "refused") return IMAGE_REFUSED;
  if (key === "voice" && e.code === "refused") return "Gemini ไม่ยอมอ่านหน้านี้ ลองแก้คำเล่าแล้วกด ↻";
  if (key === "voice" && e.code === "empty") return "Gemini ไม่ส่งเสียงหน้านี้กลับมา ลองกด ↻ อีกครั้ง";
  return e.thai || GENERIC_ERROR;
};

// An image Gemini refuses is retried once with a softening line before the page is marked as an error.
async function imageWithRetry(gemini, prompt, refs) {
  try {
    return await gemini.image(prompt, refs);
  } catch (e) {
    if (!(e instanceof GeminiError) || e.code !== "refused") throw e;
    return gemini.image(SOFTEN + prompt, refs);
  }
}

/** 1-based numbers of pages whose voice is missing or no longer matches the narration. */
export function staleVoices(ep) {
  const out = [];
  ep.story.pages.forEach((p, i) => {
    if (p.voice?.state !== "done" || p.voice.forText !== p.narration) out.push(i + 1);
  });
  return out;
}

async function runPages(ep, nums, concurrency, work) {
  const queue = [...nums];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
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

async function step(ep, n, key, onChange, call, onDone) {
  const page = ep.story.pages[n - 1];
  page[key] = { state: "working" };
  persist(ep, onChange);
  try {
    page[key] = { state: "done", ...(await onDone(await call(page))) };
  } catch (e) {
    page[key] = { state: "error", error: errText(e, key) };
  } finally {
    if (page[key].state === "working") page[key] = { state: "error", error: GENERIC_ERROR };
    persist(ep, onChange);
  }
}

export async function makeImages(ep, gemini, { pages, concurrency = 3, onChange } = {}) {
  const cast = loadCast();
  const refs = cast.characters.map((c) => ({ data: fs.readFileSync(repoFile(c.sheet)), mime: "image/jpeg" }));
  const nums = pick(ep, pages, (n) => ep.story.pages[n - 1].image?.state !== "done");
  return runPages(ep, nums, concurrency, (n) =>
    step(
      ep, n, "image", onChange,
      (page) => imageWithRetry(gemini, imagePrompt(page, ep.story, undefined, cast), refs),
      (bytes) => {
        const file = `img/p${pad(n)}.jpg`;
        fs.mkdirSync(path.dirname(epFile(ep, file)), { recursive: true });
        fs.writeFileSync(epFile(ep, file), bytes);
        return { file };
      },
    ));
}

export async function makeVoices(ep, gemini, { pages, concurrency = 3, onChange } = {}) {
  const cast = loadCast();
  const stale = new Set(staleVoices(ep));
  const nums = pick(ep, pages, (n) => stale.has(n));
  return runPages(ep, nums, concurrency, (n) =>
    step(
      ep, n, "voice", onChange,
      (page) => {
        // the text being spoken, captured now: the narration may be edited while this call runs
        const text = page.narration;
        return gemini.speech(text, { voice: cast.voice, style: cast.voiceStyle }).then((wav) => ({ wav, text }));
      },
      ({ wav, text }) => {
        const file = `voice/p${pad(n)}.wav`;
        fs.mkdirSync(path.dirname(epFile(ep, file)), { recursive: true });
        fs.writeFileSync(epFile(ep, file), wav);
        return { file, seconds: wavSeconds(wav), forText: text };
      },
    ));
}

/**
 * Rough per-item prices in USD (Gemini price list, checked 2026-10-18; shown to the user as "ประมาณ").
 * story: ideas + story calls together; ttsPer10s: per 10 s of narration audio; musicTrack: one new Lyria track.
 */
export const COSTS = { image: 0.0504, story: 0.012, ttsPer10s: 0.00225, musicTrack: 0.08, thbPerUsd: 33 };
const THAI_CHARS_PER_SECOND = 11; // same rate as story.estimateSeconds

/** One full pass for the episode: every page image + every page voice + the story. newTracks = new Lyria tracks. */
export function estimateCost(ep, { newTracks = 0 } = {}) {
  const pages = ep.story.pages;
  const voiceSeconds = pages.reduce((sum, p) => {
    if (p.voice?.state === "done" && Number.isFinite(p.voice.seconds)) return sum + p.voice.seconds;
    return sum + [...String(p.narration ?? "")].length / THAI_CHARS_PER_SECOND;
  }, 0);
  const usd = pages.length * COSTS.image + COSTS.story + (voiceSeconds / 10) * COSTS.ttsPer10s + newTracks * COSTS.musicTrack;
  return { usd, thb: usd * COSTS.thbPerUsd };
}
