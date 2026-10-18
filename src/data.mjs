import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir() {
  if (process.env.KIDFACTORY_DATA) return process.env.KIDFACTORY_DATA;
  // Windows: Documents is often synced by OneDrive (big media, cloud copy of the key, locked files), so stay outside it.
  const dir = process.platform === "win32" ? path.join(os.homedir(), "KidFactory") : path.join(os.homedir(), "Documents", "KidFactory");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const configPath = () => path.join(dataDir(), "config.json");

export function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

export function saveKey(key) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const cfg = { ...readConfig(), key: String(key).trim() };
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600); // writeFile keeps the old mode on an existing file
}

export function hasKey() {
  const k = readConfig().key;
  return typeof k === "string" && k.length > 0;
}

/** renameSync that waits out a short lock (antivirus or sync tools on Windows hold new files for a moment). */
export function renameRetry(from, to, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= tries || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
    }
  }
}
