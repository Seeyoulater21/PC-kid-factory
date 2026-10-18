// One-off: crop the sitting cat from the character sheet into windows/icon.ico (PNG-in-ICO, several sizes).
// Usage: node scripts/make-icon.mjs [preview.png]
import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const SRC = new URL("../assets/characters/cat.jpg", import.meta.url);
const OUT = new URL("../windows/icon.ico", import.meta.url);
const CROP = { x: 150, y: 95, size: 780 }; // the front-facing sitting cat with the red scarf
const SIZES = [256, 64, 48, 32, 16];

const img = await loadImage(fs.readFileSync(SRC));

function draw(size) {
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  const r = size * 0.2;
  g.beginPath();
  g.roundRect(0, 0, size, size, r);
  g.clip();
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size, size);
  g.drawImage(img, CROP.x, CROP.y, CROP.size, CROP.size, 0, 0, size, size);
  return c.toBuffer("image/png");
}

const pngs = SIZES.map(draw);
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(pngs.length, 4);
let offset = head.length;
pngs.forEach((png, i) => {
  const e = 6 + 16 * i;
  const s = SIZES[i] >= 256 ? 0 : SIZES[i]; // 0 means 256
  head.writeUInt8(s, e);
  head.writeUInt8(s, e + 1);
  head.writeUInt16LE(1, e + 4); // planes
  head.writeUInt16LE(32, e + 6); // bits per pixel
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.mkdirSync(new URL("../windows/", import.meta.url), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([head, ...pngs]));
if (process.argv[2]) fs.writeFileSync(process.argv[2], pngs[0]);
console.log("wrote windows/icon.ico");
