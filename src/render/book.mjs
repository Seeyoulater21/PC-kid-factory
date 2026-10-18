// Draws one video frame: a picture book lying on a dark wooden desk.
// Hold frame = picture (slow zoom) printed on paper; turn frame = 2D paper page turn (fold travels right→left).
// Geometry and look follow docs/superpowers/specs/page-flip-reference.html (prototype is 960×540; u scales it).
import { createCanvas } from "@napi-rs/canvas";
import { paperTexture, valueNoise, rng, PAPER_RGB } from "./paper.mjs";

export const ZOOM_MAX = 1.06;
const PAPER_OPACITY = 0.55;
const SPINE = { width: 0.06, alpha: 0.28 };

export const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

function drawDesk(ctx, W, H, u) {
  // radial-gradient(ellipse at 50% 40%, #4a3a2c, #241a12), farthest-corner
  ctx.save();
  const cx = W / 2, cy = H * 0.4, rx = Math.SQRT2 * W / 2, ry = Math.SQRT2 * H * 0.6;
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, "#4a3a2c");
  g.addColorStop(1, "#241a12");
  ctx.fillStyle = g;
  ctx.fillRect(-cx, -cy * rx / ry, W, H * rx / ry);
  ctx.restore();

  // subtle wood grain: wavy horizontal streaks, multiplied in
  const rand = rng(91);
  const warp = valueNoise(W, H, Math.max(8, 90 * u), rand);
  const fine = valueNoise(W, H, Math.max(2, 3 * u), rand);
  const band = valueNoise(W, H, Math.max(4, 22 * u), rand);
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
  const f = 0.11 / u;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const ring = Math.sin((y + warp[i] * 40 * u) * f + band[i] * 1.5);
      const m = 1 + 0.11 * ring * (0.6 + 0.4 * band[i]) + 0.04 * fine[i] + 0.05 * band[i];
      const o = i * 4;
      d[o] *= m; d[o + 1] *= m; d[o + 2] *= m;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// striped page-stack edge (many sheets seen from the side)
