import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir, readConfig, saveKey, hasKey, renameRetry } from "../src/data.mjs";

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kf-data-"));
  process.env.KIDFACTORY_DATA = d;
  return d;
}

test("hasKey is false on an empty dir", () => {
  tmp();
  assert.equal(hasKey(), false);
  assert.deepEqual(readConfig(), {});
});

test("saveKey then readConfig round-trips, file mode 0600", () => {
  const d = tmp();
  saveKey("abc-123");
  assert.equal(readConfig().key, "abc-123");
  assert.equal(hasKey(), true);
  assert.equal(dataDir(), d);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(d, "config.json")).mode & 0o777, 0o600); // no Unix modes on Windows
});

test("saveKey keeps other config fields and trims the key", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ other: 1 }));
  saveKey("  k  ");
  assert.deepEqual(readConfig(), { other: 1, key: "k" });
});

test("default dir: <home>/Documents/KidFactory, on Windows <home>\\KidFactory (outside OneDrive); created if missing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kf-home-"));
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home; // os.homedir() follows HOME on macOS/Linux
  process.env.USERPROFILE = home; // and USERPROFILE on Windows
  delete process.env.KIDFACTORY_DATA;
  const want = process.platform === "win32" ? path.join(home, "KidFactory") : path.join(home, "Documents", "KidFactory");
  assert.equal(dataDir(), want);
  assert.ok(fs.statSync(want).isDirectory());
});

test("renameRetry retries a briefly locked file (EPERM/EBUSY), then gives up", (t) => {
  const real = fs.renameSync;
  t.after(() => { fs.renameSync = real; });
  let calls = 0;
  fs.renameSync = () => { if (++calls < 3) throw Object.assign(new Error("locked"), { code: "EPERM" }); };
  renameRetry("a", "b");
  assert.equal(calls, 3);
  calls = 0;
  fs.renameSync = () => { calls++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); };
  assert.throws(() => renameRetry("a", "b"), { code: "EBUSY" });
  assert.equal(calls, 5);
  calls = 0;
  fs.renameSync = () => { calls++; throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
  assert.throws(() => renameRetry("a", "b"), { code: "ENOENT" });
  assert.equal(calls, 1);
});

test("a broken config.json is moved aside, never overwritten by the next save", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "config.json"), '{"key": "abc", "other"');
  assert.deepEqual(readConfig(), {});
  const aside = fs.readdirSync(d).filter((f) => f.startsWith("config.broken-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(d, aside[0]), "utf8"), '{"key": "abc", "other"');
  saveKey("new");
  assert.equal(readConfig().key, "new");
  assert.equal(fs.readdirSync(d).filter((f) => f.startsWith("config.broken-")).length, 1);
});
