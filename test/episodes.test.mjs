import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEpisode, loadEpisode, saveEpisode, listEpisodes, editNarration,
  saveIdeas, listSavedIdeas, removeSavedIdea, episodeStatus,
} from "../src/episodes.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("../docs/sample-story.json", import.meta.url), "utf8"));

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kf-ep-"));
  process.env.KIDFACTORY_DATA = d;
  return d;
}

test("create then load round-trips", () => {
  const d = tmp();
  const ep = createEpisode(sample.idea, sample.story);
  assert.match(ep.id, /^ep-\d{8}-\d{6}/);
  for (const sub of ["img", "voice", "out"]) {
    assert.ok(fs.statSync(path.join(d, "episodes", ep.id, sub)).isDirectory());
  }
  assert.deepEqual(ep.story.pages[0].image, { state: "todo" });
  assert.deepEqual(ep.story.pages[0].voice, { state: "todo" });
  assert.deepEqual(loadEpisode(ep.id), ep);
});

test("ids do not collide when created in the same second", () => {
  tmp();
  const a = createEpisode(sample.idea, sample.story);
  const b = createEpisode(sample.idea, sample.story);
  assert.notEqual(a.id, b.id);
  assert.equal(listEpisodes().length, 2);
});

test("loading resets working pages to todo (image and voice)", () => {
  tmp();
  const ep = createEpisode(sample.idea, sample.story);
  ep.story.pages[0].image = { state: "working" };
  ep.story.pages[1].voice = { state: "working" };
  ep.story.pages[2].image = { state: "done", file: "p03.jpg" };
  saveEpisode(ep);
  const got = loadEpisode(ep.id);
  assert.deepEqual(got.story.pages[0].image, { state: "todo" });
  assert.deepEqual(got.story.pages[1].voice, { state: "todo" });
  assert.deepEqual(got.story.pages[2].image, { state: "done", file: "p03.jpg" });
});

test("saveEpisode leaves no temp files behind", () => {
  const d = tmp();
  const ep = createEpisode(sample.idea, sample.story);
  saveEpisode(ep);
  assert.deepEqual(fs.readdirSync(path.join(d, "episodes", ep.id)).sort(), ["episode.json", "img", "out", "voice"]);
});

test("files are named by id, not title", () => {
  const d = tmp();
  const ep = createEpisode({ title: "ปิ่นโต ล้างมือ", pitch: "x" }, sample.story);
  assert.deepEqual(fs.readdirSync(path.join(d, "episodes")), [ep.id]);
  assert.match(ep.id, /^ep-/);
  assert.equal(listEpisodes()[0].title, sample.story.title);
});

test("listEpisodes returns id, number, title, createdAt, status, highest number first", () => {
  tmp();
  const a = createEpisode(sample.idea, sample.story);
  const b = createEpisode(sample.idea, sample.story);
  const l = listEpisodes();
  assert.deepEqual(Object.keys(l[0]).sort(), ["createdAt", "id", "number", "status", "title"]);
  assert.equal(l[0].status, "เขียนเรื่องแล้ว");
  assert.equal(l[0].id, b.id);
  assert.equal(l[1].id, a.id);
});

test("listEpisodes is empty on a fresh dir", () => {
  tmp();
  assert.deepEqual(listEpisodes(), []);
});

test("editNarration changes text, resets that page's voice, keeps the original", () => {
  tmp();
  const ep = createEpisode(sample.idea, sample.story);
  ep.story.pages[0].voice = { state: "done", file: "p01.wav", seconds: 5, forText: ep.story.pages[0].narration };
  const before = ep.story.pages[0].narration;
  const out = editNarration(ep, 1, "ข้อความใหม่");
  assert.equal(out.story.pages[0].narration, "ข้อความใหม่");
  assert.deepEqual(out.story.pages[0].voice, { state: "todo" });
  assert.equal(ep.story.pages[0].narration, before);
  assert.equal(editNarration(ep, ep.story.pages.length, "z").story.pages.at(-1).narration, "z");
  assert.throws(() => editNarration(ep, 0, "x"));
  assert.throws(() => editNarration(ep, ep.story.pages.length + 1, "x"));
});

