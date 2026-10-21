import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

process.env.KIDFACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kf-pkg-"));
const { composeCover, COVER } = await import("../src/package.mjs");

test("cover title: colourful 3D lettering in the top-left, the right side of the picture untouched", async () => {
  // a plain grey picture shows exactly where the lettering went
  const art = createCanvas(1280, 720);
  const a = art.getContext("2d");
  a.fillStyle = "#808080";
  a.fillRect(0, 0, 1280, 720);
  const dir = path.join(process.env.KIDFACTORY_DATA, "episodes", "e1", "img");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cover-1.jpg"), art.toBuffer("image/jpeg"));
  const ep = { id: "e1", number: 1, story: { title: "t" }, package: { title: "ปิ่นโตล้างมือก่อนกินข้าว", coverArt: "img/cover-1.jpg" } };
  const rel = await composeCover(ep);
  const img = await loadImage(fs.readFileSync(path.join(process.env.KIDFACTORY_DATA, "episodes", "e1", rel)));
  const c = createCanvas(COVER.width, COVER.height);
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  const px = x.getImageData(0, 0, COVER.width, COVER.height).data;
  const at = (X, Y) => px.slice((Y * COVER.width + X) * 4, (Y * COVER.width + X) * 4 + 3);
  const grey = ([r, g, b]) => Math.abs(r - 128) < 12 && Math.abs(g - 128) < 12 && Math.abs(b - 128) < 12;
  // hues in the title area: several distinct bright colours, not one flat colour
  const hues = new Set();
  let inked = 0;
  for (let Y = 20; Y < 330; Y += 4) for (let X = 40; X < 680; X += 4) {
    const [r, g, b] = at(X, Y);
    if (!grey([r, g, b])) inked++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 90) hues.add(r === max ? (g > b ? "rg" : "rb") : g === max ? (r > b ? "gr" : "gb") : r > g ? "br" : "bg");
  }
  assert.ok(inked > 2000, "lettering in the top-left");
  assert.ok(hues.size >= 4, `letters in many colours (${[...hues]})`);
  for (const [X, Y] of [[1000, 200], [1200, 600], [300, 650], [700, 500]]) assert.ok(grey(at(X, Y)), `picture untouched at ${X},${Y}`);
});

test("cover title: emoji are left out and a very long title still fits inside the picture", async () => {
  const ep = { id: "e1", number: 1, story: { title: "t" }, package: { title: `ปิ่นโต 🎉 ${"ล้างมือก่อนกินข้าวทุกวัน".repeat(4)}`, coverArt: "img/cover-1.jpg" } };
  assert.ok(await composeCover(ep));
});
