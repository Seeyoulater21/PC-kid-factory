import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEpisode, loadEpisode, editNarration } from "../src/episodes.mjs";
import { GeminiError } from "../src/gemini.mjs";
import { writeWav, wavSeconds } from "../src/audio.mjs";
import { makeImages, makeVoices, staleVoices, pickTake } from "../src/pages.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("../docs/sample-story.json", import.meta.url), "utf8"));

function setup() {
  process.env.KIDFACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kf-pg-"));
  return createEpisode(sample.idea, sample.story);
}
const wav = () => writeWav({ rate: 24000, channels: 1, samples: new Int16Array(12000) });

function fake({ failOn } = {}) {
  const calls = { image: [], speech: [], active: 0, max: 0 };
  const run = async (fn) => {
    calls.active++;
    calls.max = Math.max(calls.max, calls.active);
    await new Promise((r) => setTimeout(r, 5));
    calls.active--;
    return fn();
  };
  return {
    calls,
    image: (prompt, refs) => run(() => {
      calls.image.push({ prompt, refs });
      if (failOn === calls.image.length) throw new GeminiError("refused", "x", "ภาพถูกปฏิเสธ");
      return Buffer.from("jpg");
    }),
    speech: (text, opts) => run(() => {
      calls.speech.push({ text, opts });
      if (failOn && text === failOn) throw new Error("boom");
      return wav();
    }),
  };
}
const ep3 = (ep) => ({ ...ep, story: { ...ep.story, pages: ep.story.pages.slice(0, 3) } });

test("one failed page does not stop the others", async () => {
  const ep = ep3(setup());
  const g = { calls: { n: 0 }, image: async (p) => { if (/FAIL/.test(p)) throw new GeminiError("refused", "x", "ภาพถูกปฏิเสธ"); return Buffer.from("jpg"); } };
  ep.story.pages[1].scene = "FAIL";
  const out = await makeImages(ep, g, { concurrency: 2 });
  const [a, b, c] = out.story.pages;
  assert.equal(b.image.state, "error");
  assert.equal(b.image.error, "Gemini ไม่ยอมวาดหน้านี้ ลองกด ↻ ภาพใหม่ อีกครั้ง");
  assert.equal(a.image.state, "done");
  assert.equal(c.image.state, "done");
  assert.ok(fs.existsSync(path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, a.image.file)));
  assert.equal(a.image.file, "img/p01.jpg");
  assert.equal(loadEpisode(ep.id).story.pages[1].image.state, "error");
});

test("image refs are the 3 main sheets", async () => {
  const ep = ep3(setup());
  const g = fake();
  await makeImages(ep, g, { pages: [1] });
  assert.equal(g.calls.image.length, 1);
  const refs = g.calls.image[0].refs;
  assert.equal(refs.length, 3);
  for (const r of refs) { assert.equal(r.mime, "image/jpeg"); assert.ok(Buffer.isBuffer(r.data) && r.data.length > 0); }
});

test("pages option, default skips done, concurrency cap, onChange", async () => {
  const ep = ep3(setup());
  const g = fake();
  let changes = 0;
  const out = await makeImages(ep, g, { pages: [2, 3], concurrency: 1, onChange: () => changes++ });
  assert.equal(out.story.pages[0].image.state, "todo");
  assert.equal(g.calls.max, 1);
  assert.ok(changes >= 2);
  await makeImages(out, g, {});
  assert.equal(g.calls.image.length, 3); // 2,3 then only page 1
});

test("voices: files, seconds, voice settings; non-Gemini error is generic Thai", async () => {
  const ep = ep3(setup());
  const g = fake({ failOn: ep.story.pages[2].narration });
  const out = await makeVoices(ep, g, {});
  const p = out.story.pages;
  assert.equal(p[0].voice.state, "done");
  assert.equal(p[0].voice.file, "voice/p01.wav");
  assert.equal(p[0].voice.seconds, 0.5);
  assert.equal(p[0].voice.forText, p[0].narration);
  assert.equal(wavSeconds(fs.readFileSync(path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, p[0].voice.file))), 0.5);
  assert.equal(p[2].voice.state, "error");
  assert.equal(p[2].voice.error, "เกิดข้อผิดพลาด ลองใหม่");
  assert.ok(g.calls.speech[0].opts.voice && g.calls.speech[0].opts.style);
});

