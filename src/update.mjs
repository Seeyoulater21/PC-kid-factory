// Self-update from GitHub releases (public repo, no token). Each release carries update.json:
//   { version, notes: [Thai lines], packages: { "win32-x64": { file, size, sha256 }, "darwin-arm64": {...} } }
// and one .tar.gz per platform holding the whole app folder (code + node_modules for that platform).
// The swap itself runs in update-swap.mjs after this process has exited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const DEFAULT_URL = "https://github.com/Seeyoulater21/PC-kid-factory/releases/latest/download/update.json";
export const manifestUrl = () => process.env.KIDFACTORY_UPDATE_URL || DEFAULT_URL;
export const platformKey = () => `${process.platform}-${process.arch}`;
export const currentVersion = (root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const T = {
  offline: "ตรวจหาอัปเดตไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่",
  noPackage: "เวอร์ชันใหม่ยังไม่มีสำหรับเครื่องนี้",
  download: "ดาวน์โหลดอัปเดตไม่สำเร็จ ลองใหม่",
  corrupt: "ไฟล์อัปเดตเสียหาย ลองใหม่",
  devCopy: "โปรแกรมชุดนี้อัปเดตเองไม่ได้ (ชุดสำหรับพัฒนา)",
};
const thai = (message) => Object.assign(new Error(message), { thai: message });

/** Is version a newer than b? ("0.10.0" > "0.9.3") */
export function newer(a, b) {
  const p = (v) => String(v).split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Folder for downloads, the staged new version, the previous version and the last result (never the data folder). */
export function stateDir() {
  const base = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), "KidFactory")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "KidFactory")
      : path.join(os.homedir(), ".kidfactory");
  return process.env.KIDFACTORY_UPDATE_DIR || path.join(base, "update");
}

async function getJson(url, fetchFn) {
  let r;
  try {
    r = await fetchFn(url, { signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-cache" } });
  } catch {
    throw thai(T.offline);
  }
  if (!r.ok) throw thai(T.offline);
  try { return await r.json(); } catch { throw thai(T.offline); }
}

/** { current, latest, available, notes } — latest/notes only when a manifest was read. */
export async function checkUpdate({ fetchFn = fetch, url = manifestUrl(), root = ROOT } = {}) {
  const current = currentVersion(root);
  const m = await getJson(url, fetchFn);
  if (!m || typeof m.version !== "string") throw thai(T.offline);
  const notes = Array.isArray(m.notes) ? m.notes.filter((s) => typeof s === "string").slice(0, 10) : [];
  return { current, latest: m.version, available: newer(m.version, current), notes, manifest: m };
}

/** Downloads, verifies (size + SHA-256) and unpacks the package; returns the staged folder. */
export async function stageUpdate(manifest, { fetchFn = fetch, url = manifestUrl(), dir = stateDir(), tar = "tar" } = {}) {
  const pkg = manifest.packages?.[platformKey()];
  if (!pkg || typeof pkg.file !== "string" || !/^[\w.-]+$/.test(pkg.file)) throw thai(T.noPackage);
  let buf;
  try {
    const r = await fetchFn(new URL(pkg.file, url), { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!r.ok) throw new Error(String(r.status));
    buf = Buffer.from(await r.arrayBuffer());
  } catch {
    throw thai(T.download);
  }
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (buf.length !== pkg.size || sha !== String(pkg.sha256).toLowerCase()) throw thai(T.corrupt);

  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, "new");
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(dir, "package.tar.gz"), buf);
  // relative names only: tar never sees a non-ASCII user folder in its arguments
  await new Promise((resolve, reject) => {
    const p = spawn(tar, ["-xzf", "package.tar.gz", "-C", "new"], { cwd: dir, stdio: "ignore", windowsHide: true });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar ${code}`))));
  }).catch(() => { throw thai(T.corrupt); });
  fs.rmSync(path.join(dir, "package.tar.gz"), { force: true });
  let version = null;
  try { version = currentVersion(staged); } catch {}
  if (version !== manifest.version) throw thai(T.corrupt);
  return staged;
}

/** How to start the app again after the swap, or null when this copy cannot update itself (e.g. a git checkout). */
export function relaunchCommand(root = ROOT, platform = process.platform) {
  if (fs.existsSync(path.join(root, ".git"))) return null;
  if (platform === "win32") {
    const exe = path.join(path.dirname(root), "KidFactory.exe");
    return fs.existsSync(exe) ? [exe] : null;
  }
  if (platform === "darwin") {
    const cmd = path.join(root, "start.command");
    return fs.existsSync(cmd) ? ["open", cmd] : null;
  }
  return null;
}

export function canSelfUpdate(root = ROOT) {
  return relaunchCommand(root) !== null;
}

/** Starts the detached swap helper; the caller must exit right after (exit code 75 = restarting for update). */
export function startSwap({ staged, version, root = ROOT, dir = stateDir() }) {
  const relaunch = relaunchCommand(root);
  if (!relaunch) throw thai(T.devCopy);
  // run the helper from a copy outside the app folder, which is about to be renamed
  const helper = path.join(dir, "update-swap.mjs");
  fs.copyFileSync(fileURLToPath(new URL("./update-swap.mjs", import.meta.url)), helper);
  const job = { pid: process.pid, root, staged, old: path.join(dir, "old"), version, from: currentVersion(root), relaunch, result: path.join(dir, "result.json") };
  const p = spawn(process.execPath, [helper, JSON.stringify(job)], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
}

/** The outcome of the last update (shown once), or null. */
export function takeResult(dir = stateDir()) {
  const file = path.join(dir, "result.json");
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file, { force: true });
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}
