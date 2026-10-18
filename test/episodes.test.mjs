import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEpisode, loadEpisode, saveEpisode, listEpisodes, editNarration,
  saveIdeas, listSavedIdeas, removeSavedIdea,
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

test("listEpisodes returns id, title, createdAt, newest first", () => {
  tmp();
  const a = createEpisode(sample.idea, sample.story);
  const b = createEpisode(sample.idea, sample.story);
  const l = listEpisodes();
  assert.deepEqual(Object.keys(l[0]).sort(), ["createdAt", "id", "title"]);
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
