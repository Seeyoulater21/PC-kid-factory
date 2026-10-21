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
const FONT = "Mali"; // rounded hand-lettered Thai (OFL)
// from bytes: a path with Thai letters (a Thai Windows user name) cannot break it
GlobalFonts.register(fs.readFileSync(fileURLToPath(new URL("../assets/fonts/Mali-Bold.ttf", import.meta.url))), FONT);

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

// ---- title lettering (#19): chunky rounded letters, one bright colour each, dark outline, cream border,
// small 3D side, drop shadow, gloss and paper grain; drawn per grapheme so Thai marks never clip ----
const RAINBOW = ["#F25C54", "#FFB627", "#3FB2B8", "#7DBE5A", "#EF7FB0", "#9B7FE0", "#FF8A3D"];
const INK = "#4A2F3A";
const CREAM = "#FFF6E0";
const graphemes = (t) => [...new Intl.Segmenter("th", { granularity: "grapheme" }).segment(t)].map((g) => g.segment);
const mix = (hex, to, k) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (to - v) * k));
  return `rgb(${c.join(",")})`;
};
const hash = (i) => { const v = Math.sin(i * 12.9898) * 43758.5453; return v - Math.floor(v); };
const track = (size) => size * 0.04;

/** Width of a title line as drawn by letterLine. */
export function lineWidth(ctx, text, size) {
  ctx.font = `bold ${size}px ${FONT}`;
  const gs = graphemes(text);
  return gs.reduce((w, g) => w + (g === " " ? size * 0.35 : ctx.measureText(g).width), 0) + track(size) * Math.max(0, gs.length - 1);
}

/** Thai title → lines that fit maxWidth, broken between words (Thai has no spaces between words). */
export function wrapTitle(ctx, text, maxWidth, size) {
  const words = [...new Intl.Segmenter("th", { granularity: "word" }).segment(text)].map((s) => s.segment);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line + w;
    if (line && lineWidth(ctx, next.trim(), size) > maxWidth) {
      lines.push(line.trim());
      line = w.trimStart();
    } else line = next;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

let grain = null;
function paperGrain() {
  if (grain) return grain;
  grain = createCanvas(256, 256);
  const g = grain.getContext("2d");
  const id = g.createImageData(256, 256);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 255 - hash(i + 1) * hash(i + 7) * 30;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return grain;
}

// one grapheme centred at (0, 0)
function glyph(x, ch, size, col) {
  const font = `bold ${size}px ${FONT}`;
  x.save();
  x.font = font;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.lineJoin = "round";
  x.lineCap = "round";
  const dx = size * 0.035, dy = size * 0.07, steps = 6;
  // outline of the whole extruded block, with the drop shadow under it
  for (let k = steps; k >= 0; k--) {
    if (k === steps) Object.assign(x, { shadowColor: "rgba(70,40,30,.38)", shadowBlur: size * 0.14, shadowOffsetX: size * 0.03, shadowOffsetY: size * 0.07 });
    x.strokeStyle = INK;
    x.lineWidth = size * 0.22;
    x.strokeText(ch, (dx * k) / steps, (dy * k) / steps);
    x.shadowColor = "transparent";
  }
  // coloured 3D side
  x.fillStyle = x.strokeStyle = mix(col, 0, 0.28);
  x.lineWidth = size * 0.12;
  for (let k = steps; k >= 1; k--) {
    x.strokeText(ch, (dx * k) / steps, (dy * k) / steps);
    x.fillText(ch, (dx * k) / steps, (dy * k) / steps);
  }
  // cream border on the face
  x.strokeStyle = CREAM;
  x.strokeText(ch, 0, 0);
  x.restore();
  // face: gradient + gloss + paper grain, built off-screen so the gloss stays inside the letter
  const probe = createCanvas(1, 1).getContext("2d");
  probe.font = font;
  probe.textAlign = "center";
  probe.textBaseline = "middle";
  const m = probe.measureText(ch), pad = Math.ceil(size * 0.08);
  const ox = Math.ceil(m.actualBoundingBoxLeft) + pad, oy = Math.ceil(m.actualBoundingBoxAscent) + pad;
  const bw = Math.max(1, ox + Math.ceil(m.actualBoundingBoxRight) + pad), bh = Math.max(1, oy + Math.ceil(m.actualBoundingBoxDescent) + pad);
  const face = createCanvas(bw, bh);
  const f = face.getContext("2d");
  f.font = font;
  f.textAlign = "center";
  f.textBaseline = "middle";
  const g = f.createLinearGradient(0, oy - size * 0.5, 0, oy + size * 0.5);
  g.addColorStop(0, mix(col, 255, 0.14));
  g.addColorStop(0.55, col);
  g.addColorStop(1, mix(col, 0, 0.08));
  f.fillStyle = g;
  f.fillText(ch, ox, oy);
  f.globalCompositeOperation = "source-atop";
  f.fillStyle = "rgba(255,255,255,.3)";
  f.beginPath(); f.ellipse(ox - size * 0.12, oy - size * 0.26, size * 0.34, size * 0.12, -0.35, 0, Math.PI * 2); f.fill();
  f.fillStyle = "rgba(255,255,255,.7)";
  f.beginPath(); f.ellipse(ox - size * 0.24, oy - size * 0.3, size * 0.07, size * 0.04, -0.35, 0, Math.PI * 2); f.fill();
  f.globalCompositeOperation = "multiply";
  f.fillStyle = f.createPattern(paperGrain(), "repeat");
  f.fillRect(0, 0, bw, bh);
  f.globalCompositeOperation = "destination-in";
  f.fillStyle = "#000";
  f.fillText(ch, ox, oy);
  x.drawImage(face, -ox, -oy);
}

/** Draws one title line centred at (cx, cy); colours continue from `from` (returns the next index). */
function letterLine(x, text, cx, cy, size, from = 0) {
  const gs = graphemes(text);
  x.font = `bold ${size}px ${FONT}`;
  const ws = gs.map((g) => (g === " " ? size * 0.35 : x.measureText(g).width));
  let pen = cx - lineWidth(x, text, size) / 2;
  let ci = from;
  gs.forEach((ch, i) => {
    const gx = pen + ws[i] / 2;
    pen += ws[i] + track(size);
    if (ch === " ") return;
    x.save();
    x.translate(gx, cy);
    x.rotate((hash(ci + 3) - 0.5) * 0.12);
    glyph(x, ch, size, RAINBOW[ci % RAINBOW.length]);
    x.restore();
    ci++;
  });
  return ci;
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

  // title in the calm top-left area (the picture keeps it plain for this)
  // letters the bundled font has (Thai, Latin, digits, simple punctuation): emoji would differ per computer
  const title = graphemes(pkg.title || ep.story.title).filter((g) => /^[\u0E00-\u0E7FA-Za-z0-9 !?.,:'"()&+-]+$/u.test(g)).join("").replace(/\s+/g, " ").trim();
  const box = { x: W * 0.04, y: H * 0.05, w: W * 0.5, h: H * 0.46 };
  let size = 132, lines;
  for (;; size -= 4) {
    lines = wrapTitle(x, title, box.w, size);
    const fits = lines.length <= 3 && lines.every((l) => lineWidth(x, l, size) <= box.w) && lines.length * size * 1.3 <= box.h;
    if (fits || size <= 28) break;
  }
  const lh = size * 1.3; // room for Thai marks above and below
  let y = box.y + size * 0.62;
  let ci = Math.floor(hash(title.length) * RAINBOW.length);
  for (const l of lines) {
    ci = letterLine(x, l, box.x + lineWidth(x, l, size) / 2 + size * 0.12, y, size, ci);
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
