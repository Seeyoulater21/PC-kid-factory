import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pickPort, isFree, edgePath, profileInUse } from "../src/launcher.mjs";

test("pickPort reuses a running Kid Factory before taking a free port", async () => {
  const ports = [1, 2, 3];
  assert.deepEqual(await pickPort({ ports, ours: async (p) => p === 3, free: async () => true }), { port: 3, reuse: true });
  assert.deepEqual(await pickPort({ ports, ours: async () => false, free: async (p) => p > 1 }), { port: 2, reuse: false });
  assert.equal(await pickPort({ ports, ours: async () => false, free: async () => false }), null);
});

test("isFree is false for a port in use", async (t) => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => s.close());
  assert.equal(await isFree(s.address().port), false);
});

test("edgePath finds msedge.exe in the usual folders, else undefined", () => {
  const env = { "ProgramFiles(x86)": "X86", ProgramFiles: "PF", LOCALAPPDATA: "LA" };
  const want = path.join("PF", "Microsoft", "Edge", "Application", "msedge.exe");
  assert.equal(edgePath(env, (p) => p === want), want);
  assert.equal(edgePath(env, () => false), undefined);
});

test("profileInUse: a locked lockfile means an Edge window is still open", () => {
  const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(profileInUse("p", fail("EBUSY")), true);
  assert.equal(profileInUse("p", fail("EPERM")), true);
  assert.equal(profileInUse("p", fail("ENOENT")), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-prof-"));
  fs.writeFileSync(path.join(dir, "lockfile"), "");
  assert.equal(profileInUse(dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("launcher starts the server on a free port, then reuses it", async (t) => {
  if ((await pickPort())?.reuse) return t.skip("a real Kid Factory is running on this machine");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "kf-launch-"));
  const env = { ...process.env, KIDFACTORY_DATA: data, KIDFACTORY_FAKE: "1", KIDFACTORY_NO_WINDOW: "1" };
  const script = fileURLToPath(new URL("../src/launcher.mjs", import.meta.url));
  const run = () => spawn(process.execPath, [script], { env });
  const first = run();
  t.after(() => { first.kill(); fs.rmSync(data, { recursive: true, force: true }); });
  const url = await readyLine(first);
  assert.match(url, /^READY http:\/\/127\.0\.0\.1:48(4[89]|5\d)\/$/);
  const state = await (await fetch(`${url.slice(6)}api/state`)).json();
  assert.equal(state.fake, true);
  const second = run();
  assert.equal(await readyLine(second), `${url} (reused)`);
});

function readyLine(p) {
  return new Promise((resolve, reject) => {
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.startsWith("READY"));
      if (line) resolve(line.trim());
    });
    p.on("exit", (code) => reject(new Error(`launcher exited ${code}: ${out}`)));
  });
}
