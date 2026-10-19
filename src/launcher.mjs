// Windows launcher, started hidden by KidFactory.exe: reuse a running Kid Factory or start one on a free port
// 4848–4858, open it in a chromeless Edge window, and stop the server when that window closes.
// Usage: node src/launcher.mjs   (KIDFACTORY_NO_WINDOW=1 = print the URL instead of opening a window)
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PORTS = Array.from({ length: 11 }, (_, i) => 4848 + i);
const RUNTIME = fileURLToPath(new URL("../../runtime/", import.meta.url)); // <install>\runtime next to <install>\app

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** True when a Kid Factory of this same version answers on the port (another copy or version is left alone). */
export async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
    const s = r.ok ? await r.json() : {};
    return "savedIdeas" in s && s.version === VERSION;
  } catch {
    return false;
  }
}

export function isFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** { port, reuse: true } for a Kid Factory already running, else { port, reuse: false } for the first free port, else null. */
export async function pickPort({ ours = isOurs, free = isFree, ports = PORTS } = {}) {
  for (const p of ports) if (await ours(p)) return { port: p, reuse: true };
  for (const p of ports) if (await free(p)) return { port: p, reuse: false };
  return null;
}

export function edgePath(env = process.env, exists = fs.existsSync) {
  const rel = path.join("Microsoft", "Edge", "Application", "msedge.exe");
  return [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA]
    .filter(Boolean)
    .map((dir) => path.join(dir, rel))
    .find((p) => exists(p));
}

/** Edge keeps <profile>\lockfile open (no sharing) while any window of that profile is open. */
export function profileInUse(profile, open = fs.openSync) {
  try {
    fs.closeSync(open(path.join(profile, "lockfile"), "r+"));
    return false;
  } catch (e) {
    return e.code === "EBUSY" || e.code === "EPERM" || e.code === "EACCES";
  }
}

// Resolves when the window closes. Without Edge the default browser opens and the server keeps running.
function openWindow(url) {
  const edge = edgePath();
  if (!edge) {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return new Promise(() => {});
  }
  const profile = path.join(process.env.LOCALAPPDATA || process.cwd(), "KidFactory", "edge-profile");
  const p = spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { stdio: "ignore" });
  // When this profile is already open (an old window), Edge hands the URL over and this process exits at once,
  // so wait on the profile lock rather than on the process.
  return new Promise((resolve) => { p.on("exit", resolve); p.on("error", resolve); }).then(async () => {
    while (profileInUse(profile)) await sleep(1000);
  });
}

// A hidden process has no console, so problems are shown in a small Windows message box.
function messageBox(text) {
  const ps = "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:KF_MESSAGE, 'Kid Factory') | Out-Null";
  spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true, env: { ...process.env, KF_MESSAGE: text } })
    .on("error", () => {});
}

async function main() {
  for (const [name, exe] of [["KIDFACTORY_FFMPEG", "ffmpeg.exe"], ["KIDFACTORY_FFPROBE", "ffprobe.exe"]]) {
    if (!process.env[name] && fs.existsSync(path.join(RUNTIME, exe))) process.env[name] = path.join(RUNTIME, exe);
  }
  const noWindow = process.env.KIDFACTORY_NO_WINDOW === "1";
  const picked = await pickPort();
  if (!picked) return messageBox(`ไม่มีพอร์ตว่าง (${PORTS[0]}-${PORTS.at(-1)}) ปิดโปรแกรมอื่นแล้วลองใหม่`);
  const url = `http://127.0.0.1:${picked.port}/`;
  if (picked.reuse) {
    if (noWindow) console.log(`READY ${url} (reused)`);
    else await openWindow(url);
    return;
  }
  const { createServer } = await import("./server.mjs");
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(picked.port, "127.0.0.1", resolve); });
  if (noWindow) return console.log(`READY ${url}`);
  await openWindow(url);
  process.exit(0); // window closed: stop the server (child processes such as ffmpeg end with it on Windows)
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    try { // hidden process: keep the reason where a helper can find it
      const dir = path.join(process.env.LOCALAPPDATA || process.cwd(), "KidFactory");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "launcher.log"), `${new Date().toISOString()} ${e?.stack || e}\n`);
    } catch {}
    messageBox("เปิดโปรแกรมไม่สำเร็จ ลองเปิดใหม่อีกครั้ง");
  });
}
