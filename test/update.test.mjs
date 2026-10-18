import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { newer, checkUpdate, stageUpdate, platformKey, relaunchCommand, takeResult } from "../src/update.mjs";
import { swap } from "../src/update-swap.mjs";

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kf-upd-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const URL_ = "https://example.test/releases/latest/download/update.json";

// A fake fetch serving { name: Buffer | object } relative to the manifest URL.
function server(files) {
  const seen = [];
  const fetchFn = async (url) => {
    const name = String(url).split("/").pop();
    seen.push(name);
    if (!(name in files)) return new Response("no", { status: 404 });
    const v = files[name];
    return new Response(Buffer.isBuffer(v) ? v : JSON.stringify(v), { status: 200 });
  };
  return { fetchFn, seen };
}

function makePackage(t, version) {
  const d = tmp(t);
  const app = path.join(d, "app");
  fs.mkdirSync(path.join(app, "src"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(app, "src", "x.mjs"), "export default 1;\n");
  const file = path.join(d, "pkg.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", app, "."]);
  const buf = fs.readFileSync(file);
  return { buf, entry: { file: `KidFactory-${version}-${platformKey()}.tar.gz`, size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") } };
}

test("newer compares x.y.z numerically", () => {
  assert.equal(newer("0.2.0", "0.1.9"), true);
  assert.equal(newer("0.10.0", "0.9.3"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false);
  assert.equal(newer("0.1.0", "0.2.0"), false);
});

test("checkUpdate reads the manifest and says whether it is newer", async (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  const { fetchFn } = server({ "update.json": { version: "0.3.0", notes: ["แก้เสียงหาย", 5], packages: {} } });
  const r = await checkUpdate({ fetchFn, url: URL_, root });
  assert.equal(r.current, "0.2.0");
  assert.equal(r.latest, "0.3.0");
  assert.equal(r.available, true);
  assert.deepEqual(r.notes, ["แก้เสียงหาย"]);
});

test("checkUpdate offline → Thai message", async (t) => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  const fetchFn = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(checkUpdate({ fetchFn, url: URL_, root }), { message: "ตรวจหาอัปเดตไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่" });
});

test("stageUpdate downloads, verifies and unpacks this platform's package", async (t) => {
  const dir = tmp(t);
  const { buf, entry } = makePackage(t, "0.3.0");
  const manifest = { version: "0.3.0", packages: { [platformKey()]: entry, "other-os": { file: "nope.tar.gz", size: 1, sha256: "0" } } };
  const { fetchFn, seen } = server({ [entry.file]: buf });
  const staged = await stageUpdate(manifest, { fetchFn, url: URL_, dir });
  assert.deepEqual(seen, [entry.file]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, "package.json"), "utf8")).version, "0.3.0");
  assert.ok(fs.existsSync(path.join(staged, "src", "x.mjs")));
  assert.ok(!fs.existsSync(path.join(dir, "package.tar.gz")));
});

test("stageUpdate refuses a package whose checksum or size does not match", async (t) => {
  const { buf, entry } = makePackage(t, "0.3.0");
  const bad = Buffer.from(buf);
  bad[bad.length - 1] ^= 1;
  const manifest = { version: "0.3.0", packages: { [platformKey()]: entry } };
  await assert.rejects(stageUpdate(manifest, { fetchFn: server({ [entry.file]: bad }).fetchFn, url: URL_, dir: tmp(t) }), { message: "ไฟล์อัปเดตเสียหาย ลองใหม่" });
  const short = { version: "0.3.0", packages: { [platformKey()]: { ...entry, size: entry.size + 1 } } };
  await assert.rejects(stageUpdate(short, { fetchFn: server({ [entry.file]: buf }).fetchFn, url: URL_, dir: tmp(t) }), { message: "ไฟล์อัปเดตเสียหาย ลองใหม่" });
});

test("stageUpdate refuses a package that holds another version, or none for this platform", async (t) => {
  const { buf, entry } = makePackage(t, "0.2.5");
  const manifest = { version: "0.3.0", packages: { [platformKey()]: entry } };
  await assert.rejects(stageUpdate(manifest, { fetchFn: server({ [entry.file]: buf }).fetchFn, url: URL_, dir: tmp(t) }), { message: "ไฟล์อัปเดตเสียหาย ลองใหม่" });
  await assert.rejects(stageUpdate({ version: "0.3.0", packages: {} }, { fetchFn: server({}).fetchFn, url: URL_, dir: tmp(t) }), { message: "เวอร์ชันใหม่ยังไม่มีสำหรับเครื่องนี้" });
});

test("relaunchCommand: installed copies only, never a git checkout", (t) => {
  const inst = tmp(t);
  const root = path.join(inst, "app");
  fs.mkdirSync(root);
  assert.equal(relaunchCommand(root, "win32"), null);
  fs.writeFileSync(path.join(inst, "KidFactory.exe"), "");
  assert.deepEqual(relaunchCommand(root, "win32"), [path.join(inst, "KidFactory.exe")]);
  fs.writeFileSync(path.join(root, "start.command"), "");
  assert.deepEqual(relaunchCommand(root, "darwin"), ["open", path.join(root, "start.command")]);
  fs.mkdirSync(path.join(root, ".git"));
  assert.equal(relaunchCommand(root, "darwin"), null);
});

function swapJob(t) {
  const d = tmp(t);
  const job = {
    pid: 999999999, root: path.join(d, "app"), staged: path.join(d, "upd", "new"), old: path.join(d, "upd", "old"),
    version: "0.3.0", from: "0.2.0", relaunch: ["go"], result: path.join(d, "upd", "result.json"),
  };
  for (const [dir, v] of [[job.root, "0.2.0"], [job.staged, "0.3.0"]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: v }));
  }
  const ver = () => JSON.parse(fs.readFileSync(path.join(job.root, "package.json"), "utf8")).version;
  return { job, ver, dir: path.dirname(job.result) };
}

test("swap: new version in place, old kept, app started, result ok", async (t) => {
  const { job, ver, dir } = swapJob(t);
  const started = [];
  await swap(job, { start: (c) => started.push(c), healthy: async () => true, exitWait: 0 });
  assert.equal(ver(), "0.3.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(job.old, "package.json"), "utf8")).version, "0.2.0");
  assert.deepEqual(started, [["go"]]);
  assert.deepEqual({ ...takeResult(dir), at: 0 }, { ok: true, from: "0.2.0", to: "0.3.0", at: 0 });
  assert.equal(takeResult(dir), null); // shown once
});

test("swap: rolls back when the new version does not come up", async (t) => {
  const { job, ver, dir } = swapJob(t);
  const started = [];
  await swap(job, { start: (c) => started.push(c), healthy: async () => false, exitWait: 0 });
  assert.equal(ver(), "0.2.0");
  assert.equal(started.length, 2); // new version, then the old one again
  assert.equal(takeResult(dir).ok, false);
});
