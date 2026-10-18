// Builds the placeholder intro/outro clips (5 s each): the book lying on the desk with a blank page,
// no text, silent. Intro has no audio stream; outro carries a silent AAC track (export handles both).
// The owner's real clips live at the same names (assets/clips/intro.mp4 is already the real one),
// so existing clips are never overwritten unless --force is given.
// Usage: node scripts/make-placeholder-clips.mjs [--force]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { createBook } from "../src/render/book.mjs";

const FFMPEG = process.env.KIDFACTORY_FFMPEG || "ffmpeg";
const OUT = fileURLToPath(new URL("../assets/clips/", import.meta.url));
const W = 1920, H = 1080, SEC = 5, FPS = 30;
const force = process.argv.includes("--force");
const wanted = ["intro.mp4", "outro.mp4"].filter((f) => force || !fs.existsSync(path.join(OUT, f)));
if (!wanted.length) {
  console.log("clips already exist; nothing written (use --force to replace them)");
  process.exit(0);
}

const canvas = createCanvas(W, H);
createBook({ width: W, height: H }).frame(canvas.getContext("2d"), { page: null });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "kf-clips-"));
const still = path.join(work, "still.png");
fs.writeFileSync(still, canvas.toBuffer("image/png"));
fs.mkdirSync(OUT, { recursive: true });

const video = ["-c:v", "libx264", "-preset", "slow", "-tune", "stillimage", "-crf", "30", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const common = ["-v", "error", "-y", "-loop", "1", "-framerate", String(FPS), "-t", String(SEC), "-i", still];
try {
  if (wanted.includes("intro.mp4")) {
    execFileSync(FFMPEG, [...common, "-vf", "fade=t=in:st=0:d=0.8", ...video, "-an", "-movflags", "+faststart", path.join(OUT, "intro.mp4")]);
  }
  if (wanted.includes("outro.mp4")) execFileSync(FFMPEG, [
    ...common, "-f", "lavfi", "-t", String(SEC), "-i", "anullsrc=r=48000:cl=stereo",
    "-vf", `fade=t=out:st=${SEC - 1}:d=1`, ...video, "-c:a", "aac", "-b:a", "32k", "-shortest",
    "-movflags", "+faststart", path.join(OUT, "outro.mp4"),
  ]);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
for (const f of wanted) console.log(f, fs.statSync(path.join(OUT, f)).size, "bytes");
