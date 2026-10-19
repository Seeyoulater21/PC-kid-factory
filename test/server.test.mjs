import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../src/server.mjs";
import { GeminiError } from "../src/gemini.mjs";
import { IDEAS_SCHEMA } from "../src/prompts.mjs";
import { writeWav } from "../src/audio.mjs";
import { createEpisode, loadEpisode, saveEpisode } from "../src/episodes.mjs";
import { listTracks } from "../src/music.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("../docs/sample-story.json", import.meta.url), "utf8"));
const KEY = "test-key-SECRET-123456";
const wav = () => writeWav({ rate: 24000, channels: 1, samples: new Int16Array(24000) });

function fakeGemini({ slow = 0, fail } = {}) {
  const wait = () => new Promise((r) => setTimeout(r, slow));
  return {
    async json(model, prompt, schema) {
      if (fail) throw fail;
      return schema === IDEAS_SCHEMA ? { ideas: sample.ideas } : structuredClone(sample.story);
    },
    async image() { await wait(); return Buffer.from("jpg"); },
    async speech() { await wait(); return wav(); },
  };
}

async function start(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kf-srv-"));
  process.env.KIDFACTORY_DATA = root;
  const server = createServer({ gemini: fakeGemini(), openFolder: () => {}, ...opts, updater: { result: () => null, ...opts.updater } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  return { root, base, api, server };
}

// raw request: fetch() would normalise "../" away before sending
const raw = (base, rawPath) =>
  new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: rawPath }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });

const waitJob = async (api, id, kind) => {
  for (let i = 0; i < 400; i++) {
    const { json } = await api("GET", `/api/episodes/${id}/job`);
    if (json[kind] && !json[kind].running) return json[kind];
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job never finished");
};

test("state never contains the key", async (t) => {
  const { api, root } = await start(t);
  assert.equal((await api("GET", "/api/state")).json.hasKey, false);
  assert.equal((await api("POST", "/api/key", { key: KEY })).status, 200);
  const s = await api("GET", "/api/state");
  assert.equal(s.json.hasKey, true);
  assert.deepEqual(s.json.savedIdeas, []);
  assert.deepEqual(s.json.episodes, []);
  assert.ok(!s.text.includes(KEY));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).key, KEY);
});

test("empty key is refused in Thai", async (t) => {
  const { api } = await start(t);
  const r = await api("POST", "/api/key", { key: "  " });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /[฀-๿]/);
});

test("ideas error returns Thai message (and never the key)", async (t) => {
  const fail = new GeminiError("credit", `HTTP 429 ${KEY}`, "เครดิต Gemini หมด เติมเงินที่ Google AI Studio");
  const { api } = await start(t, { gemini: fakeGemini({ fail }) });
  const r = await api("POST", "/api/ideas", { topic: "กินผัก" });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: "เครดิต Gemini หมด เติมเงินที่ Google AI Studio" });
  assert.ok(!r.text.includes(KEY));
});

test("non-Gemini errors become a generic Thai message, no stack", async (t) => {
  const { api } = await start(t, { gemini: fakeGemini({ fail: new Error(`boom ${KEY}`) }) });
  const r = await api("POST", "/api/ideas", { topic: "กินผัก" });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /[฀-๿]/);
  assert.ok(!r.text.includes("boom") && !r.text.includes(KEY) && !r.text.includes("at "));
});

test("ideas: empty topic is a Thai 400; good topic returns 3 ideas", async (t) => {
  const { api } = await start(t);
  const bad = await api("POST", "/api/ideas", { topic: " " });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /[฀-๿]/);
  const ok = await api("POST", "/api/ideas", { topic: "กินผัก" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ideas.length, 3);
});

