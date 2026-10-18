import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { createEpisode, saveEpisode } from "../src/episodes.mjs";
import { writeWav } from "../src/audio.mjs";
import { addTrack, listTracks } from "../src/music.mjs";
import { renderEpisode, safeTitle, chooseMusic, outputName } from "../src/render/video.mjs";

const FFMPEG = process.env.KIDFACTORY_FFMPEG || "ffmpeg";
const FFPROBE = process.env.KIDFACTORY_FFPROBE || "ffprobe";
const sample = JSON.parse(fs.readFileSync(new URL("../docs/sample-story.json", import.meta.url), "utf8"));
const SIZE = { width: 320, height: 180 };

const jpeg = (color) => {
  const c = createCanvas(640, 360);
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.fillRect(0, 0, 640, 360);
  return c.toBuffer("image/jpeg");
};
const tone = (seconds, hz) => {
  const rate = 24000, n = Math.round(seconds * rate), s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate));
  return writeWav({ rate, channels: 1, samples: s });
};
const silentMp3 = (seconds) =>
  execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`, "-t", String(seconds), "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "-"]);

function setup(t, { dirName = "kf-video-", title = "ปิ่นโต ทดสอบ" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kf-video-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.KIDFACTORY_DATA = path.join(root, dirName);
  const story = { ...sample.story, title, pages: sample.story.pages.slice(0, 2) };
  const ep = createEpisode(sample.idea, story);
  const dir = path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id);
  ep.story.pages.forEach((p, i) => {
    const n = String(i + 1).padStart(2, "0");
    fs.writeFileSync(path.join(dir, `img/p${n}.jpg`), jpeg(i ? "#3060e0" : "#e04030"));
    fs.writeFileSync(path.join(dir, `voice/p${n}.wav`), tone(1, i ? 660 : 440));
    p.image = { state: "done", file: `img/p${n}.jpg` };
    p.voice = { state: "done", file: `voice/p${n}.wav`, seconds: 1, forText: p.narration };
  });
  addTrack({ id: "test-silence", mood: "calm", title: "t", source: "cc0", licence: "test", addedAt: "2026-01-01" }, silentMp3(4));
  ep.musicId = "test-silence";
  saveEpisode(ep);
  return { ep, dir };
}

function probe(file) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,sample_rate,channels,r_frame_rate", "-of", "json", file]);
  return JSON.parse(out.toString());
}
// integrated loudness (LUFS) of a file's audio
function measure(file) {
  const err = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = [...err.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].pop();
  return m ? Number(m[1]) : NaN;
}

function checkVideo(file) {
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  assert.ok(v, "has a video stream");
  assert.ok(a, "has an audio stream");
  assert.equal(v.codec_name, "h264");
  assert.equal(v.pix_fmt, "yuv420p");
  assert.equal(v.width, SIZE.width);
  assert.equal(v.height, SIZE.height);
  assert.equal(v.r_frame_rate, "30/1");
  assert.equal(a.codec_name, "aac");
  assert.equal(Number(a.sample_rate), 48000);
  assert.equal(a.channels, 2);
  const d = Number(info.format.duration);
  assert.ok(Math.abs(d - 16.3) <= 0.2, `duration ${d} ≈ 16.3`);
}

test("outputName: 2-digit episode number, then the safe title; no number, no prefix", () => {
  assert.equal(outputName({ number: 3, story: { title: "ปิ่นโต: ล้างมือ" } }), "EP03 ปิ่นโต ล้างมือ.mp4");
  assert.equal(outputName({ number: 112, story: { title: "ก" } }), "EP112 ก.mp4");
  assert.equal(outputName({ story: { title: "ก" } }), "ก.mp4");
});

test("safeTitle keeps Thai and spaces, drops illegal characters", () => {
  assert.equal(safeTitle('  ปิ่นโต: ล้าง/มือ? "ดี" <1>|*\\  '), "ปิ่นโต ล้าง มือ ดี 1");
  assert.equal(safeTitle("ปิ่นโต ล้างมือ"), "ปิ่นโต ล้างมือ");
  assert.equal(safeTitle(" ?? "), "episode");
  assert.equal(safeTitle("จบแล้ว..."), "จบแล้ว");
});

test("render refuses stale voice", async (t) => {
  const { ep } = setup(t);
  ep.story.pages[1].narration = "ข้อความใหม่";
  await assert.rejects(renderEpisode(ep, SIZE), { message: "เสียงหน้า 2 ยังไม่อัปเดต" });
});

test("render refuses an unfinished image", async (t) => {
  const { ep } = setup(t);
  ep.story.pages[0].image = { state: "error", error: "x" };
  await assert.rejects(renderEpisode(ep, SIZE), { message: "ภาพหน้า 1 ยังไม่เสร็จ" });
});

test("renders a tiny episode", async (t) => {
  const { ep, dir } = setup(t);
  const seen = [];
  const file = await renderEpisode(ep, { ...SIZE, onProgress: (f) => seen.push(f) });
  assert.equal(file, path.join(dir, "out", "EP01 ปิ่นโต ทดสอบ.mp4"));
  checkVideo(file);
  const lufs = measure(file);
  assert.ok(Math.abs(lufs + 14) <= 1.5, `loudness ${lufs} ≈ -14 LUFS`);
  assert.ok(seen.length >= 5, "progress reported regularly");
  assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])), "progress grows within 0..1");
  assert.equal(seen.at(-1), 1);
  assert.ok(listTracks().find((t) => t.id === "test-silence").lastUsedAt, "music marked used");
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), ["EP01 ปิ่นโต ทดสอบ.mp4"], "no temp files left behind");
});

test("renders when paths contain spaces and Thai", async (t) => {
  const { ep, dir } = setup(t, { dirName: "คลัง วิดีโอ", title: "ปิ่นโต ล้างมือ" });
  const file = await renderEpisode(ep, SIZE);
  assert.equal(file, path.join(dir, "out", "EP01 ปิ่นโต ล้างมือ.mp4"));
  checkVideo(file);
});

const noThaiDetail = (e) => {
  assert.ok(!/ffmpeg|Error|\n/i.test(e.message), `message carries no tool output: ${e.message}`);
  return true;
};

test("a broken page image fails fast with a Thai message and leaves nothing in out/", async (t) => {
  const { ep, dir } = setup(t);
  fs.writeFileSync(path.join(dir, "img/p01.jpg"), Buffer.from("not really a jpeg"));
  const t0 = Date.now();
  await assert.rejects(renderEpisode(ep, SIZE), (e) => e.message === "ภาพหน้า 1 เสียหาย ลองกด ↻ ภาพใหม่" && noThaiDetail(e));
  assert.ok(Date.now() - t0 < 3000, "rejects promptly");
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), []);
});

test("ffmpeg failure rejects with the generic Thai message; detail kept aside", async (t) => {
  const { ep, dir } = setup(t);
  const before = process.env.KIDFACTORY_FFMPEG;
  process.env.KIDFACTORY_FFMPEG = "/usr/bin/false";
  t.after(() => { if (before === undefined) delete process.env.KIDFACTORY_FFMPEG; else process.env.KIDFACTORY_FFMPEG = before; });
  await assert.rejects(renderEpisode(ep, SIZE), (e) => e.message === "สร้างวิดีโอไม่สำเร็จ" && typeof e.detail === "string" && noThaiDetail(e));
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), []);
});

test("a 0-byte intro clip rejects with the generic Thai message", async (t) => {
  const { ep, dir } = setup(t);
  const empty = path.join(dir, "empty intro.mp4");
  fs.writeFileSync(empty, "");
  await assert.rejects(renderEpisode(ep, { ...SIZE, clips: { intro: empty } }), (e) => e.message === "สร้างวิดีโอไม่สำเร็จ" && noThaiDetail(e));
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), []);
});

test("chooseMusic: the episode's track, else least recently used of the mood", (t) => {
  const { ep } = setup(t);
  assert.equal(chooseMusic(ep).id, "test-silence");
  const other = chooseMusic({ ...ep, musicId: "gone", story: { ...ep.story, mood: "bright" } });
  assert.equal(other.id, "seed-bright");
  assert.ok(other.file.endsWith(path.join("music", "seed-bright.mp3")));
});

test("a page that breaks mid-render stops ffmpeg and fails with a Thai message", async (t) => {
  const { ep, dir } = setup(t);
  let calls = 0;
  const onProgress = () => {
    // 2nd call = first frame already piped; page 2 is decoded again only at the turn
    if (++calls === 2) fs.writeFileSync(path.join(dir, "img/p02.jpg"), Buffer.from("broken"));
  };
  const t0 = Date.now();
  await assert.rejects(renderEpisode(ep, { ...SIZE, onProgress }), (e) => e.message === "ภาพหน้า 2 เสียหาย ลองกด ↻ ภาพใหม่" && noThaiDetail(e));
  assert.ok(Date.now() - t0 < 10000, "does not hang");
  assert.deepEqual(fs.readdirSync(path.join(dir, "out")), []);
});
