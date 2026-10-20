import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexBridge, CodexError, codexCommand, imageText, reviseText, parsePrompt, resetTime } from "../src/codex.mjs";
import { createAi, errorText } from "../src/ai.mjs";
import { jpeg } from "./helpers.mjs";

process.env.KIDFACTORY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "kf-codex-"));

/**
 * A fake `codex app-server`: answers JSON-RPC lines. turn(params, emit) decides what a turn sends back
 * (emit(method, params) for notifications); requests and declined approvals are recorded.
 */
function fakeProcess({ turn, account = { type: "chatgpt", email: "a@b.c", planType: "plus" } } = {}) {
  const sent = [];
  const replies = [];
  const spawnFn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.kill = () => proc.emit("exit", null);
    proc.argv = [cmd, ...args];
    const out = (obj) => proc.stdout.write(JSON.stringify(obj) + "\n");
    let buf = "";
    proc.stdin.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.method) sent.push(msg); else replies.push(msg);
        if (msg.id === undefined || !msg.method) continue;
        const ok = (result) => out({ id: msg.id, result });
        if (msg.method === "initialize") ok({});
        else if (msg.method === "model/list") ok({ data: [{ model: "m-1" }, { model: "m-2", isDefault: true }] });
        else if (msg.method === "account/read") ok({ account });
        else if (msg.method === "account/login/start") ok({ type: "chatgpt", authUrl: "https://auth/x", loginId: "l" });
        else if (msg.method === "account/rateLimits/read") ok({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1792478343 }, secondary: { usedPercent: 50, resetsAt: 1792891400 } } });
        else if (msg.method === "thread/start") ok({ thread: { id: `th-${sent.length}` } });
        else if (msg.method === "turn/start") {
          ok({ turn: { id: "tu-1" } });
          const threadId = msg.params.threadId;
          setImmediate(() => turn(msg.params, (method, params) => out({ method, params: { threadId, ...params } }), out));
        }
      }
    });
    return proc;
  };
  return { spawnFn, sent, replies };
}

const done = (emit, status = "completed", error) => emit("turn/completed", { turn: { status, ...(error ? { error } : {}) } });

test("json: a fresh read-only thread, the schema as outputSchema, the reply parsed", async () => {
  const f = fakeProcess({ turn: (p, emit) => { emit("item/completed", { item: { type: "agentMessage", text: '{"ideas":[1]}' } }); done(emit); } });
  const b = new CodexBridge({ command: ["codex", "app-server"], spawnFn: f.spawnFn });
  const schema = { type: "object" };
  assert.deepEqual(await b.json("hello", schema), { ideas: [1] });
  const th = f.sent.find((m) => m.method === "thread/start").params;
  assert.equal(th.sandbox, "read-only");
  assert.equal(th.approvalPolicy, "never");
  assert.equal(th.model, "m-2", "the account's default model");
  assert.equal(th.ephemeral, true);
  const turn = f.sent.find((m) => m.method === "turn/start").params;
  assert.deepEqual(turn.outputSchema, schema);
  assert.equal(turn.input[0].text, "hello");
  b.stop();
});

test("image: labelled attachments in order, the saved picture returned; a retake returns the revised prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-img-"));
  const saved = path.join(dir, "out.png");
  fs.writeFileSync(saved, jpeg());
  const f = fakeProcess({
    turn: (p, emit) => {
      emit("item/completed", { item: { type: "agentMessage", text: "PROMPT: a girl with correct hands" } });
      emit("item/completed", { item: { type: "imageGeneration", savedPath: saved } });
      done(emit);
    },
  });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  const refs = [{ path: "/style.jpg", label: "house style" }, { path: "/pinto.jpg", label: "character sheet of Pinto" }];
  const r = await b.image({ prompt: "draw a girl", refs });
  assert.equal(r.file, saved);
  assert.equal(r.prompt, "draw a girl");
  const input = f.sent.filter((m) => m.method === "turn/start")[0].params.input;
  assert.match(input[0].text, /^Generate exactly one image/);
  assert.match(input[0].text, /1\. house style\n2\. character sheet of Pinto/);
  assert.match(input[0].text, /PROMPT:\ndraw a girl$/);
  assert.deepEqual(input.slice(1), [{ type: "localImage", path: "/style.jpg" }, { type: "localImage", path: "/pinto.jpg" }]);
  const r2 = await b.image({ prompt: "draw a girl", refs, editTarget: "/last.jpg", feedback: "มือพัง", context: "page 3" });
  assert.equal(r2.prompt, "a girl with correct hands");
  const input2 = f.sent.filter((m) => m.method === "turn/start")[1].params.input;
  assert.match(input2[0].text, /User feedback \(Thai\):\nมือพัง/);
  assert.match(input2[0].text, /3\. the picture to change/);
  assert.deepEqual(input2.at(-1), { type: "localImage", path: "/last.jpg" });
  b.stop();
});

