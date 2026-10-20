// Packaging (after the video): Thai YouTube title, description, hashtags, and a cover picture.
// The cover picture is drawn text-free; the app writes the Thai title on it with the bundled font, so vowels and
// tone marks are always right. Data: ep.package = { title, description, hashtags, coverScene, coverTakes, coverArt, cover }.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { dataDir } from "./data.mjs";
import { MODELS } from "./gemini.mjs";
import { packagePrompt, coverPrompt, PACKAGE_SCHEMA } from "./prompts.mjs";
import { library, findSheet, sheetFile, STYLE_REF } from "./sheets.mjs";
import { outputName } from "./render/video.mjs";

export const PARTS = ["all", "title", "description", "hashtags"];
export const COVER = { width: 1280, height: 720, maxBytes: 2 * 1024 * 1024 };
const FONT = "Kanit";
// from bytes: a path with Thai letters (a Thai Windows user name) cannot break it
GlobalFonts.register(fs.readFileSync(fileURLToPath(new URL("../assets/fonts/Kanit-Bold.ttf", import.meta.url))), FONT);

const epFile = (ep, rel) => path.join(dataDir(), "episodes", ep.id, rel);
const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Hashtags as "#word": one leading #, no spaces, no repeats, at most 10. */
export function cleanHashtags(list) {
  const out = [];
  for (const h of Array.isArray(list) ? list : String(list ?? "").split(/[\s,]+/)) {
    const t = `#${String(h).replace(/^#+/, "").replace(/\s+/g, "")}`;
    if (t.length > 1 && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 10);
}

const blank = () => ({ title: "", description: "", hashtags: [], coverScene: "", coverTakes: [], coverArt: null, cover: null });

/** Writes the title, description and hashtags (part = one of them, or "all"). Changes ep in place; the caller saves it. */
export async function makePackageText(ep, ai, { part = "all" } = {}) {
  const r = await ai.json(MODELS.story, packagePrompt(ep), PACKAGE_SCHEMA);
  const pkg = (ep.package ??= blank());
  const title = Array.from(str(r?.title)).slice(0, 80).join("");
  if ((part === "all" || part === "title") && title) pkg.title = title;
  if ((part === "all" || part === "description") && str(r?.description)) pkg.description = str(r.description);
  if (part === "all" || part === "hashtags") pkg.hashtags = cleanHashtags(r?.hashtags);
  if (part === "all" || !pkg.coverScene) pkg.coverScene = str(r?.coverScene);
  return ep;
}

/** Characters on the cover: the episode's cast that has library sheets. */
export function coverRefs(ep) {
  const tags = [...new Set(ep.story.pages.flatMap((p) => p.cast ?? []))];
  const refs = [STYLE_REF];
  for (const tag of tags) {
    const s = findSheet(tag);
    if (s?.kind === "character" && sheetFile(s)) refs.push({ path: sheetFile(s), label: `character sheet of ${s.name} (${tag})` });
  }
  return refs;
}

/**
 * Draws a new text-free cover picture (feedback: change the one in use as the user says) and writes the cover JPG.
 * Needs the title (makePackageText first).
 */
export async function makeCover(ep, ai, { feedback = null } = {}) {
  const pkg = (ep.package ??= blank());
  if (!pkg.coverScene) await makePackageText(ep, ai, { part: "cover" });
  const last = pkg.coverTakes.find((t) => t.file === pkg.coverArt);
  const edit = feedback && last ? epFile(ep, last.file) : null;
  const r = await ai.image({
    prompt: edit ? last.prompt : coverPrompt(ep, pkg.coverScene, library()),
    refs: coverRefs(ep),
    editTarget: edit,
    feedback: edit ? feedback : null,
    context: `YouTube thumbnail for the episode "${pkg.title || ep.story.title}"; the title is added later, so the picture has no text`,
  });
  let k = pkg.coverTakes.length + 1;
  while (fs.existsSync(epFile(ep, `img/cover-${k}.jpg`))) k++;
  const file = `img/cover-${k}.jpg`;
  fs.mkdirSync(path.dirname(epFile(ep, file)), { recursive: true });
  fs.writeFileSync(epFile(ep, file), r.bytes);
  pkg.coverTakes.push({ file, prompt: r.prompt, ...(edit ? { feedback } : {}), at: new Date().toISOString() });
  pkg.coverArt = file;
  await composeCover(ep);
  return ep;
}

/** Uses cover picture number `take` (1 = first) again and rewrites the cover JPG. */
export async function pickCover(ep, take) {
  const t = ep.package?.coverTakes?.[take - 1];
  if (!t) throw new Error(`No cover take ${take}`);
  ep.package.coverArt = t.file;
  await composeCover(ep);
}

/** Thai title → lines that fit maxWidth, broken between words (Thai has no spaces between words). */
export function wrapTitle(ctx, text, maxWidth) {
  const words = [...new Intl.Segmenter("th", { granularity: "word" }).segment(text)].map((s) => s.segment);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line + w;
    if (line && ctx.measureText(next.trim()).width > maxWidth) {
      lines.push(line.trim());
      line = w.trimStart();
    } else line = next;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

/** Writes "<video name> - cover.jpg" in out/: the chosen picture with the title on its right side, under 2 MB. */
export async function composeCover(ep) {
  const pkg = ep.package;
  if (!pkg?.coverArt) return null;
  const { width: W, height: H } = COVER;
  const c = createCanvas(W, H);
  const x = c.getContext("2d");
  const img = await loadImage(fs.readFileSync(epFile(ep, pkg.coverArt)));
  const s = Math.max(W / img.width, H / img.height);
  x.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);

  const title = pkg.title || ep.story.title;
  const box = { x: W * 0.56, w: W * 0.4 };
  let size = 104, lines;
  for (;; size -= 4) {
    x.font = `${size}px ${FONT}`;
    lines = wrapTitle(x, title, box.w);
    if ((lines.length <= 3 && lines.every((l) => x.measureText(l).width <= box.w)) || size <= 40) break;
  }
  const lh = size * 1.32; // room for Thai marks above and below
  let y = H / 2 - ((lines.length - 1) * lh) / 2;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.lineJoin = "round";
  for (const l of lines) {
    const cx = box.x + box.w / 2;
    x.lineWidth = size * 0.22;
    x.strokeStyle = "#2b1d4a";
    x.strokeText(l, cx, y);
    x.fillStyle = "#fff6c8";
    x.fillText(l, cx, y);
    y += lh;
  }

  let buf;
  for (let q = 92; ; q -= 8) {
    buf = c.toBuffer("image/jpeg", q);
    if (buf.length < COVER.maxBytes || q <= 52) break;
  }
  const rel = `out/${outputName(ep).replace(/\.mp4$/, "")} - cover.jpg`;
  fs.mkdirSync(path.dirname(epFile(ep, rel)), { recursive: true });
  fs.writeFileSync(epFile(ep, rel), buf);
  pkg.cover = rel;
  pkg.coverAt = Date.now();
  return rel;
}
