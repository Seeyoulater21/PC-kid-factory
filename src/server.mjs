// Local HTTP server: JSON API + media + the plain HTML/JS UI in public/. Binds 127.0.0.1 only.
// Usage: node src/server.mjs [--port N]   (KIDFACTORY_FAKE=1 = offline fake Gemini, no cost)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDir, readConfig, saveKey, hasKey } from "./data.mjs";
import { createGemini, GeminiError } from "./gemini.mjs";
import { createFakeGemini } from "./fake-gemini.mjs";
import { ideas, writeStory, estimateSeconds } from "./story.mjs";
import {
  createEpisode, loadEpisode, saveEpisode, listEpisodes, editNarration, deleteEpisode, episodeStatus,
  saveIdeas, listSavedIdeas, removeSavedIdea,
} from "./episodes.mjs";
import { makeImages, makeVoices, staleVoices, estimateCost, pickTake } from "./pages.mjs";
import { listTracks } from "./music.mjs";
import { chooseMusic } from "./render/video.mjs";
import { buildTimeline, timelineSeconds, TIMING } from "./timeline.mjs";
import { checkUpdate, stageUpdate, startSwap, canSelfUpdate, currentVersion, takeResult } from "./update.mjs";

export const DEFAULT_PORT = 4848;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
};
const MEDIA_DIRS = ["img", "voice", "out"];
const EP_ID = /^ep-\d{8}-\d{6}(-\d+)?$/;
const THAI = /[฀-๿]/;
const MAX_BODY = 1_000_000;
const MAX_NARRATION = 400;

const T = {
  generic: "เกิดข้อผิดพลาด ลองใหม่",
  badData: "ข้อมูลไม่ถูกต้อง ลองใหม่",
  noKey: "ยังไม่ได้ใส่คีย์ Gemini",
  emptyKey: "วางคีย์ Gemini ก่อนนะ",
  emptyTopic: "พิมพ์หัวข้อก่อนนะ",
  badIdea: "เลือกเรื่องก่อนนะ",
  notFound: "ไม่พบตอนนี้",
  busy: "กำลังทำอยู่",
  busyDelete: "กำลังทำอยู่ รอให้เสร็จก่อน",
  waitPages: "รอให้เจนภาพและเสียงเสร็จก่อน",
  badPage: "ไม่มีหน้านี้",
  emptyNarration: "คำเล่าว่างอยู่ พิมพ์ก่อนนะ",
  longNarration: `คำเล่ายาวเกินไป (ไม่เกิน ${MAX_NARRATION} ตัวอักษร)`,
  badMusic: "ไม่พบเพลงนี้ เลือกเพลงใหม่",
  renderFailed: "สร้างวิดีโอไม่สำเร็จ",
  busyUpdate: "กำลังทำงานอยู่ รอให้เสร็จก่อนแล้วค่อยอัปเดต",
  devCopy: "โปรแกรมชุดนี้อัปเดตเองไม่ได้ (ชุดสำหรับพัฒนา)",
  someFailed: (pages, why) => `หน้า ${pages.join(", ")} ทำไม่สำเร็จ: ${why}`,
};

class HttpError extends Error {
  constructor(status, thai) {
    super(thai);
    this.status = status;
    this.thai = thai;
  }
}

/** The Thai text a user may see for an error; never a stack, never raw English. */
function thaiOf(e) {
  if (e instanceof HttpError || (e instanceof GeminiError && e.thai)) return e.thai;
  if (e?.message && THAI.test(e.message)) return e.message;
  return T.generic;
}

// Never let the key leave the server, whatever an error message holds.
function scrub(text) {
  const key = readConfig().key;
  return key ? String(text).split(key).join("") : String(text);
}

function defaultOpenFolder(dir) {
  const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  const p = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
}

