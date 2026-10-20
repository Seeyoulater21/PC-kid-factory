// ChatGPT through Codex: `codex app-server` as a child process, JSON-RPC over stdio, one fresh thread per job.
// Text (ideas, story, packaging) uses a JSON output schema; pictures use Codex's image generation tool.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dataDir } from "./data.mjs";

export const TURN_TIMEOUT_MS = 6 * 60 * 1000;

// The app's own copy of the Codex app server (downloaded once from the official GitHub release).
export const CODEX_VERSION = "0.163.0";
const RELEASE = `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}`;
export const CODEX_BUILDS = {
  "win32-x64": {
    file: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
    sha256: "d4da4ba8024b0cf9caedcb428a34cf2904f6bb1b41137a5f04f551e6d0699f54",
    exe: "codex-app-server-x86_64-pc-windows-msvc.exe",
  },
  "darwin-arm64": {
    file: "codex-app-server-aarch64-apple-darwin.tar.gz",
    sha256: "8165de84cc8e436d46d5e52fe6b68de053ba729c543e6310a1bd41e881cf4c37",
    exe: "codex-app-server-aarch64-apple-darwin",
  },
};

const THAI = {
  login: "ยังไม่ได้เชื่อมต่อ ChatGPT ไปที่ ตั้งค่า แล้วกด เชื่อมต่อ ChatGPT",
  limit: "ChatGPT ใช้ครบโควตาของช่วงนี้แล้ว ลองใหม่ภายหลัง หรือกด ใช้ Gemini แทน",
  missing: "ยังไม่ได้ติดตั้ง ChatGPT ไปที่ ตั้งค่า แล้วกด เชื่อมต่อ ChatGPT",
  slow: "ChatGPT ตอบช้าเกินไป ลองใหม่อีกครั้ง",
  crash: "ChatGPT หยุดทำงานกลางคัน ลองใหม่อีกครั้ง",
  failed: "ChatGPT ทำงานนี้ไม่สำเร็จ ลองใหม่อีกครั้ง",
  empty: "ChatGPT ไม่ส่งผลลัพธ์กลับมา ลองใหม่",
};

export class CodexError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "CodexError";
    this.code = code;
    this.thai = THAI[code] ?? THAI.failed;
    Object.assign(this, extra);
  }
}

/** "HH:MM" Thai-friendly time for a limit reset, or null. */
export const resetTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const platformKey = () => `${process.platform}-${process.arch}`;
const ownDir = () => path.join(dataDir(), "codex", CODEX_VERSION);
const ownExe = () => {
  const b = CODEX_BUILDS[platformKey()];
  return b ? path.join(ownDir(), b.exe) : null;
};

/** The command that starts the app server, or null when Codex still has to be installed. */
export function codexCommand({ env = process.env, exists = fs.existsSync, onPath = codexOnPath } = {}) {
  if (env.KIDFACTORY_CODEX) return [env.KIDFACTORY_CODEX, "app-server"];
  const own = ownExe();
  if (own && exists(own)) return [own];
  if (process.platform !== "win32" && onPath()) return ["codex", "app-server"];
  return null;
}