test("no key and no injected gemini: Thai error asking for the key", async (t) => {
  const { api } = await start(t, { gemini: undefined });
  const r = await api("POST", "/api/ideas", { topic: "กินผัก" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /คีย์/);
});

test("create episode writes the story, keeps ideas, removes a started saved idea", async (t) => {
  const { api } = await start(t);
  const [a, b, c] = sample.ideas;
  const r = await api("POST", "/api/episodes", { idea: a, keep: [b, c] });
  assert.equal(r.status, 200);
  const s = await api("GET", "/api/state");
  assert.deepEqual(s.json.savedIdeas.map((i) => i.title), [b.title, c.title]);
  assert.equal(s.json.episodes[0].id, r.json.id);
  // starting a saved idea takes it off the list
  await api("POST", "/api/episodes", { idea: b, keep: [] });
  assert.deepEqual((await api("GET", "/api/state")).json.savedIdeas.map((i) => i.title), [c.title]);
});

test("episode view: length estimate, stale voices, cost; bad id is 404", async (t) => {
  const { api } = await start(t);
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  const ep = (await api("GET", `/api/episodes/${id}`)).json;
  assert.equal(ep.id, id);
  assert.equal(ep.lengthReal, false);
  assert.ok(ep.seconds > 10);
  assert.equal(ep.staleVoices.length, ep.story.pages.length);
  assert.ok(ep.cost.thb > 0);
  assert.equal((await api("GET", "/api/episodes/ep-bad")).status, 404);
  assert.equal((await api("GET", "/api/episodes/..%2F..%2Fx")).status, 404);
});

test("PATCH narration saves and marks the voice stale", async (t) => {
  const { api } = await start(t);
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/voices`, {});
  await waitJob(api, id, "voices");
  assert.deepEqual((await api("GET", `/api/episodes/${id}`)).json.staleVoices, []);
  const r = await api("PATCH", `/api/episodes/${id}/pages/2`, { narration: "ปิ่นโตยิ้ม" });
  assert.equal(r.status, 200);
  const ep = (await api("GET", `/api/episodes/${id}`)).json;
  assert.equal(ep.story.pages[1].narration, "ปิ่นโตยิ้ม");
  assert.deepEqual(ep.staleVoices, [2]);
  assert.equal(loadEpisode(id).story.pages[1].narration, "ปิ่นโตยิ้ม");
  assert.equal((await api("PATCH", `/api/episodes/${id}/pages/99`, { narration: "x" })).status, 400);
  assert.equal((await api("PATCH", `/api/episodes/${id}/pages/1`, { narration: "" })).status, 400);
});

test("real length once all voices are done: timeline + 20 s", async (t) => {
  const { api } = await start(t);
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/voices`, {});
  await waitJob(api, id, "voices");
  const ep = (await api("GET", `/api/episodes/${id}`)).json;
  const n = ep.story.pages.length;
  assert.equal(ep.lengthReal, true);
  // each 1 s voice: 0.4 lead + 1 + 1.0 tail; 1.5 s turns between pages; 5 s intro + 15 s outro
  assert.ok(Math.abs(ep.seconds - (n * 2.4 + (n - 1) * 1.5 + 20)) < 0.01);
});

test("second images job returns 409; job reports progress and finishes", async (t) => {
  const { api } = await start(t, { gemini: fakeGemini({ slow: 40 }) });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  assert.equal((await api("POST", `/api/episodes/${id}/images`, {})).status, 200);
  const again = await api("POST", `/api/episodes/${id}/images`, { pages: [1] });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "กำลังทำอยู่");
  // a different kind may run at the same time
  assert.equal((await api("POST", `/api/episodes/${id}/voices`, {})).status, 200);
  const job = await waitJob(api, id, "images");
  assert.equal(job.progress, 1);
  await waitJob(api, id, "voices");
  const ep = (await api("GET", `/api/episodes/${id}`)).json;
  assert.ok(ep.story.pages.every((p) => p.image.state === "done" && p.voice.state === "done"));
  // both jobs edited the same episode: neither overwrote the other on disk
  const disk = loadEpisode(id);
  assert.ok(disk.story.pages.every((p) => p.image.state === "done" && p.voice.state === "done"));
});

test("pick a take: switches the page's image, refused while that kind is running, bad take is 400", async (t) => {
  const { api } = await start(t, { gemini: fakeGemini({ slow: 40 }) });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  for (let i = 0; i < 2; i++) {
    await api("POST", `/api/episodes/${id}/images`, { pages: [1] });
    await waitJob(api, id, "images");
  }
  const r = await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "image", take: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.story.pages[0].image.file, "img/p01.jpg");
  assert.equal(r.json.story.pages[0].imageTakes.length, 2);
  assert.equal(loadEpisode(id).story.pages[0].image.file, "img/p01.jpg");
  assert.equal((await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "image", take: 3 })).status, 400);
  assert.equal((await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "x", take: 1 })).status, 400);
  for (const take of ["1", 1.5, null]) {
    assert.equal((await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "image", take })).status, 400);
  }
  await api("POST", `/api/episodes/${id}/images`, { pages: [2] });
  assert.equal((await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "image", take: 2 })).status, 409);
  await waitJob(api, id, "images");
});