test("editing narration marks voice stale", async () => {
  const ep = ep3(setup());
  const g = fake();
  const done = await makeVoices(ep, g, {});
  assert.deepEqual(staleVoices(done), []);
  const edited = editNarration(done, 1, "ข้อความใหม่");
  assert.deepEqual(staleVoices(edited), [1]);
  // text changed behind a done state is also stale
  const sneaky = structuredClone(done);
  sneaky.story.pages[1].narration = "เปลี่ยน";
  assert.deepEqual(staleVoices(sneaky), [2]);
  const again = await makeVoices(sneaky, g, {});
  assert.deepEqual(staleVoices(again), []);
  assert.equal(g.calls.speech.length, 4);
});

const allSettled = (ep, key) => ep.story.pages.every((p) => ["done", "error"].includes(p[key].state));

test("onChange that throws does not break the run", async () => {
  const ep = ep3(setup());
  let calls = 0;
  const out = await makeImages(ep, fake(), { onChange: () => { calls++; throw new Error("ui"); } });
  assert.ok(calls > 0);
  assert.ok(allSettled(out, "image"));
  assert.equal(out.story.pages.filter((p) => p.image.state === "working").length, 0);
});

test("pool: 5 pages, concurrency 2, max in flight is 2, a throwing page does not stall", async () => {
  const ep = setup();
  ep.story.pages = ep.story.pages.slice(0, 5);
  const g = fake({ failOn: ep.story.pages[1].narration });
  const out = await makeVoices(ep, g, { concurrency: 2 });
  assert.equal(g.calls.max, 2);
  assert.equal(out.story.pages.filter((p) => p.voice.state === "done").length, 4);
  assert.equal(out.story.pages[1].voice.state, "error");
});

test("non-numeric concurrency falls back to 3", async () => {
  const ep = setup();
  ep.story.pages = ep.story.pages.slice(0, 5);
  const g = fake();
  await makeImages(ep, g, { concurrency: "abc" });
  assert.equal(g.calls.max, 3);
});

test("estimateCost: images + voices + story, in USD and baht", async () => {
  const { COSTS, estimateCost } = await import("../src/pages.mjs");
  assert.deepEqual(COSTS, { image: 0.0504, story: 0.012, ttsPer10s: 0.00225, musicTrack: 0.08, thbPerUsd: 33 });
  const page = (narration, voice) => ({ narration, scene: "s", cast: ["pinto"], image: { state: "todo" }, voice });
  // 2 pages: one real 20 s voice, one estimated from 110 Thai characters at 11 chars/s = 10 s
  const ep = { story: { pages: [
    page("ก".repeat(10), { state: "done", seconds: 20, forText: "ก".repeat(10) }),
    page("ข".repeat(110), { state: "todo" }),
  ] } };
  const c = estimateCost(ep);
  const usd = 2 * 0.0504 + 0.012 + 3 * 0.00225;
  assert.ok(Math.abs(c.usd - usd) < 1e-9);
  assert.ok(Math.abs(c.thb - usd * 33) < 1e-9);
  // a newly generated music track adds its price; reused tracks are free
  assert.ok(Math.abs(estimateCost(ep, { newTracks: 1 }).usd - (usd + 0.08)) < 1e-9);
});

test("a refused image is retried once with a softening line and then succeeds", async () => {
  const ep = ep3(setup());
  const prompts = [];
  let first = true;
  const g = {
    image: async (p) => {
      prompts.push(p);
      if (first) { first = false; throw new GeminiError("refused", "x"); }
      return Buffer.from("jpg");
    },
  };
  const out = await makeImages(ep, g, { pages: [1] });
  assert.equal(out.story.pages[0].image.state, "done");
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].startsWith("A gentle, wholesome children's picture-book illustration."));
  assert.ok(prompts[1].startsWith("A gentle, wholesome children's picture-book illustration."));
  assert.ok(prompts[1].endsWith(prompts[0]));
});