test("plan limit, sign-in and no picture become CodexErrors with Thai text", async () => {
  let mode = "limit";
  const f = fakeProcess({
    turn: (p, emit) => {
      if (mode === "limit") return done(emit, "failed", { codexErrorInfo: "usageLimitExceeded", message: "x" });
      if (mode === "login") return done(emit, "failed", { codexErrorInfo: "unauthorized" });
      emit("item/completed", { item: { type: "agentMessage", text: "I can't draw that" } });
      done(emit);
    },
  });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  await assert.rejects(b.image({ prompt: "p" }), (e) => {
    assert.ok(e instanceof CodexError);
    assert.equal(e.code, "limit");
    assert.equal(e.retryAt, new Date(1792478343 * 1000).toISOString(), "the fullest window's reset time");
    assert.match(errorText(e), new RegExp(`ประมาณ ${resetTime(e.retryAt)} น\\.`));
    return true;
  });
  mode = "login";
  await assert.rejects(b.image({ prompt: "p" }), (e) => e.code === "login" && /เชื่อมต่อ ChatGPT/.test(e.thai));
  mode = "none";
  await assert.rejects(b.image({ prompt: "p" }), (e) => e.code === "empty");
  b.stop();
});

test("turns run one at a time; an approval request is declined; a crash rejects the turn", async () => {
  let active = 0, max = 0;
  const f = fakeProcess({
    turn: (p, emit, out) => {
      active++;
      max = Math.max(max, active);
      out({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
      setTimeout(() => { active--; emit("item/completed", { item: { type: "agentMessage", text: "{}" } }); done(emit); }, 10);
    },
  });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  await Promise.all([b.json("a", {}), b.json("b", {}), b.json("c", {})]);
  assert.equal(max, 1);
  assert.ok(f.replies.some((r) => r.id === 99 && r.result.decision === "decline"));
  const crash = fakeProcess({ turn: () => {} });
  const c = new CodexBridge({ command: ["x"], spawnFn: crash.spawnFn });
  const p = c.json("a", {});
  await new Promise((r) => setTimeout(r, 20));
  c.proc.emit("exit", 1);
  await assert.rejects(p, (e) => e.code === "crash");
  b.stop();
});

test("pictures run side by side (text jobs still one at a time)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-par-"));
  const saved = path.join(dir, "out.png");
  fs.writeFileSync(saved, jpeg());
  let active = 0, max = 0;
  const f = fakeProcess({
    turn: (p, emit) => {
      active++;
      max = Math.max(max, active);
      setTimeout(() => { active--; emit("item/completed", { item: { type: "imageGeneration", savedPath: saved } }); done(emit); }, 60);
    },
  });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  assert.equal((await Promise.all([1, 2, 3, 4, 5].map((i) => b.image({ prompt: `p${i}` })))).length, 5);
  assert.equal(max, 5, "five pictures at once");
  b.stop();
});

test("a turn that never ends times out and restarts Codex next time", async () => {
  const f = fakeProcess({ turn: () => {} });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn, timeoutMs: 30 });
  await assert.rejects(b.json("a", {}), (e) => e.code === "slow");
  assert.equal(b.proc, null);
});

test("account and sign-in", async () => {
  const f = fakeProcess({ turn: () => {} });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  assert.deepEqual(await b.account(), { signedIn: true, email: "a@b.c", plan: "plus" });
  assert.equal(await b.login(), "https://auth/x");
  assert.deepEqual(f.sent.find((m) => m.method === "account/login/start").params, { type: "chatgpt" });
  b.stop();
  const none = fakeProcess({ turn: () => {}, account: null });
  const c = new CodexBridge({ command: ["x"], spawnFn: none.spawnFn });
  assert.deepEqual(await c.account(), { signedIn: false });
  c.stop();
});

test("which Codex runs, and a Thai 'not installed' error when there is none", async () => {
  assert.equal(codexCommand({ env: {}, exists: () => false, onPath: () => false }), null);
  assert.deepEqual(codexCommand({ env: { KIDFACTORY_CODEX: "/x/codex" } }), ["/x/codex", "app-server"]);
  if (["win32-x64", "darwin-arm64"].includes(`${process.platform}-${process.arch}`)) {
    assert.equal(codexCommand({ env: {}, exists: (p) => !p.includes("code-mode-host"), onPath: () => false }), null, "an install without the code mode host is incomplete");
    assert.match(codexCommand({ env: {}, exists: () => true, onPath: () => false })[0], /codex-app-server/);
  }
  if (process.platform !== "win32") assert.deepEqual(codexCommand({ env: {}, exists: () => false, onPath: () => true }), ["codex", "app-server"]);
  const c = new CodexBridge({ spawnFn: () => { throw new Error("must not spawn"); } });
  c.boot = async () => { throw new CodexError("missing", "x"); };
  await assert.rejects(c.json("a", {}), (e) => e.code === "missing" && /ติดตั้ง ChatGPT/.test(e.thai));
});