/** Renders in a worker thread so the server keeps answering; resolves with the output path. */
export function renderInWorker(ep, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./render/worker.mjs", import.meta.url), { workerData: { ep } });
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    w.on("message", (m) => {
      if (typeof m?.progress === "number") { try { onProgress(m.progress); } catch {} }
      else if (m?.done) settle(resolve, m.done);
      else if (m?.error) {
        if (m.detail) console.error("[render]", m.detail);
        settle(reject, new Error(m.error));
      }
    });
    w.on("error", (e) => {
      console.error("[render] worker crashed:", e?.message);
      settle(reject, new Error(T.renderFailed));
    });
    w.on("exit", () => settle(reject, new Error(T.renderFailed)));
  });
}

const epRoot = (id) => path.join(dataDir(), "episodes", id);

/**
 * opts: gemini (object or () => object; default: fake when KIDFACTORY_FAKE=1, else real with the saved key),
 * openFolder(dir), render(ep, onProgress) → output path (default: worker thread),
 * updater { check, stage, swap, canUpdate, result, exit } (default: update.mjs; exit code 75 = restarting for an update).
 */
export function createServer(opts = {}) {
  const openFolder = opts.openFolder ?? defaultOpenFolder;
  const render = opts.render ?? renderInWorker;
  let fake = null;
  const live = new Map(); // id → the one in-memory episode every job and edit shares
  const jobs = new Map(); // id → {images?, voices?, render?}
  const updater = {
    check: checkUpdate, stage: stageUpdate, swap: startSwap, canUpdate: canSelfUpdate, result: takeResult,
    exit: () => setTimeout(() => process.exit(75), 300),
    ...opts.updater,
  };
  let updating = false;
  let resultShown = false;

  function gemini() {
    if (opts.gemini) return typeof opts.gemini === "function" ? opts.gemini() : opts.gemini;
    if (process.env.KIDFACTORY_FAKE === "1") return (fake ??= createFakeGemini());
    const key = readConfig().key;
    if (!key) throw new HttpError(400, T.noKey);
    return createGemini({ key });
  }

  function getEp(id) {
    if (!EP_ID.test(String(id))) throw new HttpError(404, T.notFound);
    if (!live.has(id)) {
      try {
        live.set(id, loadEpisode(id));
      } catch {
        throw new HttpError(404, T.notFound);
      }
    }
    return live.get(id);
  }

  const jobsOf = (id) => {
    if (!jobs.has(id)) jobs.set(id, {});
    return jobs.get(id);
  };
  const running = (id, kind) => Boolean(jobs.get(id)?.[kind]?.running);

  function view(ep) {
    const pages = ep.story.pages;
    const stale = staleVoices(ep);
    const real = !stale.length && pages.length > 0 && pages.every((p) => Number.isFinite(p.voice?.seconds));
    const book = real ? timelineSeconds(buildTimeline(pages.map((p) => p.voice.seconds))) : estimateSeconds(pages);
    const out = {
      ...ep,
      staleVoices: stale,
      seconds: book + TIMING.intro + TIMING.outro,
      lengthReal: real,
      status: episodeStatus(ep),
      cost: estimateCost(ep),
      suggestedMusicId: chooseMusic(ep)?.id ?? null,
    };
    if (ep.video && !fs.existsSync(path.join(epRoot(ep.id), ep.video.file))) delete out.video;
    return out;
  }

  function checkPages(ep, pages) {
    if (pages === undefined || pages === null) return undefined;
    const n = ep.story.pages.length;
    if (!Array.isArray(pages) || !pages.length || !pages.every((x) => Number.isInteger(x) && x >= 1 && x <= n)) {
      throw new HttpError(400, T.badPage);
    }
    return pages;
  }

  function startPagesJob(kind, ep, pages) {
    if (updating) throw new HttpError(409, T.busy);
    if (running(ep.id, kind)) throw new HttpError(409, T.busy);
    if (running(ep.id, "render")) throw new HttpError(409, T.busy);
    const g = gemini();
    const key = kind === "images" ? "image" : "voice";
    const all = ep.story.pages.map((_, i) => i + 1);
    const stale = new Set(staleVoices(ep));
    const chosen = pages ?? all.filter((n) => (kind === "images" ? ep.story.pages[n - 1].image?.state !== "done" : stale.has(n)));
    const job = { running: true, progress: chosen.length ? 0 : 1, pages: chosen };
    jobsOf(ep.id)[kind] = job;
    const started = new Set();
    const onChange = () => {
      let finished = 0;
      for (const n of chosen) {
        const st = ep.story.pages[n - 1][key]?.state;
        if (st === "working") started.add(n);
        else if (started.has(n)) finished++;
      }
      job.progress = chosen.length ? finished / chosen.length : 1;
    };
    const fn = kind === "images" ? makeImages : makeVoices;
    fn(ep, g, { pages: chosen, onChange })
      .then(() => {
        const failed = chosen.filter((n) => ep.story.pages[n - 1][key]?.state === "error");
        if (failed.length) job.error = scrub(T.someFailed(failed, ep.story.pages[failed[0] - 1][key].error || T.generic));
      })
      .catch((e) => { job.error = scrub(thaiOf(e)); })
      .finally(() => {
        job.running = false;
        job.progress = 1;
      });
  }

  function startRender(ep, musicId) {
    if (updating) throw new HttpError(409, T.busy);
    if (running(ep.id, "render")) throw new HttpError(409, T.busy);
    if (running(ep.id, "images") || running(ep.id, "voices")) throw new HttpError(409, T.waitPages);
    if (musicId !== undefined && musicId !== null && !listTracks().some((t) => t.id === musicId)) {
      throw new HttpError(400, T.badMusic);
    }
    ep.musicId = musicId ?? chooseMusic(ep)?.id ?? null;
    saveEpisode(ep);
    const job = { running: true, progress: 0 };
    jobsOf(ep.id).render = job;
    render(structuredClone(ep), (p) => { job.progress = Math.max(job.progress, Math.min(0.99, p)); })
      .then((file) => {
        const rel = path.relative(epRoot(ep.id), file).split(path.sep).join("/");
        ep.video = { file: rel, at: new Date().toISOString() };
        saveEpisode(ep);
        job.file = rel;
        job.progress = 1;
      })
      .catch((e) => { job.error = scrub(thaiOf(e)); })
      .finally(() => { job.running = false; });
  }

  // ---- routes ----
  const routes = [
    ["GET", /^\/api\/state$/, () => ({
      hasKey: hasKey(), fake: process.env.KIDFACTORY_FAKE === "1", savedIdeas: listSavedIdeas(), episodes: listEpisodes(),
      version: currentVersion(),
      updated: resultShown ? null : ((resultShown = true), updater.result()), // last update's outcome, shown once
    })],
    ["GET", /^\/api\/version$/, () => ({ version: currentVersion(), pid: process.pid })], // health check of the update helper
    ["GET", /^\/api\/update$/, async () => {
      const { current, latest, available, notes } = await updater.check();
      return { current, latest, available, notes, canUpdate: updater.canUpdate() };
    }],
    ["POST", /^\/api\/update$/, async () => {
      if (updating || [...jobs.values()].some((j) => Object.values(j).some((x) => x?.running))) throw new HttpError(409, T.busyUpdate);
      if (!updater.canUpdate()) throw new HttpError(400, T.devCopy);
      updating = true; // from here on no new job may start (startPagesJob / startRender)
      try {
        const r = await updater.check();
        if (!r.available) {
          updating = false;
          return { upToDate: true, current: r.current };
        }
        const staged = await updater.stage(r.manifest);
        updater.swap({ staged, version: r.latest });
        updater.exit();
        return { restarting: true, version: r.latest };
      } catch (e) {
        updating = false;
        throw e;
      }
    }],
    ["POST", /^\/api\/key$/, (m, body) => {
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key || key.length > 500 || /\s/.test(key)) throw new HttpError(400, T.emptyKey);
      saveKey(key);
      return { ok: true };
    }],
    ["POST", /^\/api\/ideas$/, async (m, body) => {
      const topic = typeof body.topic === "string" ? body.topic.trim() : "";
      if (!topic) throw new HttpError(400, T.emptyTopic);
      return { ideas: await ideas(gemini(), topic.slice(0, 300)) };
    }],
    ["POST", /^\/api\/episodes$/, async (m, body) => {
      const idea = cleanIdea(body.idea);
      if (!idea) throw new HttpError(400, T.badIdea);
      const g = gemini();
      const keep = (Array.isArray(body.keep) ? body.keep : []).map(cleanIdea).filter((i) => i && i.title !== idea.title);
      if (keep.length) saveIdeas(keep); // the choice to keep stands even if the story fails
      const story = await writeStory(g, idea);
      const ep = createEpisode(idea, story);
      live.set(ep.id, ep);
      if (listSavedIdeas().some((i) => i.title === idea.title)) removeSavedIdea(idea.title);
      return { id: ep.id };
    }],
    ["GET", /^\/api\/episodes\/([^/]+)$/, (m) => view(getEp(m[1]))],
    ["DELETE", /^\/api\/episodes\/([^/]+)$/, (m) => {
      const ep = getEp(m[1]);
      if (["images", "voices", "render"].some((k) => running(ep.id, k))) throw new HttpError(409, T.busyDelete);
      deleteEpisode(ep.id);
      live.delete(ep.id);
      jobs.delete(ep.id);
      return { ok: true };
    }],
    ["PATCH", /^\/api\/episodes\/([^/]+)\/pages\/(\d+)$/, (m, body) => {
      const ep = getEp(m[1]);
      const n = Number(m[2]);
      if (n < 1 || n > ep.story.pages.length) throw new HttpError(400, T.badPage);
      const text = typeof body.narration === "string" ? body.narration.trim() : "";
      if (!text) throw new HttpError(400, T.emptyNarration);
      if ([...text].length > MAX_NARRATION) throw new HttpError(400, T.longNarration);
      const page = ep.story.pages[n - 1];
      if (page.narration !== text) {
        // edit in place: a running job holds a reference to this page object
        const next = editNarration(ep, n, text).story.pages[n - 1];
        page.narration = next.narration;
        if (page.voice?.state !== "working") page.voice = next.voice;
        saveEpisode(ep);
      }
      return view(ep);
    }],
    ["POST", /^\/api\/episodes\/([^/]+)\/pages\/(\d+)\/pick$/, (m, body) => {
      const ep = getEp(m[1]);
      const kind = body.kind;
      if ((kind !== "image" && kind !== "voice") || !Number.isInteger(body.take)) throw new HttpError(400, T.badData);
      if (running(ep.id, `${kind}s`) || running(ep.id, "render")) throw new HttpError(409, T.busy);
      try {
        pickTake(ep, Number(m[2]), kind, body.take);
      } catch {
        throw new HttpError(400, T.badData);
      }
      saveEpisode(ep);
      return view(ep);
    }],
    ["POST", /^\/api\/episodes\/([^/]+)\/(images|voices)$/, (m, body) => {
      const ep = getEp(m[1]);
      startPagesJob(m[2], ep, checkPages(ep, body.pages));
      return { ok: true };
    }],
    ["POST", /^\/api\/episodes\/([^/]+)\/render$/, (m, body) => {
      startRender(getEp(m[1]), body.musicId);
      return { ok: true };
    }],
    ["GET", /^\/api\/episodes\/([^/]+)\/job$/, (m) => {
      getEp(m[1]);
      return jobs.get(m[1]) ?? {};
    }],
    ["POST", /^\/api\/episodes\/([^/]+)\/open-folder$/, (m) => {
      const ep = getEp(m[1]);
      const dir = path.join(epRoot(ep.id), "out");
      fs.mkdirSync(dir, { recursive: true });
      openFolder(dir);
      return { ok: true };
    }],
    ["GET", /^\/api\/music$/, () => ({ tracks: listTracks().map(({ id, mood, title }) => ({ id, mood, title })) })],
  ];

  async function handle(req, res) {
    const port = server.address()?.port;
    const host = String(req.headers.host || "");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 403, { error: T.generic });

    let pathname;
    try {
      pathname = new URL(req.url, "http://local").pathname;
    } catch {
      return sendJson(res, 404, { error: T.generic });
    }
    const method = req.method;

    if (method === "GET" && STATIC[pathname]) return serveFile(req, res, path.join(PUBLIC_DIR, STATIC[pathname]));
    if (method === "GET" && pathname.startsWith("/media/")) return serveMedia(req, res, pathname);
    if (!pathname.startsWith("/api/")) return sendJson(res, 404, { error: T.generic });

    for (const [verb, re, fn] of routes) {
      const m = pathname.match(re);
      if (!m || verb !== method) continue;
      try {
        let body = {};
        if (method !== "GET" && method !== "DELETE") {
          if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
            return sendJson(res, 415, { error: T.badData });
          }
          body = await readJson(req);
        }
        return sendJson(res, 200, await fn(m, body));
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error("[api]", method, pathname, scrub(e?.message ?? e).slice(0, 300));
        return sendJson(res, status, { error: thaiOf(e) });
      }
    }
    return sendJson(res, 404, { error: T.generic });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[server]", scrub(e?.message ?? e).slice(0, 300));
      if (!res.headersSent) sendJson(res, 500, { error: T.generic });
      else res.destroy();
    });
  });
  return server;
}