test("an image refused twice becomes an error with the image-specific Thai text", async () => {
  const ep = ep3(setup());
  let n = 0;
  const g = { image: async () => { n++; throw new GeminiError("refused", "x"); } };
  const out = await makeImages(ep, g, { pages: [1] });
  assert.equal(n, 2);
  assert.equal(out.story.pages[0].image.state, "error");
  assert.equal(out.story.pages[0].image.error, "Gemini ไม่ยอมวาดหน้านี้ ลองกด ↻ ภาพใหม่ อีกครั้ง");
});

test("non-refusal image errors are not retried", async () => {
  const ep = ep3(setup());
  let n = 0;
  const g = { image: async () => { n++; throw new GeminiError("busy", "x"); } };
  const out = await makeImages(ep, g, { pages: [1] });
  assert.equal(n, 1);
  assert.equal(out.story.pages[0].image.error, "Gemini ไม่ว่าง ลองใหม่อีกครั้ง");
});

const epPath = (ep, rel) => path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, rel);

test("a new image or voice adds a take; every take stays on disk; the newest is used", async () => {
  const ep = ep3(setup());
  const g = fake();
  await makeImages(ep, g, { pages: [1] });
  await makeImages(ep, g, { pages: [1] });
  await makeImages(ep, g, { pages: [1] });
  const p = ep.story.pages[0];
  assert.deepEqual(p.imageTakes.map((t) => t.file), ["img/p01.jpg", "img/p01-2.jpg", "img/p01-3.jpg"]);
  for (const t of p.imageTakes) assert.ok(fs.existsSync(epPath(ep, t.file)));
  assert.equal(p.image.state, "done");
  assert.equal(p.image.file, "img/p01-3.jpg");
  await makeVoices(ep, g, { pages: [2] });
  await makeVoices(ep, g, { pages: [2] });
  const q = ep.story.pages[1];
  assert.deepEqual(q.voiceTakes.map((t) => t.file), ["voice/p02.wav", "voice/p02-2.wav"]);
  assert.equal(q.voiceTakes[1].forText, q.narration);
  assert.equal(q.voice.file, "voice/p02-2.wav");
  assert.deepEqual(loadEpisode(ep.id).story.pages[0].imageTakes.length, 3);
});

test("a failed new take keeps the old takes", async () => {
  const ep = ep3(setup());
  await makeImages(ep, fake(), { pages: [1] });
  const g = { image: async () => { throw new GeminiError("refused", "x", "ภาพถูกปฏิเสธ"); } };
  await makeImages(ep, g, { pages: [1] });
  const p = ep.story.pages[0];
  assert.equal(p.image.state, "error");
  assert.equal(p.imageTakes.length, 1);
  pickTake(ep, 1, "image", 1);
  assert.equal(p.image.state, "done");
  assert.equal(p.image.file, "img/p01.jpg");
});

test("pickTake: switch back to an older take; a voice take brings back the text it was read from", async () => {
  const ep = ep3(setup());
  const g = fake();
  await makeImages(ep, g, { pages: [1] });
  await makeImages(ep, g, { pages: [1] });
  pickTake(ep, 1, "image", 1);
  assert.equal(ep.story.pages[0].image.file, "img/p01.jpg");
  assert.ok(Number.isFinite(ep.story.pages[0].image.pickedAt));
  await makeVoices(ep, g, { pages: [1] });
  const first = ep.story.pages[0].narration;
  const edited = editNarration(ep, 1, "ข้อความใหม่");
  await makeVoices(edited, g, { pages: [1] });
  const p = edited.story.pages[0];
  assert.equal(p.voiceTakes.length, 2);
  pickTake(edited, 1, "voice", 1);
  assert.equal(p.voice.file, "voice/p01.wav");
  assert.equal(p.narration, first);
  assert.deepEqual(staleVoices(edited), [2, 3]);
  const before = p.voice.pickedAt;
  pickTake(edited, 1, "voice", 1); // the take already in use: nothing changes, no new render needed
  assert.equal(p.voice.pickedAt, before);
  assert.throws(() => pickTake(edited, 1, "voice", 3));
  assert.throws(() => pickTake(edited, 1, "voice", 0));
  assert.throws(() => pickTake(edited, 9, "image", 1));
  assert.throws(() => pickTake(edited, 1, "music", 1));
});
