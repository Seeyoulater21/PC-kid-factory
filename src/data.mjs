import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dataDir() {
  if (process.env.KIDFACTORY_DATA) return process.env.KIDFACTORY_DATA;
  const dir = path.join(os.homedir(), "Documents", "KidFactory");
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