function cleanIdea(i) {
  const title = typeof i?.title === "string" ? i.title.trim() : "";
  const pitch = typeof i?.pitch === "string" ? i.pitch.trim() : "";
  return title && pitch ? { title: title.slice(0, 200), pitch: pitch.slice(0, 1000) } : null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(400, T.badData));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, T.badData));
      }
    });
    req.on("error", () => reject(new HttpError(400, T.badData)));
  });
}

function sendJson(res, status, obj) {
  const body = scrub(JSON.stringify(obj)); // job and page errors included: the key never leaves
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function serveMedia(req, res, pathname) {
  const notFound = () => sendJson(res, 404, { error: T.generic });
  const parts = pathname.slice("/media/".length).split("/");
  const id = parts.shift();
  if (!EP_ID.test(id || "") || !parts.length) return notFound();
  let rel;
  try {
    rel = parts.map((p) => decodeURIComponent(p)).join("/");
  } catch {
    return notFound();
  }
  if (rel.includes("\0")) return notFound();
  const root = epRoot(id);
  const full = path.resolve(root, rel);
  const inside = path.relative(root, full).split(path.sep);
  if (inside.length < 2 || !MEDIA_DIRS.includes(inside[0]) || inside.includes("..") || path.isAbsolute(inside.join(path.sep))) {
    return notFound();
  }
  if (!TYPES[path.extname(full).toLowerCase()] || /\.(html|js|css)$/i.test(full)) return notFound();
  try {
    const real = fs.realpathSync(full);
    const realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep)) return notFound();
  } catch {
    return notFound();
  }
  return serveFile(req, res, full);
}

function serveFile(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    return sendJson(res, 404, { error: T.generic });
  }
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
  const size = stat.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || "").trim());
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["content-length"] = size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === "HEAD" || !size) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

// ---- command line ----
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Bad --port value");
    process.exit(2);
  }
  const server = createServer();
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is busy` : `Server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const mode = process.env.KIDFACTORY_FAKE === "1" ? " (fake Gemini, offline)" : "";
    console.log(`Kid Factory: http://127.0.0.1:${server.address().port}${mode}`);
  });
}
