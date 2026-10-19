import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTracks, pickTrack, ensureTrack, markUsed, addTrack } from "../src/music.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-music-"));
  process.env.KIDFACTORY_DATA = dir;
});

const fakeGemini = () => {
  const g = { calls: [], music: async (p) => { g.calls.push(p); return Buffer.from("ID3fake"); } };
  return g;
};
const meta = (id, mood) => ({ id, mood, title: id, source: "lyria", licence: "test", addedAt: "2026-01-01" });

test("seed tracks are installed once", () => {
  const first = listTracks();
  assert.deepEqual(first.map((t) => t.mood).sort(), ["bright", "calm", "playful"]);
  assert.ok(fs.existsSync(path.join(dir, "music", "seed-bright.mp3")));
  markUsed("seed-bright");
  const used = listTracks().find((t) => t.id === "seed-bright").lastUsedAt;
  assert.ok(used);
  assert.equal(listTracks().length, 3);
  assert.equal(listTracks().find((t) => t.id === "seed-bright").lastUsedAt, used); // not overwritten
});

test("pickTrack prefers least recently used", () => {
  addTrack(meta("b-old", "bright"), Buffer.from("a"));
  addTrack(meta("b-new", "bright"), Buffer.from("b"));
  markUsed("seed-bright");
  markUsed("b-old");
  markUsed("b-new");
  assert.equal(pickTrack("bright").id, "seed-bright"); // used first, so oldest
  assert.equal(pickTrack("bright", { exclude: ["seed-bright"] }).id, "b-old");
  assert.equal(pickTrack("nope"), null);
});

test("ensureTrack generates only when the mood is missing", async () => {
  const g = fakeGemini();
  const t = await ensureTrack("calm", g);
  assert.equal(g.calls.length, 0);
  assert.equal(t.mood, "calm");
  for (const t2 of listTracks().filter((x) => x.mood === "calm")) fs.rmSync(path.join(dir, "music", t2.id + ".json"));
  // seeding is once-only, so calm is now missing
  const made = await ensureTrack("calm", g);
  assert.equal(g.calls.length, 1);
  assert.ok(!/cartoon|comedic/i.test(g.calls[0]));
  assert.match(made.id, /^calm-\d+$/);
  assert.equal(made.title, "calm 1");
  assert.ok(fs.existsSync(path.join(dir, "music", made.id + ".mp3")));
  await ensureTrack("calm", g);
  assert.equal(g.calls.length, 1);
});

test("every track has source and licence", () => {
  assert.throws(() => addTrack({ id: "x", mood: "calm", title: "x", addedAt: "t" }, Buffer.from("a")), /source/);
  assert.throws(() => addTrack({ id: "x", mood: "calm", title: "x", source: "cc0", addedAt: "t" }, Buffer.from("a")), /licence/);
  assert.throws(() => addTrack({ ...meta("x", "sad") }, Buffer.from("a")), /mood/);
  for (const t of listTracks()) assert.ok(t.source && t.licence);
});

test("addTrack never overwrites a track that is already there", () => {
  addTrack(meta("b-1", "bright"), Buffer.from("a"));
  assert.throws(() => addTrack(meta("b-1", "bright"), Buffer.from("b")), /exists/);
  assert.equal(fs.readFileSync(path.join(dir, "music", "b-1.mp3"), "utf8"), "a");
});

test("a sidecar with an unsafe id or broken JSON is skipped", () => {
  listTracks();
  fs.writeFileSync(path.join(dir, "music", "bad.json"), JSON.stringify({ ...meta("../x", "calm") }));
  fs.writeFileSync(path.join(dir, "music", "broken.json"), "{");
  const ids = listTracks().map((t) => t.id);
  assert.ok(!ids.includes("../x"));
  assert.equal(ids.length, 3);
});