test("Codex runs in the app's own Codex home, never the user's ~/.codex (its plugins, tools and MCP servers)", async () => {
  const f = fakeProcess({ turn: () => {} });
  let opts = null;
  const b = new CodexBridge({ command: ["x"], env: { PATH: "/bin", CODEX_HOME: "/user/.codex" }, spawnFn: (c, a, o) => { opts = o; return f.spawnFn(c, a); } });
  await b.account();
  const home = path.join(process.env.KIDFACTORY_DATA, "codex", "home");
  assert.equal(opts.env.CODEX_HOME, home);
  assert.equal(opts.env.PATH, "/bin", "the rest of the environment is kept");
  const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  for (const off of ["shell_tool", "unified_exec", "computer_use", "plugins", "apps"]) {
    assert.match(config, new RegExp(`^${off} = false$`, "m"), off);
  }
  assert.doesNotMatch(config, /mcp_servers/);
  assert.doesNotMatch(config, /code_mode_host/, "pictures are drawn through exec, which runs in the code mode host");
  b.stop();
});

test("prompt helpers", () => {
  assert.match(imageText("p", [], { edit: true }), /LAST attachment is the picture to edit/);
  const r = reviseText({ context: "c", lastPrompt: "lp", feedback: "แมวหายไป" });
  assert.match(r, /negation \(ไม่, ไม่ได้, ห้าม, อย่า\)/);
  assert.match(r, /AWAY from what the user complains about/);
  assert.match(r, /"PROMPT: <the full revised prompt on one line>"/);
  assert.equal(parsePrompt(["hi", "x\nPROMPT: new one\nmore"]), "new one");
  assert.equal(parsePrompt(["nothing"]), null);
});

test("createAi with ChatGPT turns Codex's picture into a 1920x1080 JPEG", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-ai-"));
  const file = path.join(dir, "a.jpg");
  fs.writeFileSync(file, jpeg());
  const ai = createAi({ provider: "chatgpt", codex: { image: async () => ({ file, prompt: "p" }) } });
  const r = await ai.image({ prompt: "p" });
  assert.equal(r.prompt, "p");
  const { loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(r.bytes);
  assert.equal(img.width, 1920);
  assert.equal(img.height, 1080);
});

test("the picture tool's own plan limit (no saved picture) is a limit with its reset time; a base64 result is used", async () => {
  let mode = "limit";
  const f = fakeProcess({
    turn: (p, emit) => {
      if (mode === "limit") emit("item/completed", { item: { type: "imageGeneration", savedPath: null, failure: { type: "usageLimitExceeded", limitId: "x", resetsAt: 1792478343 } } });
      else emit("item/completed", { item: { type: "imageGeneration", savedPath: null, result: jpeg().toString("base64") } });
      done(emit);
    },
  });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  await assert.rejects(b.image({ prompt: "p" }), (e) => e.code === "limit" && e.retryAt === new Date(1792478343 * 1000).toISOString());
  mode = "result";
  const r = await b.image({ prompt: "p" });
  assert.ok(Buffer.isBuffer(r.bytes) && r.bytes.length > 0);
  b.stop();
});

test("callers during start-up wait until Codex is initialized; a failed start is not reused", async () => {
  const f = fakeProcess({ turn: () => {} });
  const b = new CodexBridge({ command: ["x"], spawnFn: f.spawnFn });
  const [a1, a2] = await Promise.all([b.account(), b.account()]);
  assert.equal(a1.signedIn && a2.signedIn, true);
  const order = f.sent.map((m) => m.method);
  assert.ok(order.indexOf("account/read") > order.indexOf("model/list"), order.join(","));
  assert.equal(order.filter((m) => m === "initialize").length, 1);
  b.stop();
  let spawned = 0;
  const bad = new CodexBridge({
    command: ["x"],
    spawnFn: (...a) => {
      spawned++;
      const proc = f.spawnFn(...a);
      if (spawned === 1) { proc.stdin.write = () => true; setTimeout(() => proc.emit("exit", 1), 5); } // never answers, then dies
      return proc;
    },
  });
  await assert.rejects(bad.account(), (e) => e.code === "crash");
  assert.deepEqual(await bad.account(), { signedIn: true, email: "a@b.c", plan: "plus" });
  assert.equal(spawned, 2);
  bad.stop();
});
