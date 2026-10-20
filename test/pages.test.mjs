import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEpisode, loadEpisode, editNarration } from "../src/episodes.mjs";
import { GeminiError } from "../src/gemini.mjs";
import { writeWav, wavSeconds } from "../src/audio.mjs";
import { makeImages, makeVoices, staleVoices, pickTake, pageRefs } from "../src/pages.mjs";
import { CodexError } from "../src/codex.mjs";
import { library, findSheet, addSheet } from "../src/sheets.mjs";
import { jpeg, readyLibrary, gem } from "./helpers.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("../docs/sample-story.json", import.meta.url), "utf8"));

function setup() {
  process.env.KIDFACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kf-pg-"));
  readyLibrary(sample.story.newSheets);
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
      return jpeg();
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
  const g = { calls: { n: 0 }, image: async (p) => { if (/FAIL/.test(p)) throw new GeminiError("refused", "x", "ภาพถูกปฏิเสธ"); return jpeg(); } };
  ep.story.pages[1].scene = "FAIL";
  const out = await makeImages(ep, gem(g), { concurrency: 2 });
  const [a, b, c] = out.story.pages;
  assert.equal(b.image.state, "error");
  assert.equal(b.image.error, "Gemini ไม่ยอมวาดหน้านี้ ลองกด ↻ ภาพใหม่ อีกครั้ง");
  assert.equal(a.image.state, "done");
  assert.equal(c.image.state, "done");
  assert.ok(fs.existsSync(path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, a.image.file)));
  assert.equal(a.image.file, "img/p01.jpg");
  assert.equal(loadEpisode(ep.id).story.pages[1].image.state, "error");
});

test("page refs: house style first, then each character's sheet, then the place sheet; close-ups get no place", async () => {
  const ep = setup();
  const p = ep.story.pages[1]; // pinto, friend, teacher in the classroom
  const refs = pageRefs(p);
  assert.match(refs[0].label, /^house style reference ONLY/);
  assert.deepEqual(refs.slice(1, 4).map((r) => r.label.match(/\((\w[\w-]*)\)/)[1]), ["pinto", "friend", "teacher"]);
  assert.match(refs[4].label, /^place anchor for .*\(school-classroom\).*ONLY.*never for people.*framing/);
  assert.equal(refs.length, 5);
  for (const r of refs) assert.ok(fs.existsSync(r.path), r.path);
  const close = ep.story.pages[5]; // location "" = a close-up
  assert.equal(close.location, "");
  assert.ok(!pageRefs(close).some((r) => /place anchor/.test(r.label)));
  // the picture call gets the same files, labelled in the prompt
  const g = fake();
  await makeImages(ep, gem(g), { pages: [2] });
  assert.equal(g.calls.image[0].refs.length, 5);
  assert.match(g.calls.image[0].prompt, /Attachments in order:\n1\. house style/);
  assert.match(g.calls.image[0].prompt, /Time of day and light \(the same on every page\): late morning/);
});

test("prop looks are repeated on every page that shows them, and dot eyes are always asked for", async () => {
  const ep = setup();
  const g = fake();
  await makeImages(ep, gem(g), { pages: [6, 7] });
  for (const c of g.calls.image) {
    assert.match(c.prompt, /lunch-tray: a stainless steel school lunch tray/);
    assert.match(c.prompt, /solid black dot eyes/);
  }
});

test("pages option, default skips done, concurrency cap, onChange", async () => {
  const ep = ep3(setup());
  const g = fake();
  let changes = 0;
  const out = await makeImages(ep, gem(g), { pages: [2, 3], concurrency: 1, onChange: () => changes++ });
  assert.equal(out.story.pages[0].image.state, "todo");
  assert.equal(g.calls.max, 1);
  assert.ok(changes >= 2);
  await makeImages(out, gem(g), {});
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
  const out = await makeImages(ep, gem(fake()), { onChange: () => { calls++; throw new Error("ui"); } });
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
  await makeImages(ep, gem(g), { concurrency: "abc" });
  assert.equal(g.calls.max, 3);
});