function codexOnPath() {
  try {
    return spawnSync("codex", ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Downloads and unpacks the app's own Codex app server. onProgress(0..1). */
export async function installCodex({ fetch = globalThis.fetch, onProgress = () => {} } = {}) {
  const b = CODEX_BUILDS[platformKey()];
  if (!b) throw new CodexError("missing", `no Codex build for ${platformKey()}`);
  const dir = ownDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, b.file);
  let res;
  try {
    res = await fetch(`${RELEASE}/${b.file}`);
  } catch (e) {
    throw Object.assign(new CodexError("failed", `download failed: ${e?.message}`), { thai: "ต่ออินเทอร์เน็ตไม่ได้ ลองใหม่" });
  }
  if (!res.ok || !res.body) throw Object.assign(new CodexError("failed", `download HTTP ${res.status}`), { thai: "ดาวน์โหลด ChatGPT ไม่สำเร็จ ลองใหม่" });
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(archive);
  let got = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    if (total) onProgress(Math.min(0.99, got / total));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (hash.digest("hex") !== b.sha256) {
    fs.rmSync(archive, { force: true });
    throw Object.assign(new CodexError("failed", "checksum mismatch"), { thai: "ไฟล์ ChatGPT ที่ดาวน์โหลดเสียหาย ลองใหม่" });
  }
  // tar ships with macOS and with Windows 10 and later
  const r = spawnSync("tar", ["-xzf", archive, "-C", dir], { stdio: "ignore", timeout: 120_000 });
  fs.rmSync(archive, { force: true });
  if (r.status !== 0 || !fs.existsSync(ownExe())) throw Object.assign(new CodexError("failed", "unpack failed"), { thai: "แตกไฟล์ ChatGPT ไม่สำเร็จ ลองใหม่" });
  if (process.platform !== "win32") fs.chmodSync(ownExe(), 0o755);
  onProgress(1);
  return ownExe();
}

// ---- prompts around a picture ----

/** A reference is { path, label }; the label tells the image model what that attachment is for. */
export function imageText(prompt, refs = [], { edit = false } = {}) {
  const named = refs.length
    ? ["Attachments in order:", ...refs.map((r, i) => `${i + 1}. ${r.label}`)]
    : [];
  return [
    "Generate exactly one image with the image generation tool, using the prompt below verbatim.",
    "Do not run any commands and do not edit any files.",
    ...named,
    ...(refs.length ? [
      "Each character sheet belongs to exactly one character: never mix faces or clothing between sheets, and keep each character's clothing exactly as on their sheet.",
      "Do NOT copy any reference image's framing, camera angle or composition; those come only from the prompt.",
    ] : []),
    ...(edit ? ["The LAST attachment is the picture to edit, not a reference. Keep everything in it that the prompt does not change."] : []),
    "Landscape 16:9 picture. Keep faces and important objects away from the top and bottom edges.",
    "After the image, reply with one short line.",
    "",
    "PROMPT:",
    prompt,
  ].join("\n");
}

/** The retake turn: the model rewrites the last prompt from the user's Thai feedback, then draws. */
export function reviseText({ context, lastPrompt, feedback, refs = [] }) {
  return [
    "The user looked at the LAST attached picture and asks for a change.",
    "Do not run any commands and do not edit any files.",
    ...(refs.length ? ["Attachments in order:", ...refs.map((r, i) => `${i + 1}. ${r.label}`), `${refs.length + 1}. the picture to change`] : []),
    "",
    "What this picture is for (Thai):",
    context || "(none)",
    "",
    "Last prompt:",
    lastPrompt,
    "",
    "User feedback (Thai):",
    feedback,
    "",
    "Keep the style and every character's look. Change only what the feedback asks and keep the rest of the picture.",
    "The feedback is often a complaint about what is WRONG (e.g. \"มือพัง\" = the hands are badly drawn: draw correct hands with five fingers; \"แมวหายไป\" = the cat is missing: add the cat).",
    "Read it literally, including every negation (ไม่, ไม่ได้, ห้าม, อย่า), and move the picture AWAY from what the user complains about, never toward it.",
    'Your first line must be "PROMPT: <the full revised prompt on one line>", then generate exactly one image with that prompt.',
    "Landscape 16:9 picture.",
  ].join("\n");
}

export function parsePrompt(texts) {
  for (const t of texts) {
    for (const line of String(t).split("\n")) {
      const m = line.match(/^\s*PROMPT:\s*(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

const crash = (message) => new CodexError("crash", message);

export class CodexBridge {
  /** command: argv that starts the app server (default: codexCommand()); spawnFn for tests. */
  constructor({ command, cwd = dataDir(), timeoutMs = TURN_TIMEOUT_MS, env = process.env, spawnFn = spawn } = {}) {
    Object.assign(this, { command, cwd, timeoutMs, env, spawnFn });
    this.proc = null;
    this.starting = null;
    this.model = null;
    this.chain = Promise.resolve(); // one turn at a time: ChatGPT limits work best in a single line
  }

  start() {
    if (this.proc) return Promise.resolve();
    this.starting ??= this.boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  async boot() {
    const argv = this.command ?? codexCommand();
    if (!argv) throw new CodexError("missing", "Codex is not installed");
    const [cmd, ...args] = argv;
    // unread stderr would fill its pipe and freeze Codex
    const proc = this.spawnFn(cmd, args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.proc = proc;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    proc.on("error", (e) => this.onExit(proc, `cannot start Codex: ${e.message}`));
    proc.on("exit", (code) => this.onExit(proc, `Codex stopped (exit ${code})`));
    proc.stdin.on("error", () => {});
    createInterface({ input: proc.stdout }).on("line", (line) => { if (this.proc === proc) this.onLine(line); });
    await this.request("initialize", { clientInfo: { name: "kid-factory", version: "1.0.0" } });
    this.notify("initialized", {});
    const r = await this.request("model/list", {});
    const list = r?.data ?? [];
    this.model = (list.find((m) => m.isDefault) ?? list[0])?.model ?? null;
  }

  onExit(proc, message) {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const { reject } of this.pending.values()) reject(crash(message));
    this.pending.clear();
    for (const f of this.listeners) f({ method: "__exit__", params: { message } });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CodexError("failed", msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // the server asks for approval (commands, file changes): never granted here
    if (msg.id !== undefined && msg.method) return this.write({ id: msg.id, result: { decision: "decline" } });
    for (const f of this.listeners) f(msg);
  }

  write(obj) {
    this.proc?.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(crash("Codex is not running"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  /** { signedIn, email, plan } */
  async account() {
    await this.start();
    const r = await this.request("account/read", {});
    const a = r?.account;
    return a?.type === "chatgpt" ? { signedIn: true, email: a.email ?? null, plan: a.planType ?? null } : { signedIn: false };
  }

  /** Starts the ChatGPT sign-in; returns the URL to open in the browser. */
  async login() {
    await this.start();
    const r = await this.request("account/login/start", { type: "chatgpt" });
    return r.authUrl;
  }

  async retryAt() {
    try {
      const r = await this.request("account/rateLimits/read", {});
      const w = [r?.rateLimits?.primary, r?.rateLimits?.secondary].filter((x) => x?.resetsAt).sort((a, b) => b.usedPercent - a.usedPercent)[0];
      return w ? new Date(w.resetsAt * 1000).toISOString() : null;
    } catch {
      return null;
    }
  }

  /** Runs one turn in a fresh thread, after any turn already running. */
  run(input, turnParams = {}) {
    const job = this.chain.then(async () => {
      await this.start();
      const th = await this.request("thread/start", {
        cwd: this.cwd, sandbox: "read-only", approvalPolicy: "never", model: this.model, ephemeral: true,
      });
      return this.turn(th.thread.id, input, turnParams);
    });
    this.chain = job.catch(() => {});
    return job;
  }

  /** JSON that matches schema. */
  async json(prompt, schema) {
    const r = await this.run([{ type: "text", text: prompt }], { outputSchema: schema });
    const text = r.texts.at(-1);
    if (!text) throw new CodexError("empty", "no reply");
    try {
      return JSON.parse(text);
    } catch {
      throw new CodexError("empty", "reply was not JSON");
    }
  }

  /**
   * One picture. refs: [{ path, label }]. With feedback (and editTarget = the last picture), the model first rewrites
   * lastPrompt from the feedback. Resolves { file, prompt }: file is Codex's saved picture, prompt the one drawn.
   */
  async image({ prompt, refs = [], editTarget = null, feedback = null, context = "" }) {
    const text = feedback
      ? reviseText({ context, lastPrompt: prompt, feedback, refs })
      : imageText(prompt, refs, { edit: Boolean(editTarget) });
    const input = [{ type: "text", text }, ...refs.map((r) => ({ type: "localImage", path: r.path }))];
    if (editTarget) input.push({ type: "localImage", path: editTarget });
    const r = await this.run(input, { effort: "low" });
    const img = r.images.at(-1);
    if (!img) throw new CodexError("empty", `no image: ${String(r.texts.at(-1) ?? "").slice(0, 200)}`);
    return { file: img.savedPath, prompt: (feedback && parsePrompt(r.texts)) || prompt };
  }

  turn(threadId, input, turnParams) {
    return new Promise((resolve, reject) => {
      const images = [];
      const texts = [];
      let settled = false;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(on);
        if (err) reject(err); else resolve(value);
      };
      const on = (m) => {
        const p = m.params ?? {};
        if (m.method === "__exit__") return done(crash(p.message));
        if (p.threadId !== threadId) return;
        if (m.method === "item/completed" && p.item?.type === "imageGeneration" && p.item.savedPath) images.push(p.item);
        if (m.method === "item/completed" && p.item?.type === "agentMessage") texts.push(p.item.text ?? "");
        if (m.method === "turn/completed") this.finish(p.turn, images, texts).then((v) => done(null, v), (e) => done(e));
      };
      this.listeners.add(on);
      const timer = setTimeout(() => {
        done(new CodexError("slow", "turn timed out"));
        this.stop(); // a stuck app server gets a fresh process on the next call
      }, this.timeoutMs);
      this.request("turn/start", { threadId, input, ...turnParams }).catch((e) => done(e));
    });
  }

  async finish(turn, images, texts) {
    if (turn?.status === "failed") {
      const info = turn.error?.codexErrorInfo;
      if (info === "usageLimitExceeded") throw new CodexError("limit", "usage limit", { retryAt: await this.retryAt() });
      if (info === "unauthorized") throw new CodexError("login", "not signed in");
      throw new CodexError("failed", turn.error?.message ?? "turn failed");
    }
    if (turn?.status === "interrupted") throw new CodexError("crash", "turn interrupted");
    return { images, texts };
  }

  stop() {
    const p = this.proc;
    if (p) this.onExit(p, "Codex was stopped");
    p?.kill();
  }
}