test("pick a voice take: the page gets back that take's text; refused while rendering", async (t) => {
  let finish;
  const render = (ep) => new Promise((r) => { finish = () => r(path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, "out", "x.mp4")); });
  const { api } = await start(t, { render });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/voices`, { pages: [1] });
  await waitJob(api, id, "voices");
  const first = (await api("GET", `/api/episodes/${id}`)).json.story.pages[0].narration;
  await api("PATCH", `/api/episodes/${id}/pages/1`, { narration: "ปิ่นโตยิ้ม" });
  await api("POST", `/api/episodes/${id}/voices`, { pages: [1] });
  await waitJob(api, id, "voices");
  const r = await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "voice", take: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.story.pages[0].narration, first);
  assert.equal(r.json.story.pages[0].voice.file, "voice/p01.wav");
  assert.ok(!r.json.staleVoices.includes(1));
  assert.equal((await api("POST", `/api/episodes/${id}/render`, {})).status, 200);
  assert.equal((await api("POST", `/api/episodes/${id}/pages/1/pick`, { kind: "voice", take: 2 })).status, 409);
  finish();
  await waitJob(api, id, "render");
});

test("music route plays a library track for listening; unknown or unsafe ids are 404", async (t) => {
  const { api, base } = await start(t);
  const id = (await api("GET", "/api/music")).json.tracks[0].id;
  const r = await fetch(`${base}/music/${id}.mp3`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal((await fetch(`${base}/music/nope.mp3`)).status, 404);
  assert.equal(await raw(base, "/music/..%2Fconfig.json"), 404);
});

test("media route serves episode files with ranges and blocks ../ traversal", async (t) => {
  const { api, base, root } = await start(t);
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/voices`, { pages: [1] });
  await waitJob(api, id, "voices");
  fs.writeFileSync(path.join(root, "secret.txt"), "nope");
  const full = await fetch(`${base}/media/${id}/voice/p01.wav`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "audio/wav");
  const size = Number(full.headers.get("content-length"));
  await full.arrayBuffer();
  const part = await fetch(`${base}/media/${id}/voice/p01.wav`, { headers: { range: "bytes=0-9" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-9/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal(await raw(base, `/media/${id}/../../secret.txt`), 404);
  assert.equal(await raw(base, `/media/${id}/voice/..%2F..%2F..%2Fsecret.txt`), 404);
  assert.equal(await raw(base, `/media/${id}/episode.json`), 404);
  assert.equal(await raw(base, `/media/../secret.txt`), 404);
  assert.equal(await raw(base, `/media/${id}/voice/p99.wav`), 404);
});

test("render saves the chosen music on the episode and runs the renderer", async (t) => {
  let seen = null;
  const render = async (ep, onProgress) => {
    seen = ep;
    onProgress(0.5);
    return path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, "out", "เรื่อง.mp4");
  };
  const { api } = await start(t, { render });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  const tracks = (await api("GET", "/api/music")).json.tracks;
  assert.ok(tracks.length >= 3);
  assert.equal((await api("POST", `/api/episodes/${id}/render`, { musicId: "no-such" })).status, 400);
  assert.equal((await api("POST", `/api/episodes/${id}/render`, {})).status, 200);
  const job = await waitJob(api, id, "render");
  assert.equal(job.progress, 1);
  assert.equal(job.error, undefined);
  const mood = sample.story.mood;
  assert.equal(seen.musicId, listTracks().find((x) => x.mood === mood).id);
  const ep = loadEpisode(id);
  assert.equal(ep.musicId, seen.musicId);
  assert.equal(ep.video.file, "out/เรื่อง.mp4");
  // an explicit pick wins and is remembered
  const other = tracks.find((x) => x.mood !== mood).id;
  await api("POST", `/api/episodes/${id}/render`, { musicId: other });
  await waitJob(api, id, "render");
  assert.equal(loadEpisode(id).musicId, other);
});

