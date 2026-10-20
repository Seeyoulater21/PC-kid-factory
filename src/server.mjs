// Local HTTP server: JSON API + media + the plain HTML/JS UI in public/. Binds 127.0.0.1 only.
// Usage: node src/server.mjs [--port N]   (KIDFACTORY_FAKE=1 = offline fake AI, no cost, no ChatGPT)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataDir, readConfig, saveKey, saveConfig, hasKey } from "./data.mjs";
import { createGemini, GeminiError } from "./gemini.mjs";
import { createFakeGemini } from "./fake-gemini.mjs";
import { CodexBridge, CodexError, codexCommand, installCodex } from "./codex.mjs";
import { createAi, errorText, stopsJob, PROVIDERS } from "./ai.mjs";
import { ideas, writeStory, estimateSeconds } from "./story.mjs";
import {
  library, findSheet, addSheet, addNewSheets, pickSheetTake, lockSheet, makeSheet, sheetDir, KINDS,
} from "./sheets.mjs";
import { makePackageText, makeCover, pickCover, composeCover, cleanHashtags, PARTS } from "./package.mjs";
import {
  createEpisode, loadEpisode, saveEpisode, listEpisodes, editNarration, deleteEpisode, episodeStatus,
  saveIdeas, listSavedIdeas, removeSavedIdea,
} from "./episodes.mjs";
import { makeImages, makeVoices, staleVoices, estimateCost, pickTake } from "./pages.mjs";
import { listTracks, trackFile } from "./music.mjs";
import { chooseMusic } from "./render/video.mjs";
import { LOOKS, DEFAULT_LOOK } from "./render/book.mjs";
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
  busySheets: "กำลังวาดแผ่นตัวละครและสถานที่อยู่ รอให้เสร็จก่อน",
  busyPictures: "กำลังวาดภาพของตอนอยู่ รอให้เสร็จก่อน",
  badSheet: "ไม่พบแผ่นนี้",
  lockedSheet: "แผ่นนี้ล็อกอยู่ กดปลดล็อกก่อน",
  needSheetText: "ใส่ชื่อและคำอธิบายก่อนนะ",
  noCover: "ยังไม่มีภาพปก กดทำแพ็กเกจก่อน",
  needTitle: "ชื่อตอนว่างอยู่ พิมพ์ก่อนนะ",
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
  if (e instanceof CodexError) return errorText(e);
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