test("estimateCost: voices (+ images and story when Gemini draws), in USD and baht", async () => {
  const { COSTS, estimateCost } = await import("../src/pages.mjs");
  assert.deepEqual(COSTS, { image: 0.0504, story: 0.012, ttsPer10s: 0.00225, musicTrack: 0.08, thbPerUsd: 33 });
  const page = (narration, voice) => ({ narration, scene: "s", cast: ["pinto"], image: { state: "todo" }, voice });
  // 2 pages: one real 20 s voice, one estimated from 110 Thai characters at 11 chars/s = 10 s
  const ep = { story: { pages: [
    page("ก".repeat(10), { state: "done", seconds: 20, forText: "ก".repeat(10) }),
    page("ข".repeat(110), { state: "todo" }),
  ] } };
  const c = estimateCost(ep); // ChatGPT draws and writes within its plan
  const usd = 3 * 0.00225;
  assert.ok(Math.abs(c.usd - usd) < 1e-9);
  assert.ok(Math.abs(c.thb - usd * 33) < 1e-9);
  const g = estimateCost(ep, { gemini: true });
  assert.ok(Math.abs(g.usd - (usd + 2 * 0.0504 + 0.012)) < 1e-9);
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
      return jpeg();
    },
  };
  const out = await makeImages(ep, gem(g), { pages: [1] });
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
  const out = await makeImages(ep, gem(g), { pages: [1] });
  assert.equal(n, 2);
  assert.equal(out.story.pages[0].image.state, "error");
  assert.equal(out.story.pages[0].image.error, "Gemini ไม่ยอมวาดหน้านี้ ลองกด ↻ ภาพใหม่ อีกครั้ง");
});

test("non-refusal image errors are not retried", async () => {
  const ep = ep3(setup());
  let n = 0;
  const g = { image: async () => { n++; throw new GeminiError("busy", "x"); } };
  const out = await makeImages(ep, gem(g), { pages: [1] });
  assert.equal(n, 1);
  assert.equal(out.story.pages[0].image.error, "Gemini ไม่ว่าง ลองใหม่อีกครั้ง");
});

const epPath = (ep, rel) => path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, rel);

