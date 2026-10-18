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
const errText = (e) => (e instanceof GeminiError && e.thai ? e.thai : GENERIC_ERROR);

/** 1-based numbers of pages whose voice is missing or no longer matches the narration. */
export function staleVoices(ep) {
  const out = [];
  ep.story.pages.forEach((p, i) => {
    if (p.voice?.state !== "done" || p.voice.forText !== p.narration) out.push(i + 1);
  });
  return out;
}

async function runPages(ep, nums, concurrency, onChange, work) {
  const queue = [...nums];
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) await work(n);
  };
  const size = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: size }, worker));
  return ep;
}

function pick(ep, pages, wanted) {
  const total = ep.story.pages.length;
  const nums = pages ?? Array.from({ length: total }, (_, i) => i + 1).filter(wanted);
  return [...new Set(nums)].filter((n) => Number.isInteger(n) && n >= 1 && n <= total);
}

async function step(ep, n, key, onChange, call, onDone) {
  const page = ep.story.pages[n - 1];
  page[key] = { state: "working" };
  saveEpisode(ep);
  onChange?.(ep);
  try {
    page[key] = { state: "done", ...(await onDone(await call(page))) };
  } catch (e) {
    page[key] = { state: "error", error: errText(e) };
  }
  saveEpisode(ep);
  onChange?.(ep);
}

export async function makeImages(ep, gemini, { pages, concurrency = 3, onChange } = {}) {
  const cast = loadCast();
  const refs = cast.characters.map((c) => ({ data: fs.readFileSync(repoFile(c.sheet)), mime: "image/jpeg" }));
  const nums = pick(ep, pages, (n) => ep.story.pages[n - 1].image?.state !== "done");
  return runPages(ep, nums, concurrency, onChange, (n) =>
    step(
      ep, n, "image", onChange,
      (page) => gemini.image(imagePrompt(page, ep.story, undefined, cast), refs),
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
  return runPages(ep, nums, concurrency, onChange, (n) =>
    step(
      ep, n, "voice", onChange,
      (page) => gemini.speech(page.narration, { voice: cast.voice, style: cast.voiceStyle }).then((wav) => ({ wav, text: page.narration })),
      ({ wav, text }) => {
        const file = `voice/p${pad(n)}.wav`;
        fs.mkdirSync(path.dirname(epFile(ep, file)), { recursive: true });
        fs.writeFileSync(epFile(ep, file), wav);
        return { file, seconds: wavSeconds(wav), forText: text };
      },
    ));
}