test("real render worker reports the Thai reason when pages are not ready", async (t) => {
  const { api } = await start(t, { render: undefined });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/render`, {});
  const job = await waitJob(api, id, "render");
  assert.match(job.error, /^เสียงหน้า 1, 2/);
  assert.ok(!/at |Error/.test(job.error));
  // the server stays responsive afterwards
  assert.equal((await api("GET", "/api/state")).status, 200);
});

test("open-folder reveals the episode out/ folder", async (t) => {
  const opened = [];
  const { api, root } = await start(t, { openFolder: (d) => opened.push(d) });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  assert.equal((await api("POST", `/api/episodes/${id}/open-folder`, {})).status, 200);
  assert.deepEqual(opened, [path.join(root, "episodes", id, "out")]);
});

test("serves the UI; unknown routes are 404; foreign Host is refused", async (t) => {
  const { base, api } = await start(t);
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /<html/);
  assert.equal((await fetch(base + "/app.js")).status, 200);
  assert.equal((await api("GET", "/api/nope")).status, 404);
  assert.equal(await raw(base, "/../package.json"), 404);
  const u = new URL(base);
  const status = await new Promise((resolve) => {
    http.get({ host: u.hostname, port: u.port, path: "/api/state", headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(status, 403);
});

test("POST without a JSON content type is refused", async (t) => {
  const { base } = await start(t);
  const r = await fetch(base + "/api/key", { method: "POST", body: JSON.stringify({ key: KEY }), headers: { "content-type": "text/plain" } });
  assert.equal(r.status, 415);
});

test("a working state left on disk is shown as todo after a restart", async (t) => {
  const { api } = await start(t);
  const ep = createEpisode(sample.idea, sample.story);
  ep.story.pages[0].image = { state: "working" };
  saveEpisode(ep);
  const got = (await api("GET", `/api/episodes/${ep.id}`)).json;
  assert.equal(got.story.pages[0].image.state, "todo");
});

test("delete removes the episode folder; refused while a job runs", async (t) => {
  const { api, root } = await start(t, { gemini: fakeGemini({ slow: 40 }) });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  const list = (await api("GET", "/api/state")).json.episodes;
  assert.equal(list[0].number, 1);
  assert.equal(list[0].status, "เขียนเรื่องแล้ว");
  await api("POST", `/api/episodes/${id}/images`, {});
  const busy = await api("DELETE", `/api/episodes/${id}`);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error, "กำลังทำอยู่ รอให้เสร็จก่อน");
  await waitJob(api, id, "images");
  assert.equal((await api("DELETE", `/api/episodes/${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(root, "episodes", id)));
  assert.equal((await api("GET", `/api/episodes/${id}`)).status, 404);
  assert.deepEqual((await api("GET", "/api/state")).json.episodes, []);
  assert.equal((await api("DELETE", "/api/episodes/..")).status, 404);
  assert.equal((await api("DELETE", `/api/episodes/${id}`)).status, 404);
});

test("narration edited while its voice records: the old audio stays stale", async (t) => {
  const { api } = await start(t, { gemini: fakeGemini({ slow: 300 }) });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/voices`, { pages: [1] });
  await new Promise((r) => setTimeout(r, 50)); // page 1 is now recording
  assert.equal((await api("PATCH", `/api/episodes/${id}/pages/1`, { narration: "ปิ่นโตยิ้มกว้าง" })).status, 200);
  await waitJob(api, id, "voices");
  const ep = (await api("GET", `/api/episodes/${id}`)).json;
  assert.equal(ep.story.pages[0].voice.state, "done");
  assert.ok(ep.staleVoices.includes(1));
});

test("job and page errors never carry the key", async (t) => {
  const g = fakeGemini();
  g.image = async () => { throw new GeminiError("refused", "x", `ภาพไม่ได้ ${KEY}`); };
  const { api } = await start(t, { gemini: g });
  await api("POST", "/api/key", { key: KEY });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/images`, { pages: [1] });
  const job = await waitJob(api, id, "images");
  assert.match(job.error, /ไม่ยอมวาดหน้านี้/);
  const jobText = (await api("GET", `/api/episodes/${id}/job`)).text;
  const epText = (await api("GET", `/api/episodes/${id}`)).text;
  assert.ok(!jobText.includes(KEY) && !epText.includes(KEY));
});

// ---- self-update ----
function fakeUpdater(over = {}) {
  const calls = [];
  return {
    calls,
    check: async () => ({ current: "0.2.0", latest: "0.3.0", available: true, notes: ["ใหม่"], manifest: { version: "0.3.0" } }),
    stage: async (m) => { calls.push(["stage", m.version]); return "/staged"; },
    swap: (j) => calls.push(["swap", j.staged, j.version]),
    canUpdate: () => true,
    exit: () => calls.push(["exit"]),
    ...over,
  };
}