test("saveIdeas appends and listSavedIdeas returns them", () => {
  tmp();
  assert.deepEqual(listSavedIdeas(), []);
  saveIdeas([{ title: "A", pitch: "a" }]);
  saveIdeas([{ title: "B", pitch: "b" }]);
  assert.deepEqual(listSavedIdeas().map((i) => i.title), ["A", "B"]);
});

test("saveIdeas skips a title that is already saved", () => {
  tmp();
  saveIdeas([{ title: "A", pitch: "a" }, { title: "A", pitch: "again" }]);
  saveIdeas([{ title: "A", pitch: "third" }]);
  assert.equal(listSavedIdeas().length, 1);
});

test("removeSavedIdea removes by title and ignores unknown", () => {
  tmp();
  saveIdeas([{ title: "A", pitch: "a" }, { title: "B", pitch: "b" }]);
  removeSavedIdea("A");
  removeSavedIdea("nope");
  assert.deepEqual(listSavedIdeas().map((i) => i.title), ["B"]);
});

test("episode ids that are not ep-… are rejected (no path traversal)", () => {
  tmp();
  assert.throws(() => loadEpisode("../x"));
  assert.throws(() => saveEpisode({ id: "../x", story: { pages: [] } }));
});

test("episode numbers count up from 1; old episodes without a number do not break it", () => {
  const d = tmp();
  const a = createEpisode(sample.idea, sample.story);
  assert.equal(a.number, 1);
  const old = createEpisode(sample.idea, sample.story);
  delete old.number;
  saveEpisode(old);
  const b = createEpisode(sample.idea, sample.story);
  assert.equal(b.number, 3); // number 2 was given out once (to `old`) and is never given again
  const l = listEpisodes();
  assert.deepEqual(l.map((e) => e.number), [3, 1, null]);
  assert.equal(l[2].id, old.id);
  fs.rmSync(path.join(d, "episodes", a.id), { recursive: true });
  assert.equal(createEpisode(sample.idea, sample.story).number, 4);
});

test("episodeStatus: written → in progress → ready → done → needs re-render", () => {
  const d = tmp();
  const ep = createEpisode(sample.idea, { ...sample.story, pages: sample.story.pages.slice(0, 2) });
  const dir = path.join(d, "episodes", ep.id);
  const put = (rel, when) => {
    fs.writeFileSync(path.join(dir, rel), "x");
    fs.utimesSync(path.join(dir, rel), when, when);
  };
  const t0 = new Date(Date.now() - 60_000), t1 = new Date(Date.now() - 30_000), t2 = new Date();
  assert.equal(episodeStatus(ep), "เขียนเรื่องแล้ว");
  put("img/p01.jpg", t0);
  ep.story.pages[0].image = { state: "done", file: "img/p01.jpg" };
  assert.equal(episodeStatus(ep), "ภาพ 1/2 · เสียง 0/2");
  ep.story.pages.forEach((p, i) => {
    const n = String(i + 1).padStart(2, "0");
    put(`img/p${n}.jpg`, t0);
    put(`voice/p${n}.wav`, t0);
    p.image = { state: "done", file: `img/p${n}.jpg` };
    p.voice = { state: "done", file: `voice/p${n}.wav`, seconds: 1, forText: p.narration };
  });
  assert.equal(episodeStatus(ep), "พร้อมประกอบ");
  put("out/EP01 x.mp4", t1);
  ep.video = { file: "out/EP01 x.mp4" };
  assert.equal(episodeStatus(ep), "วิดีโอเสร็จ");
  put("img/p02.jpg", t2); // a picture redone after the render
  assert.equal(episodeStatus(ep), "ต้องประกอบใหม่");
  ep.story.pages[1].narration = "ใหม่"; // edited text: its voice is stale again
  assert.equal(episodeStatus(ep), "ภาพ 2/2 · เสียง 1/2");
});

