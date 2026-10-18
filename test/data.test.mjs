import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir, readConfig, saveKey, hasKey } from "../src/data.mjs";

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
  assert.equal(fs.statSync(path.join(d, "config.json")).mode & 0o777, 0o600);
});

test("saveKey keeps other config fields and trims the key", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "config.json"), JSON.stringify({ other: 1 }));
  saveKey("  k  ");
  assert.deepEqual(readConfig(), { other: 1, key: "k" });
});

test("default dir is <home>/Documents/KidFactory, created if missing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kf-home-"));
  const oldHome = process.env.HOME;
  t.after(() => { process.env.HOME = oldHome; fs.rmSync(home, { recursive: true, force: true }); });
  process.env.HOME = home; // os.homedir() follows HOME on macOS/Linux
  delete process.env.KIDFACTORY_DATA;
  const want = path.join(home, "Documents", "KidFactory");
  assert.equal(dataDir(), want);
  assert.ok(fs.statSync(want).isDirectory());
});