test("state carries the app version and the last update's outcome once", async (t) => {
  const { api } = await start(t, { updater: { result: () => ({ ok: true, from: "0.1.0", to: "0.2.0" }) } });
  const first = (await api("GET", "/api/state")).json;
  assert.match(first.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(first.updated, { ok: true, from: "0.1.0", to: "0.2.0" });
  assert.equal((await api("GET", "/api/state")).json.updated, null);
  assert.equal((await api("GET", "/api/version")).json.version, first.version);
});

test("GET /api/update reports a newer version without the manifest", async (t) => {
  const { api } = await start(t, { updater: fakeUpdater() });
  const { json } = await api("GET", "/api/update");
  assert.deepEqual(json, { current: "0.2.0", latest: "0.3.0", available: true, notes: ["ใหม่"], canUpdate: true });
});

test("POST /api/update stages, hands over to the swap helper and exits", async (t) => {
  const u = fakeUpdater();
  const { api } = await start(t, { updater: u });
  const r = await api("POST", "/api/update", {});
  assert.deepEqual(r.json, { restarting: true, version: "0.3.0" });
  assert.deepEqual(u.calls, [["stage", "0.3.0"], ["swap", "/staged", "0.3.0"], ["exit"]]);
  assert.equal((await api("POST", "/api/update", {})).status, 409); // already updating
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  assert.equal((await api("POST", `/api/episodes/${id}/voices`, {})).status, 409); // no new jobs while updating
  assert.equal((await api("POST", `/api/episodes/${id}/render`, {})).status, 409);
});

test("POST /api/update refuses while a job runs, and on a copy that cannot update itself", async (t) => {
  const u = fakeUpdater();
  const { api } = await start(t, { gemini: fakeGemini({ slow: 200 }), updater: u });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/voices`, {});
  const busy = await api("POST", "/api/update", {});
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error, "กำลังทำงานอยู่ รอให้เสร็จก่อนแล้วค่อยอัปเดต");
  await waitJob(api, id, "voices");
  assert.deepEqual(u.calls, []);

  const { api: api2 } = await start(t, { updater: fakeUpdater({ canUpdate: () => false }) });
  assert.equal((await api2("POST", "/api/update", {})).status, 400);
});

test("POST /api/update when already up to date does nothing", async (t) => {
  const u = fakeUpdater({ check: async () => ({ current: "0.3.0", latest: "0.3.0", available: false, notes: [] }) });
  const { api } = await start(t, { updater: u });
  assert.deepEqual((await api("POST", "/api/update", {})).json, { upToDate: true, current: "0.3.0" });
  assert.deepEqual(u.calls, []);
});

test("look: saved per episode, remembered for the next episode, bad look is 400, sent to the renderer", async (t) => {
  let seen = null;
  const render = async (ep) => {
    seen = ep;
    return path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, "out", "x.mp4");
  };
  const { api } = await start(t, { render });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  assert.equal((await api("GET", `/api/episodes/${id}`)).json.look, "wood");
  assert.equal((await api("PATCH", `/api/episodes/${id}/look`, { look: "space" })).status, 400);
  const r = await api("PATCH", `/api/episodes/${id}/look`, { look: "full" });
  assert.equal(r.status, 200);
  assert.equal(r.json.look, "full");
  assert.equal(loadEpisode(id).look, "full");
  // the next episode starts with the last look used
  const { json: { id: id2 } } = await api("POST", "/api/episodes", { idea: sample.ideas[1], keep: [] });
  assert.equal((await api("GET", `/api/episodes/${id2}`)).json.look, "full");
  await api("PATCH", `/api/episodes/${id2}/look`, { look: "mint" });
  await api("POST", `/api/episodes/${id}/render`, {});
  await waitJob(api, id, "render");
  assert.equal(seen.look, "full");
  assert.equal(loadEpisode(id).video.look, "full");
});

test("look cannot change while the video renders", async (t) => {
  let release;
  const render = (ep) => new Promise((r) => {
    release = () => r(path.join(process.env.KIDFACTORY_DATA, "episodes", ep.id, "out", "x.mp4"));
  });
  const { api } = await start(t, { render });
  const { json: { id } } = await api("POST", "/api/episodes", { idea: sample.idea, keep: [] });
  await api("POST", `/api/episodes/${id}/render`, {});
  assert.equal((await api("PATCH", `/api/episodes/${id}/look`, { look: "pink" })).status, 409);
  release();
  await waitJob(api, id, "render");
  assert.equal(loadEpisode(id).look, undefined);
  assert.equal((await api("PATCH", `/api/episodes/${id}/look`, { look: "pink" })).status, 200);
});
