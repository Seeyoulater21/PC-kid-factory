import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { paperTexture } from "../src/render/paper.mjs";
import { createBook } from "../src/render/book.mjs";

const W = 1920, H = 1080;

const solid = (color, w = 2752, h = 1536) => {
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
};
// four vertical stripes red | green | blue | yellow: lets us see zoom and cover-fit
const stripes = (w = 2752, h = 1536) => {
  const c = createCanvas(w, h);
  const x = c.getContext("2d");
  ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].forEach((col, i) => { x.fillStyle = col; x.fillRect((i * w) / 4, 0, w / 4, h); });
  return c;
};
const RED = solid("#ff0000"), BLUE = solid("#0000ff");

const px = (ctx, x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
const near = (a, b, tol, msg) =>
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), `${msg}: ${a} vs ${b}`);
const fresh = (w = W, h = H) => createCanvas(w, h).getContext("2d");

// points well inside the page, away from the spine shade and edges
const insidePoints = (w = W, h = H) => [
  [w * 0.3, h * 0.3], [w * 0.7, h * 0.3], [w * 0.5, h * 0.5], [w * 0.3, h * 0.75], [w * 0.85, h * 0.7],
];

test("paperTexture is deterministic", () => {
  const a = paperTexture(200, 120, 7).getContext("2d").getImageData(0, 0, 200, 120).data;
  const b = paperTexture(200, 120, 7).getContext("2d").getImageData(0, 0, 200, 120).data;
  const c = paperTexture(200, 120, 8).getContext("2d").getImageData(0, 0, 200, 120).data;
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  assert.notDeepEqual(Buffer.from(a), Buffer.from(c));
  // light warm grey on average, with visible grain
  let r = 0, g = 0, bl = 0, min = 255, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    r += a[i]; g += a[i + 1]; bl += a[i + 2];
    min = Math.min(min, a[i + 1]); max = Math.max(max, a[i + 1]);
    assert.equal(a[i + 3], 255);
  }
  const n = a.length / 4;
  r /= n; g /= n; bl /= n;
  assert.ok(g > 195 && g < 240, `mean green ${g}`);
  assert.ok(r >= g && g >= bl, `warm: ${r} ${g} ${bl}`);
  assert.ok(max - min > 12, `grain range ${max - min}`);
});

test("frame fills 1920×1080", () => {
  const book = createBook({ width: W, height: H });
  const ctx = fresh();
  book.frame(ctx, { page: RED, zoom: 1 });
  const d = ctx.getImageData(0, 0, W, H).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) assert.fail(`transparent pixel at ${(i - 3) / 4}`);
  // desk corners are dark brown, page centre is the (paper-tinted) picture
  const corner = px(ctx, 5, 5);
  assert.ok(corner[0] < 90 && corner[0] > corner[2], `desk ${corner}`);
  const mid = px(ctx, W / 2, H / 2);
  assert.ok(mid[0] > 180 && mid[1] < 40 && mid[2] < 40, `picture ${mid}`);
  // spine shade darkens the far-left of the page
  const spine = px(ctx, W * 0.04 + 4, H / 2), inner = px(ctx, W * 0.25, H / 2);
  assert.ok(spine[0] < inner[0] - 20, `spine ${spine} vs ${inner}`);
});

test("zoom scales the picture inside the page only", () => {
  const book = createBook({ width: W, height: H });
  const img = stripes();
  const a = fresh(), b = fresh();
  book.frame(a, { page: img, zoom: 1 });
  book.frame(b, { page: img, zoom: 1.06 });
  // outside the page (desk, stack edges) nothing changes
  for (const [x, y] of [[10, 10], [W - 20, H / 2], [W / 2, H - 15], [W / 2, 20]]) near(px(a, x, y), px(b, x, y), 0, `outside ${x},${y}`);
  // zoom is centred: the green/blue boundary stays at the middle
  near(px(a, W / 2 + 30, H / 2), px(b, W / 2 + 30, H / 2), 2, "centre stays put");
  // cover-fit: the picture spans the page width, so the blue/yellow boundary sits at centre + page.w / 4;
  // zooming 1.06 pushes it outward, so a point just right of it turns from yellow to blue
  const edge = W / 2 + book.page.w / 4, x = edge + (book.page.w / 4) * 0.03;
  const ya = px(a, x, H / 2), bb = px(b, x, H / 2);
  assert.ok(ya[0] > 180 && ya[1] > 180 && ya[2] < 60, `yellow at zoom 1: ${ya}`);
  assert.ok(bb[2] > 180 && bb[0] < 60, `blue at zoom 1.06: ${bb}`);
});

test("turn at 0 equals hold of from", () => {
  const book = createBook({ width: W, height: H });
  const hold = fresh(), turn = fresh();
  book.frame(hold, { page: RED, zoom: 1.04 });
  book.turn(turn, { from: RED, fromZoom: 1.04, to: BLUE, progress: 0 });
  for (const [x, y] of insidePoints()) near(px(turn, x, y), px(hold, x, y), 3, `p0 at ${x},${y}`);
});