test("a new image or voice adds a take; every take stays on disk; the newest is used", async () => {
  const ep = ep3(setup());
  const g = fake();
  await makeImages(ep, gem(g), { pages: [1] });
  await makeImages(ep, gem(g), { pages: [1] });
  await makeImages(ep, gem(g), { pages: [1] });
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
  await makeImages(ep, gem(fake()), { pages: [1] });
  const g = { image: async () => { throw new GeminiError("refused", "x", "ภาพถูกปฏิเสธ"); } };
  await makeImages(ep, gem(g), { pages: [1] });
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
  await makeImages(ep, gem(g), { pages: [1] });
  await makeImages(ep, gem(g), { pages: [1] });
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

// An AI client double: records every image request; `fail(req, n)` may throw.
function recorder(fail = () => {}) {
  const reqs = [];
  return {
    reqs,
    provider: "chatgpt",
    async image(req) {
      reqs.push(req);
      fail(req, reqs.length);
      return { bytes: jpeg(), prompt: req.feedback ? `REVISED ${req.feedback}` : req.prompt };
    },
  };
}

test("ChatGPT draws five pages at a time by default", async () => {
  const ep = setup();
  ep.story.pages = Array.from({ length: 12 }, (_, i) => ({ ...ep.story.pages[0], narration: `n${i}`, image: { state: "todo" } }));
  let active = 0, max = 0;
  const ai = {
    provider: "chatgpt",
    async image() {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { bytes: jpeg(), prompt: "p" };
    },
  };
  await makeImages(ep, ai);
  assert.equal(max, 5);
  assert.ok(ep.story.pages.every((p) => p.image.state === "done"));
});

test("retake with feedback edits the picture in use and keeps the old take", async () => {
  const ep = ep3(setup());
  const ai = recorder();
  await makeImages(ep, ai, { pages: [1] });
  const first = ep.story.pages[0].image;
  await makeImages(ep, ai, { pages: [1], feedback: "มือพัง" });
  const r = ai.reqs[1];
  assert.equal(r.feedback, "มือพัง");
  assert.equal(r.prompt, first.prompt, "the last prompt is the base of the change");
  assert.equal(r.editTarget, epPath(ep, first.file));
  assert.match(r.context, /Narration: /);
  const p = ep.story.pages[0];
  assert.equal(p.imageTakes.length, 2);
  assert.equal(p.image.file, "img/p01-2.jpg");
  assert.equal(p.image.prompt, "REVISED มือพัง");
  assert.equal(p.image.feedback, "มือพัง");
  // feedback on a page that has no picture yet is a fresh picture
  await makeImages(ep, ai, { pages: [2], feedback: "แมวหายไป" });
  assert.equal(ai.reqs[2].feedback, null);
  assert.equal(ai.reqs[2].editTarget, null);
});

test("a ChatGPT limit stops the job: finished pages stay, the rest wait as before", async () => {
  const ep = ep3(setup());
  const ai = recorder((req, n) => { if (n === 2) throw new CodexError("limit", "usage", { retryAt: null }); });
  await assert.rejects(makeImages(ep, ai, { concurrency: 1 }), (e) => e.code === "limit");
  const [a, b, c] = ep.story.pages;
  assert.equal(a.image.state, "done");
  assert.equal(b.image.state, "todo");
  assert.equal(c.image.state, "todo");
  assert.equal(ai.reqs.length, 2, "page 3 was not tried");
  // pressing again later draws only the missing pages
  const ok = recorder();
  await makeImages(ep, ok, {});
  assert.equal(ok.reqs.length, 2);
  assert.ok(ep.story.pages.every((p) => p.image.state === "done"));
});

test("a missing library sheet is drawn once before the pages, then reused by the next episode", async () => {
  process.env.KIDFACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kf-pg-"));
  readyLibrary();
  addSheet({ kind: "character", name: "คุณครู", description: "a kind teacher", tag: "teacher", auto: true });
  const story = structuredClone(sample.story);
  story.pages = story.pages.slice(0, 2).map((p) => ({ ...p, cast: ["pinto", "teacher"], location: "" }));
  const one = createEpisode(sample.idea, story);
  const ai = recorder();
  await makeImages(one, ai, {});
  assert.equal(ai.reqs.length, 3);
  assert.match(ai.reqs[0].prompt, /^Character reference sheet/);
  assert.ok(findSheet("teacher").chosen);
  assert.deepEqual(findSheet("teacher").usedBy, [one.id]);
  assert.ok(ai.reqs[1].refs.some((r) => /\(teacher\)/.test(r.label)), "pages use the new sheet");
  const two = createEpisode(sample.idea, story);
  const ai2 = recorder();
  await makeImages(two, ai2, {});
  assert.equal(ai2.reqs.length, 2, "no new sheet");
  assert.deepEqual(findSheet("teacher").usedBy, [one.id, two.id]);
  assert.equal(library().filter((s) => s.tag.startsWith("teacher")).length, 1);
});

test("an existing library (from v1.0.0) gets the ready-drawn starting sheets it has no picture for, keeps the rest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kf-pg-"));
  process.env.KIDFACTORY_DATA = root;
  const seeds = JSON.parse(fs.readFileSync(new URL("../assets/sheets.json", import.meta.url), "utf8"));
  fs.mkdirSync(path.join(root, "sheets"));
  fs.writeFileSync(path.join(root, "sheets", "pinto-1.jpg"), jpeg());
  const old = seeds.map((s) => ({ ...s, takes: [], chosen: null, locked: false, usedBy: [], auto: false, state: "todo" }));
  Object.assign(old[0], { takes: [{ file: "pinto-1.jpg", prompt: "mine" }], chosen: "pinto-1.jpg", state: "done" });
  old.push({ tag: "teacher", kind: "character", name: "ครู", description: "d", takes: [], chosen: null, locked: false, usedBy: [], auto: true, state: "todo" });
  fs.writeFileSync(path.join(root, "sheets", "sheets.json"), JSON.stringify(old));
  assert.equal(findSheet("pinto").chosen, "pinto-1.jpg");
  assert.deepEqual(findSheet("pinto").takes.map((t) => t.prompt), ["mine"], "a drawn sheet is left alone");
  assert.equal(findSheet("cat").chosen, "cat-1.jpg");
  assert.equal(findSheet("teacher").chosen, null, "only the starting sheets come ready-drawn");
  const disk = JSON.parse(fs.readFileSync(path.join(root, "sheets", "sheets.json"), "utf8"));
  assert.equal(disk.find((s) => s.tag === "dining-room").chosen, "dining-room-1.jpg");
  // loading again adds nothing
  process.env.KIDFACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kf-pg-"));
  library();
  process.env.KIDFACTORY_DATA = root;
  assert.equal(findSheet("cat").takes.length, 1);
});