test("episodeStatus finds a rendered file in out/ even without ep.video", () => {
  const d = tmp();
  const ep = createEpisode(sample.idea, { ...sample.story, pages: sample.story.pages.slice(0, 1) });
  const dir = path.join(d, "episodes", ep.id);
  fs.writeFileSync(path.join(dir, "img/p01.jpg"), "x");
  fs.writeFileSync(path.join(dir, "voice/p01.wav"), "x");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(dir, "img/p01.jpg"), old, old);
  fs.utimesSync(path.join(dir, "voice/p01.wav"), old, old);
  ep.story.pages[0].image = { state: "done", file: "img/p01.jpg" };
  ep.story.pages[0].voice = { state: "done", file: "voice/p01.wav", seconds: 1, forText: ep.story.pages[0].narration };
  fs.writeFileSync(path.join(dir, "out", "EP01 เรื่อง.mp4"), "x");
  assert.equal(episodeStatus(ep), "วิดีโอเสร็จ");
});

test("an episode from before takes: its done image and voice become take 1", () => {
  const d = tmp();
  const ep = createEpisode(sample.idea, { ...sample.story, pages: sample.story.pages.slice(0, 2) });
  ep.story.pages[0].image = { state: "done", file: "img/p01.jpg" };
  ep.story.pages[0].voice = { state: "done", file: "voice/p01.wav", seconds: 1, forText: "x" };
  for (const p of ep.story.pages) { delete p.imageTakes; delete p.voiceTakes; }
  saveEpisode(ep);
  const p = loadEpisode(ep.id).story.pages;
  assert.deepEqual(p[0].imageTakes, [{ file: "img/p01.jpg" }]);
  assert.deepEqual(p[0].voiceTakes, [{ file: "voice/p01.wav", seconds: 1, forText: "x" }]);
  assert.deepEqual(p[1].imageTakes, []);
  assert.deepEqual(p[1].voiceTakes, []);
});

test("episodeStatus: picking another take after the render asks for a new render", () => {
  const d = tmp();
  const ep = createEpisode(sample.idea, { ...sample.story, pages: sample.story.pages.slice(0, 1) });
  const dir = path.join(d, "episodes", ep.id);
  const old = new Date(Date.now() - 60_000);
  for (const f of ["img/p01.jpg", "voice/p01.wav"]) {
    fs.writeFileSync(path.join(dir, f), "x");
    fs.utimesSync(path.join(dir, f), old, old);
  }
  const p = ep.story.pages[0];
  p.image = { state: "done", file: "img/p01.jpg" };
  p.voice = { state: "done", file: "voice/p01.wav", seconds: 1, forText: p.narration };
  fs.writeFileSync(path.join(dir, "out", "EP01 x.mp4"), "x");
  ep.video = { file: "out/EP01 x.mp4" };
  assert.equal(episodeStatus(ep), "วิดีโอเสร็จ");
  p.image.pickedAt = Date.now() + 1000;
  assert.equal(episodeStatus(ep), "ต้องประกอบใหม่");
});

test("a broken saved-ideas file is moved aside before the next save", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "saved-ideas.json"), "[{");
  assert.deepEqual(listSavedIdeas(), []);
  saveIdeas([{ title: "a", pitch: "b" }]);
  assert.deepEqual(listSavedIdeas(), [{ title: "a", pitch: "b" }]);
  const aside = fs.readdirSync(d).filter((f) => f.startsWith("saved-ideas.broken-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(d, aside[0]), "utf8"), "[{");
});

test("deleting the newest episode does not let the next one reuse its number", () => {
  const d = tmp();
  createEpisode(sample.idea, sample.story);
  const b = createEpisode(sample.idea, sample.story);
  assert.equal(b.number, 2);
  fs.rmSync(path.join(d, "episodes", b.id), { recursive: true });
  assert.equal(createEpisode(sample.idea, sample.story).number, 3);
  assert.equal(listEpisodes().length, 2);
});
