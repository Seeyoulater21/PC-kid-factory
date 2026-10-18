// Procedural paper: light warm grey, fine-grain drawing/watercolour paper with tooth and soft fibres.
// Deterministic for a seed (own PRNG, no Math.random).
import { createCanvas } from "@napi-rs/canvas";

export const PAPER_RGB = [226, 223, 217];

export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// smooth value noise in [-1, 1] with lattice spacing `cell` px
export function valueNoise(w, h, cell, rand) {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rand() * 2 - 1;
  const out = new Float32Array(w * h);
  const ox = rand() * cell, oy = rand() * cell; // decorrelate octaves
  const fx = new Int32Array(w), tx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const p = (x + ox) / cell, i = Math.floor(p), f = p - i;
    fx[x] = i; tx[x] = f * f * (3 - 2 * f);
  }
  for (let y = 0; y < h; y++) {
    const p = (y + oy) / cell, j = Math.floor(p), f = p - j, ty = f * f * (3 - 2 * f);
    const r0 = j * gw, r1 = r0 + gw;
    for (let x = 0; x < w; x++) {
      const i = fx[x], t = tx[x];
      const a = g[r0 + i] + (g[r0 + i + 1] - g[r0 + i]) * t;
      const b = g[r1 + i] + (g[r1 + i + 1] - g[r1 + i]) * t;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

export function paperTexture(w, h, seed = 1) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const rand = rng(seed);
  const k = Math.max(0.5, Math.min(2, Math.min(w, h) / 950)); // physical scale vs a 1080p page
  const cell = (c) => Math.max(1.5, c * k);

  // tooth: a bumpy height field, lit from the top-left (emboss)
  const t1 = valueNoise(w, h, cell(2.2), rand);
  const t2 = valueNoise(w, h, cell(5), rand);
  const t3 = valueNoise(w, h, cell(13), rand);
  const mottle = valueNoise(w, h, cell(140), rand);
  const cloud = valueNoise(w, h, cell(45), rand);
  const ht = new Float32Array(w * h);
  for (let i = 0; i < ht.length; i++) ht[i] = 0.45 * t1[i] + 0.4 * t2[i] + 0.35 * t3[i];

  const img = new Uint8ClampedArray(w * h * 4);
  const [R, G, B] = PAPER_RGB;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const up = ht[(y > 0 ? y - 1 : y) * w + (x > 0 ? x - 1 : x)];
      const shade = (ht[i] - up) * 14;               // light/dark sides of each bump
      const pit = ht[i] < -0.55 ? (ht[i] + 0.55) * 10 : 0; // deeper pores hold shadow
      const v = shade + pit + mottle[i] * 3.5 + cloud[i] * 2 + (rand() - 0.5) * 5;
      const o = i * 4;
      img[o] = R + v; img[o + 1] = G + v; img[o + 2] = B + v * 1.08;
      img[o + 3] = 255;
    }
  }
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(w, h);
  data.data.set(img);
  ctx.putImageData(data, 0, 0);

  // soft fibres: short wandering strands, a little lighter or darker than the sheet
  const n = Math.round((w * h) / 2600);
  ctx.lineCap = "round";
  for (let f = 0; f < n; f++) {
    let x = rand() * w, y = rand() * h, a = rand() * Math.PI * 2;
    const len = (5 + rand() * 22) * k, steps = 4;
    const light = rand() < 0.6;
    ctx.strokeStyle = light ? `rgba(255,253,247,${0.18 + rand() * 0.2})` : `rgba(120,108,92,${0.06 + rand() * 0.09})`;
    ctx.lineWidth = (0.4 + rand() * 0.7) * k;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < steps; s++) {
      a += (rand() - 0.5) * 0.9;
      const cx = x + Math.cos(a) * len / steps, cy = y + Math.sin(a) * len / steps;
      a += (rand() - 0.5) * 0.9;
      x = cx + Math.cos(a) * len / steps; y = cy + Math.sin(a) * len / steps;
      ctx.quadraticCurveTo(cx, cy, x, y);
    }
    ctx.stroke();
  }
  return canvas;
}