/** Opens a web page in the default browser (where the user is usually signed in to ChatGPT). */
function defaultOpenUrl(url) {
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
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
 * codex (a CodexBridge-like object; default: one real bridge), provider (default "chatgpt"; "gemini" when only a
 * gemini is passed, as in tests), installCodex(onProgress), openUrl(url),
 * openFolder(dir), render(ep, onProgress) → output path (default: worker thread),
 * updater { check, stage, swap, canUpdate, result, exit } (default: update.mjs; exit code 75 = restarting for an update).
 */
export function createServer(opts = {}) {
  const openFolder = opts.openFolder ?? defaultOpenFolder;
  const openUrl = opts.openUrl ?? defaultOpenUrl;
  const render = opts.render ?? renderInWorker;
  const install = opts.installCodex ?? ((onProgress) => installCodex({ onProgress }));
  let fake = null;
  let bridge = null;
  const codex = () => opts.codex ?? (bridge ??= new CodexBridge());
  let sheetJob = {};   // the library's one drawing job: { running, tag, progress, error, limit }
  let installJob = {}; // downloading Codex: { running, progress, error }
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

  const isFake = () => !opts.gemini && process.env.KIDFACTORY_FAKE === "1";

  /** The AI for one job: ChatGPT by default, Gemini when the user asked for it (or in fake mode, the offline fake). */
  function ai(provider) {
    if (isFake()) return createAi({ provider: "gemini", gemini: gemini });
    const p = PROVIDERS.includes(provider) ? provider : opts.provider ?? (opts.gemini && !opts.codex ? "gemini" : "chatgpt");
    return createAi({ provider: p, codex, gemini });
  }

  /** Error fields for a job: Thai text, and limit: true when "use Gemini instead" helps. */
  const jobError = (e) => ({ error: scrub(thaiOf(e)), ...(e instanceof CodexError && e.code === "limit" ? { limit: true } : {}) });
  const picturesRunning = () => [...jobs.values()].some((j) => j.images?.running || j.package?.running);

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
      look: LOOKS.includes(ep.look) ? ep.look : DEFAULT_LOOK,
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

  function startPagesJob(kind, ep, pages, { feedback = null, provider } = {}) {
    if (updating) throw new HttpError(409, T.busy);
    if (running(ep.id, kind)) throw new HttpError(409, T.busy);
    if (running(ep.id, "render")) throw new HttpError(409, T.busy);
    if (kind === "images" && sheetJob.running) throw new HttpError(409, T.busySheets);
    // one picture job at a time across all episodes: ChatGPT draws one by one, and two jobs could draw the same new sheet
    if (kind === "images" && picturesRunning()) throw new HttpError(409, T.busyPictures);
    const g = kind === "images" ? ai(provider) : ai("gemini");
    if (kind === "voices") gemini(); // voices need the Gemini key: say so now, not per page
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
    const onSheets = () => {
      const s = library().find((x) => x.state === "working");
      job.sheet = s ? s.name : null;
    };
    const run = kind === "images"
      ? makeImages(ep, g, { pages: chosen, feedback, onChange, onSheets })
      : makeVoices(ep, g, { pages: chosen, onChange });
    run
      .then(() => {
        const failed = chosen.filter((n) => ep.story.pages[n - 1][key]?.state === "error");
        if (failed.length) job.error = scrub(T.someFailed(failed, ep.story.pages[failed[0] - 1][key].error || T.generic));
      })
      .catch((e) => { Object.assign(job, jobError(e)); job.sheet = null; })
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
    const look = ep.look ?? DEFAULT_LOOK; // the status compares it with the episode's look later
    const job = { running: true, progress: 0 };
    jobsOf(ep.id).render = job;
    render(structuredClone(ep), (p) => { job.progress = Math.max(job.progress, Math.min(0.99, p)); })
      .then((file) => {
        const rel = path.relative(epRoot(ep.id), file).split(path.sep).join("/");
        ep.video = { file: rel, at: new Date().toISOString(), look };
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
      if (updating || sheetJob.running || installJob.running || [...jobs.values()].some((j) => Object.values(j).some((x) => x?.running))) {
        throw new HttpError(409, T.busyUpdate);
      }
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
      return { ideas: await ideas(ai(body.provider), topic.slice(0, 300)) };
    }],
    ["POST", /^\/api\/episodes$/, async (m, body) => {
      const idea = cleanIdea(body.idea);
      if (!idea) throw new HttpError(400, T.badIdea);
      const g = ai(body.provider);
      const keep = (Array.isArray(body.keep) ? body.keep : []).map(cleanIdea).filter((i) => i && i.title !== idea.title);
      if (keep.length) saveIdeas(keep); // the choice to keep stands even if the story fails
      const story = await writeStory(g, idea, { library: library() });
      const ep = createEpisode(idea, story);
      addNewSheets(story.newSheets); // new characters and places join the library now; their pictures come with the page pictures
      const last = readConfig().lastLook;
      if (LOOKS.includes(last)) {
        ep.look = last;
        saveEpisode(ep);
      }
      live.set(ep.id, ep);
      if (listSavedIdeas().some((i) => i.title === idea.title)) removeSavedIdea(idea.title);
      return { id: ep.id };
    }],
    ["GET", /^\/api\/episodes\/([^/]+)$/, (m) => view(getEp(m[1]))],
    ["DELETE", /^\/api\/episodes\/([^/]+)$/, (m) => {
      const ep = getEp(m[1]);
      if (["images", "voices", "render", "package"].some((k) => running(ep.id, k))) throw new HttpError(409, T.busyDelete);
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
    ["PATCH", /^\/api\/episodes\/([^/]+)\/look$/, (m, body) => {
      const ep = getEp(m[1]);
      if (!LOOKS.includes(body.look)) throw new HttpError(400, T.badData);
      if (running(ep.id, "render")) throw new HttpError(409, T.busy);
      if (body.look !== ep.look) {
        ep.look = body.look;
        saveEpisode(ep);
      }
      saveConfig({ lastLook: body.look });
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
      const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 500) : "";
      startPagesJob(m[2], ep, checkPages(ep, body.pages), { feedback: feedback || null, provider: body.provider });
      return { ok: true };
    }],
    ["POST", /^\/api\/episodes\/([^/]+)\/package$/, (m, body) => {
      const ep = getEp(m[1]);
      const part = body.part === "cover" ? "cover" : PARTS.includes(body.part) ? body.part : "all";
      const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 500) : "";
      startPackage(ep, part, { feedback: feedback || null, provider: body.provider });
      return { ok: true };
    }],
    ["PATCH", /^\/api\/episodes\/([^/]+)\/package$/, async (m, body) => {
      const ep = getEp(m[1]);
      if (running(ep.id, "package")) throw new HttpError(409, T.busy);
      const pkg = (ep.package ??= { title: "", description: "", hashtags: [], coverScene: "", coverTakes: [], coverArt: null, cover: null });
      const was = pkg.title;
      if (typeof body.title === "string") {
        if (!body.title.trim()) throw new HttpError(400, T.needTitle);
        pkg.title = Array.from(body.title.trim()).slice(0, 100).join("");
      }
      if (typeof body.description === "string") pkg.description = body.description.trim().slice(0, 5000);
      if (body.hashtags !== undefined) pkg.hashtags = cleanHashtags(body.hashtags);
      if (pkg.title !== was && pkg.coverArt) await composeCover(ep); // the title is written on the cover
      saveEpisode(ep);
      return view(ep);
    }],
    ["POST", /^\/api\/episodes\/([^/]+)\/package\/pick$/, async (m, body) => {
      const ep = getEp(m[1]);
      if (running(ep.id, "package")) throw new HttpError(409, T.busy);
      if (!Number.isInteger(body.take)) throw new HttpError(400, T.badData);
      try {
        await pickCover(ep, body.take);
      } catch {
        throw new HttpError(400, T.badData);
      }
      saveEpisode(ep);
      return view(ep);
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

    // ---- ChatGPT (Codex) ----
    ["GET", /^\/api\/chatgpt$/, async () => {
      if (isFake()) return { installed: true, signedIn: true, fake: true };
      if (installJob.running || installJob.error) return { installed: false, install: installJob };
      if (!opts.codex && !codexCommand()) return { installed: false, install: installJob };
      try {
        return { installed: true, ...(await codex().account()) };
      } catch (e) {
        return { installed: true, signedIn: false, error: thaiOf(e) };
      }
    }],
    ["POST", /^\/api\/chatgpt\/install$/, () => {
      if (installJob.running) throw new HttpError(409, T.busy);
      installJob = { running: true, progress: 0 };
      const job = installJob;
      install((p) => { job.progress = p; })
        .then(() => { job.progress = 1; installJob = {}; })
        .catch((e) => { job.error = thaiOf(e); })
        .finally(() => { job.running = false; });
      return { ok: true };
    }],
    ["POST", /^\/api\/chatgpt\/login$/, async () => {
      const url = await codex().login();
      if (!/^https:\/\//.test(String(url))) throw new HttpError(500, T.generic);
      openUrl(url);
      return { url };
    }],

    // ---- sheet library ----
    ["GET", /^\/api\/sheets$/, () => {
      const numbers = new Map(listEpisodes().map((e) => [e.id, e.number]));
      return {
        sheets: library().map((s) => ({ ...s, usedBy: s.usedBy.filter((id) => numbers.has(id)).map((id) => numbers.get(id) ?? 0) })),
        job: sheetJob,
      };
    }],
    ["POST", /^\/api\/sheets$/, (m, body) => {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 1000) : "";
      if (!KINDS.includes(body.kind)) throw new HttpError(400, T.badData);
      if (!name || !description) throw new HttpError(400, T.needSheetText);
      try {
        return { tag: addSheet({ kind: body.kind, name, description, tag: body.tag }).tag };
      } catch {
        throw new HttpError(400, T.badData);
      }
    }],
    ["POST", /^\/api\/sheets\/make-missing$/, (m, body) => {
      startSheets(library().filter((s) => !s.chosen).map((s) => s.tag), { provider: body.provider });
      return { ok: true };
    }],
    ["POST", /^\/api\/sheets\/([a-z0-9-]+)\/make$/, (m, body) => {
      const s = findSheet(m[1]);
      if (!s) throw new HttpError(404, T.badSheet);
      if (s.locked) throw new HttpError(409, T.lockedSheet);
      const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 500) : "";
      startSheets([s.tag], { feedback: feedback || null, provider: body.provider });
      return { ok: true };
    }],
    ["POST", /^\/api\/sheets\/([a-z0-9-]+)\/pick$/, (m, body) => {
      const s = findSheet(m[1]);
      if (!s) throw new HttpError(404, T.badSheet);
      if (s.locked) throw new HttpError(409, T.lockedSheet);
      if (sheetJob.running || picturesRunning()) throw new HttpError(409, T.busy);
      try {
        pickSheetTake(s.tag, body.take);
      } catch {
        throw new HttpError(400, T.badData);
      }
      return { ok: true };
    }],
    ["POST", /^\/api\/sheets\/([a-z0-9-]+)\/lock$/, (m, body) => {
      if (!findSheet(m[1])) throw new HttpError(404, T.badSheet);
      try {
        lockSheet(m[1], body.locked === true);
      } catch {
        throw new HttpError(400, T.badData);
      }
      return { ok: true };
    }],
  ];

  /** Draws library sheets one by one (feedback only for a single sheet). A ChatGPT limit stops the rest. */
  function startSheets(tags, { feedback = null, provider } = {}) {
    if (updating) throw new HttpError(409, T.busy);
    if (sheetJob.running) throw new HttpError(409, T.busySheets);
    if (picturesRunning()) throw new HttpError(409, T.busyPictures);
    const g = ai(provider);
    const job = { running: true, progress: tags.length ? 0 : 1, tags, tag: null };
    sheetJob = job;
    (async () => {
      const failed = [];
      for (const [i, tag] of tags.entries()) {
        job.tag = tag;
        try {
          await makeSheet(tag, g, { feedback });
        } catch (e) {
          if (stopsJob(e)) throw e;
          failed.push(findSheet(tag)?.name ?? tag);
        }
        job.progress = (i + 1) / tags.length;
      }
      if (failed.length) job.error = `${failed.join(", ")} ทำไม่สำเร็จ ลองใหม่อีกครั้ง`;
    })()
      .catch((e) => Object.assign(job, jobError(e)))
      .finally(() => { job.running = false; job.tag = null; });
  }

  function startPackage(ep, part, { feedback = null, provider } = {}) {
    if (updating) throw new HttpError(409, T.busy);
    if (running(ep.id, "package")) throw new HttpError(409, T.busy);
    if (picturesRunning()) throw new HttpError(409, T.busyPictures);
    if (sheetJob.running) throw new HttpError(409, T.busySheets);
    if (part === "cover" && feedback && !ep.package?.coverArt) throw new HttpError(400, T.noCover);
    const g = ai(provider);
    const job = { running: true, part };
    jobsOf(ep.id).package = job;
    (async () => {
      if (part !== "cover") await makePackageText(ep, g, { part });
      if (part === "title" && ep.package.coverArt) await composeCover(ep); // the title is written on the cover
      saveEpisode(ep);
      if (part === "all" || part === "cover") await makeCover(ep, g, { feedback: part === "cover" ? feedback : null });
      saveEpisode(ep);
    })()
      .catch((e) => {
        Object.assign(job, jobError(e));
        try { saveEpisode(ep); } catch { /* the text that was made stays in memory */ }
      })
      .finally(() => { job.running = false; });
  }

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
    if (method === "GET" && pathname.startsWith("/sheets/")) {
      const m = /^\/sheets\/([a-z0-9-]+\.jpg)$/.exec(pathname);
      return m ? serveFile(req, res, path.join(sheetDir(), m[1])) : sendJson(res, 404, { error: T.generic });
    }
    if (method === "GET" && pathname.startsWith("/music/")) {
      const m = /^\/music\/([A-Za-z0-9_-]+)\.mp3$/.exec(pathname);
      const file = m && trackFile(m[1]);
      return file ? serveFile(req, res, file) : sendJson(res, 404, { error: T.generic });
    }
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
        const status = e instanceof HttpError ? e.status : e instanceof CodexError ? 503 : 500;
        if (status === 500) console.error("[api]", method, pathname, scrub(e?.message ?? e).slice(0, 300));
        return sendJson(res, status, { error: thaiOf(e), ...(e instanceof CodexError && e.code === "limit" ? { limit: true } : {}) });
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
    const mode = process.env.KIDFACTORY_FAKE === "1" ? " (fake AI, offline)" : "";
    console.log(`Kid Factory: http://127.0.0.1:${server.address().port}${mode}`);
  });
}