function drawStack(ctx, x, y, w, h, vertical, u, rand) {
  ctx.save();
  ctx.beginPath();
  const r = 4 * u;
  ctx.roundRect(x, y, w, h, vertical ? [0, r, r, 0] : [0, 0, r, r]);
  ctx.clip();
  ctx.fillStyle = "#b9b4aa";
  ctx.fillRect(x, y, w, h);
  // one light + one dark line per sheet, on whole pixels so the sheets stay crisp
  const len = vertical ? w : h;
  const sheet = Math.max(2, Math.round(u));
  const o0 = Math.round(vertical ? x : y);
  for (let p = 0; p < len; p += sheet) {
    const v = 226 + (rand() - 0.5) * 18;
    ctx.fillStyle = `rgb(${v + 7},${v + 4},${v - 3})`;
    const lw = Math.max(1, sheet - 1);
    if (vertical) ctx.fillRect(o0 + p, y, lw, h);
    else ctx.fillRect(x, o0 + p, w, lw);
  }
  // darker toward the outside and the far end, like light falling off the block
  const g = vertical ? ctx.createLinearGradient(x, 0, x + w, 0) : ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "rgba(0,0,0,0.05)");
  g.addColorStop(1, "rgba(0,0,0,0.32)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const g2 = vertical ? ctx.createLinearGradient(0, y, 0, y + h) : ctx.createLinearGradient(x, 0, x + w, 0);
  g2.addColorStop(0, "rgba(0,0,0,0)");
  g2.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = g2;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

export function createBook({ width = 1920, height = 1080 } = {}) {
  const W = Math.round(width), H = Math.round(height);
  const u = H / 540;
  const page = { x: Math.round(W * 0.04), y: Math.round(H * 0.06) };
  page.w = W - 2 * page.x;
  page.h = H - 2 * page.y;
  const { x: PX, y: PY, w: PW, h: PH } = page;

  // static layer: desk, book shadow, page-stack edges
  const base = createCanvas(W, H);
  {
    const ctx = base.getContext("2d");
    drawDesk(ctx, W, H, u);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 40 * u;
    ctx.shadowOffsetY = 18 * u;
    ctx.fillStyle = "#b9b4aa";
    ctx.beginPath();
    ctx.roundRect(PX, PY, PW + 6 * u, PH + 6 * u, [2 * u, 6 * u, 6 * u, 2 * u]);
    ctx.fill();
    ctx.restore();
    const rand = rng(5);
    drawStack(ctx, PX + PW - 2 * u, PY + 3 * u, 8 * u, PH, true, u, rand);
    drawStack(ctx, PX + 3 * u, PY + PH - 1 * u, PW + 3 * u, 7 * u, false, u, rand);
  }

  // multiply layer over the page: paper texture at 0.55 combined with the spine shade
  const front = paperTexture(PW, PH, 1);
  const back = paperTexture(PW, PH, 2);
  const overlay = createCanvas(PW, PH);
  {
    const src = front.getContext("2d").getImageData(0, 0, PW, PH).data;
    const octx = overlay.getContext("2d");
    const out = octx.createImageData(PW, PH);
    const d = out.data;
    const sw = SPINE.width * PW;
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const o = (y * PW + x) * 4;
        const spine = x < sw ? 1 - SPINE.alpha * (1 - x / sw) : 1;
        for (let c = 0; c < 3; c++) d[o + c] = (1 - PAPER_OPACITY + PAPER_OPACITY * src[o + c] / 255) * spine * 255;
        d[o + 3] = 255;
      }
    }
    octx.putImageData(out, 0, 0);
  }

  // pictures pre-scaled to cover the page at the largest zoom (a few recent ones kept)
  const cache = new Map();
  function scaled(img) {
    let hit = cache.get(img);
    if (hit) return hit;
    const s0 = Math.max(PW / img.width, PH / img.height);
    const cw = Math.max(1, Math.round(img.width * s0 * ZOOM_MAX)), ch = Math.max(1, Math.round(img.height * s0 * ZOOM_MAX));
    const c = createCanvas(cw, ch);
    const cctx = c.getContext("2d");
    cctx.imageSmoothingQuality = "high";
    cctx.drawImage(img, 0, 0, cw, ch);
    hit = { canvas: c, w: img.width * s0, h: img.height * s0 };
    cache.set(img, hit);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return hit;
  }

  // picture (or blank paper) inside the page, visible only in page-x range [x0, x1]
  function drawPicture(ctx, img, zoom, x0, x1) {
    if (x1 - x0 <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(PX + x0, PY, x1 - x0, PH);
    ctx.clip();
    if (!img) {
      ctx.fillStyle = `rgb(${PAPER_RGB})`;
      ctx.fillRect(PX + x0, PY, x1 - x0, PH);
    } else {
      const s = scaled(img), z = zoom > 0 ? zoom : 1;
      const dw = s.w * z, dh = s.h * z;
      ctx.drawImage(s.canvas, PX + (PW - dw) / 2, PY + (PH - dh) / 2, dw, dh);
    }
    ctx.restore();
  }

  function paperOver(ctx) {
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(overlay, PX, PY);
    ctx.globalCompositeOperation = "source-over";
  }

  function frame(ctx, { page: img, zoom = 1 } = {}) {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0);
    drawPicture(ctx, img, zoom, 0, PW);
    paperOver(ctx);
  }

  function turn(ctx, { from, fromZoom = ZOOM_MAX, to, progress = 0 } = {}) {
    const k = clamp01(progress);
    const s = ease(k) * PW;
    const fold = PW - s, edge = PW - 2 * s, left = Math.max(0, edge);
    const lift = Math.sin(Math.PI * k);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0);
    drawPicture(ctx, to, 1, fold, PW);         // new page, right of the fold
    drawPicture(ctx, from, fromZoom, 0, left); // old picture still lying flat
    paperOver(ctx);

    // shadow cast on the new page just right of the fold (fades fully out at both ends)
    const cw = 60 * u * (0.3 + lift);
    const ca = 0.35 * lift + 0.05 * Math.min(1, k * 8, (1 - k) * 8);
    if (ca > 0.001 && fold < PW) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(PX, PY, PW, PH);
      ctx.clip();
      const g = ctx.createLinearGradient(PX + fold, 0, PX + fold + cw, 0);
      g.addColorStop(0, `rgba(0,0,0,${ca})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(PX + fold, PY, cw, PH);
      ctx.restore();
    }

    // the lifted flap: back of the paper, with its own shadow to the left
    const fw = fold - left;
    if (fw > 0.25) {
      const fx = PX + left;
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${0.35 * lift})`;
      ctx.shadowBlur = 24 * u * lift;
      ctx.shadowOffsetX = -14 * u * lift;
      ctx.fillStyle = `rgb(${PAPER_RGB})`;
      ctx.fillRect(fx, PY, fw, PH);
      ctx.restore();
      const sx = Math.max(0, Math.floor(left)), sw = Math.min(PW - sx, Math.ceil(fw) + 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, PY, fw, PH);
      ctx.clip();
      ctx.drawImage(back, sx, 0, sw, PH, PX + sx, PY, sw, PH);
      const g = ctx.createLinearGradient(fx, 0, fx + fw, 0);
      g.addColorStop(0, "rgba(0,0,0,0.18)");
      g.addColorStop(0.55, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(0,0,0,0.22)");
      ctx.fillStyle = g;
      ctx.fillRect(fx, PY, fw, PH);
      if (edge > 0) {
        // the lifted edge of a thick sheet: a lit rim with a thin dark line behind it
        const rim = Math.max(1, 1.2 * u);
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fillRect(fx, PY, rim, PH);
        ctx.fillStyle = "rgba(60,50,40,0.35)";
        ctx.fillRect(fx + rim, PY, Math.max(0.5, 0.5 * u), PH);
      }
      ctx.restore();
    }
  }

  return { width: W, height: H, page: { ...page }, frame, turn };
}