test("turn at 1 equals hold of to", () => {
  const book = createBook({ width: W, height: H });
  const hold = fresh(), turn = fresh();
  book.frame(hold, { page: BLUE, zoom: 1 });
  book.turn(turn, { from: RED, fromZoom: 1.06, to: BLUE, progress: 1 });
  for (const [x, y] of insidePoints()) near(px(turn, x, y), px(hold, x, y), 3, `p1 at ${x},${y}`);
});

test("mid-turn shows paper at the flap", () => {
  const book = createBook({ width: W, height: H });
  const ctx = fresh();
  book.turn(ctx, { from: RED, fromZoom: 1.06, to: BLUE, progress: 0.5 });
  const fold = book.page.x + book.page.w / 2; // ease(0.5) = 0.5
  const p = px(ctx, fold - 40, H / 2);
  const spread = Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
  assert.ok(spread < 30 && p[1] > 120, `paper-grey at flap: ${p}`);
  // right of the fold is the new (blue) page, darkened by the cast shadow near the fold
  const right = px(ctx, fold + 200, H / 2);
  assert.ok(right[2] > 150 && right[0] < 40, `new page ${right}`);
  const shaded = px(ctx, fold + 3, H / 2);
  assert.ok(shaded[2] < right[2] - 30, `cast shadow ${shaded} vs ${right}`);
});

test("works at small sizes", () => {
  const book = createBook({ width: 320, height: 180 });
  const ctx = fresh(320, 180);
  book.frame(ctx, { page: RED, zoom: 1.03 });
  assert.ok(px(ctx, 160, 90)[0] > 180);
  for (const k of [0, 0.1, 0.5, 0.9, 1]) book.turn(ctx, { from: RED, fromZoom: 1.06, to: BLUE, progress: k });
  assert.ok(px(ctx, 160, 90)[2] > 150);
});

test("zoom outside 1–1.06 is clamped", () => {
  const book = createBook({ width: W, height: H });
  const img = stripes();
  const a = fresh(), b = fresh(), c = fresh(), d = fresh();
  book.frame(a, { page: img, zoom: 1.06 });
  book.frame(b, { page: img, zoom: 3 });
  book.frame(c, { page: img, zoom: 1 });
  book.frame(d, { page: img, zoom: 0.5 });
  for (const [x, y] of insidePoints()) {
    near(px(a, x, y), px(b, x, y), 0, `max ${x},${y}`);
    near(px(c, x, y), px(d, x, y), 0, `min ${x},${y}`);
  }
});

test("full-screen look: the picture reaches every edge, no desk or book", () => {
  const book = createBook({ width: W, height: H, look: "full" });
  assert.deepEqual(book.page, { x: 0, y: 0, w: W, h: H });
  const ctx = fresh();
  book.frame(ctx, { page: RED, zoom: 1 });
  for (const [x, y] of [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2], [W / 2, 2]]) {
    const [r, g, b] = px(ctx, x, y);
    assert.ok(r > 150 && g < 60 && b < 60, `edge ${x},${y}: ${r},${g},${b}`);
  }
  // no spine shade: the left edge is as bright as the middle
  assert.ok(Math.abs(px(ctx, 2, H / 2)[0] - px(ctx, W / 2, H / 2)[0]) < 25);
  // the turn still shows the light paper flap mid-way, now across the whole frame
  book.turn(ctx, { from: RED, to: BLUE, progress: 0.5 });
  const [r, g, b] = px(ctx, W * 0.25, H / 2);
  assert.ok(r > 150 && g > 150 && b > 140, `flap ${r},${g},${b}`);
});

test("colour looks: the desk around the book takes the chosen pastel colour", () => {
  const corner = (look) => {
    const ctx = fresh();
    createBook({ width: W, height: H, look }).frame(ctx, { page: RED });
    return px(ctx, 10, H / 2);
  };
  const wood = corner("wood");
  assert.ok(wood[0] < 110, `wood is dark: ${wood}`);
  const pink = corner("pink"), blue = corner("blue"), cream = corner("cream"), mint = corner("mint");
  for (const c of [pink, blue, cream, mint]) assert.ok(c[0] + c[1] + c[2] > 450, `light: ${c}`);
  assert.ok(pink[0] > pink[1] && pink[0] > pink[2], `pink ${pink}`);
  assert.ok(blue[2] > blue[0], `blue ${blue}`);
  assert.ok(mint[1] > mint[0] && mint[1] > mint[2], `mint ${mint}`);
  assert.ok(cream[0] >= cream[1] && cream[1] > cream[2], `cream ${cream}`);
  // an unknown look falls back to today's wood desk
  assert.deepEqual(corner("nope"), wood);
  assert.deepEqual(corner(undefined), wood);
});
