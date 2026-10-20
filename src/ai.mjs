// One client for every AI job. Text and pictures: ChatGPT through Codex (default) or Gemini when the user picks it
// for a job. Voice and music: always Gemini.
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CodexError, resetTime } from "./codex.mjs";
import { GeminiError } from "./gemini.mjs";

export const PROVIDERS = ["chatgpt", "gemini"];
const GENERIC_ERROR = "เกิดข้อผิดพลาด ลองใหม่";
const SOFTEN = "A gentle, wholesome children's picture-book illustration.\n\n";
export const FRAME = { width: 1920, height: 1080 };

/** Thai text for an AI error. */
export function errorText(e) {
  if (e instanceof CodexError) {
    const at = e.code === "limit" ? resetTime(e.retryAt) : null;
    return at ? `ChatGPT ใช้ครบโควตาของช่วงนี้แล้ว ใช้ได้อีกครั้งประมาณ ${at} น. หรือกด ใช้ Gemini แทน` : e.thai;
  }
  if (e instanceof GeminiError) return e.thai || GENERIC_ERROR;
  return GENERIC_ERROR;
}

/** Errors that stop the rest of a job: every next picture would fail the same way. */
export const stopsJob = (e) => e instanceof CodexError && ["limit", "login", "missing"].includes(e.code);

/** Any picture → a 16:9 JPEG of FRAME size (centre crop), what the book renderer and the library expect. */
export async function toFrame(bytes, { width = FRAME.width, height = FRAME.height } = {}) {
  const img = await loadImage(bytes);
  const c = createCanvas(width, height);
  const x = c.getContext("2d");
  const s = Math.max(width / img.width, height / img.height);
  const w = img.width * s, h = img.height * s;
  x.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return c.toBuffer("image/jpeg", 92);
}

async function geminiImage(g, { prompt, refs = [], editTarget = null, feedback = null }) {
  const all = [...refs, ...(editTarget ? [{ path: editTarget, label: feedback ? "the picture to change" : "the picture to edit" }] : [])];
  const asked = feedback
    ? `${prompt}\n\nThe user asked for this change to the LAST attached picture (Thai): "${feedback}". Change only that and keep everything else. Read every negation (ไม่, ห้าม, อย่า) literally.`
    : prompt;
  const text = all.length ? `Attachments in order:\n${all.map((r, i) => `${i + 1}. ${r.label}`).join("\n")}\n\n${asked}` : asked;
  const files = all.map((r) => ({ data: fs.readFileSync(r.path), mime: "image/jpeg" }));
  let bytes;
  try {
    bytes = await g.image(text, files);
  } catch (e) {
    // a picture Gemini refuses is retried once with a softening line
    if (!(e instanceof GeminiError) || e.code !== "refused") throw e;
    bytes = await g.image(SOFTEN + text, files);
  }
  return { bytes, prompt: feedback ? `${prompt}\n\nChange made at the user's request (Thai): ${feedback}` : prompt };
}

/**
 * provider: "chatgpt" | "gemini"; codex: a CodexBridge (or () => bridge); gemini: () => Gemini client (throws without a key).
 * image(req) resolves { bytes: 16:9 JPEG, prompt: the prompt that was drawn }.
 */
export function createAi({ provider = "chatgpt", codex, gemini }) {
  const chat = provider === "chatgpt";
  const bridge = () => (typeof codex === "function" ? codex() : codex);
  return {
    provider,
    json: (model, prompt, schema) => (chat ? bridge().json(prompt, schema) : gemini().json(model, prompt, schema)),
    async image(req) {
      const r = chat ? await bridge().image(req) : await geminiImage(gemini(), req);
      const raw = r.bytes ?? fs.readFileSync(r.file);
      return { bytes: await toFrame(raw), prompt: r.prompt };
    },
    speech: (text, opts) => gemini().speech(text, opts),
    music: (prompt) => gemini().music(prompt),
  };
}
