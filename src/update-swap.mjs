// Update helper, run detached from a copy outside the app folder (see update.mjs startSwap):
// wait for the app to exit → app folder becomes "old", staged folder becomes the app → start the app →
// if the new version does not answer within a minute, put the old folder back and start that instead.
// Self-contained on purpose: it must not import anything from the app folder it is replacing.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const PORTS = Array.from({ length: 11 }, (_, i) => 4848 + i);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Windows keeps files locked for a moment after a process ends (and antivirus may scan new files).
async function renameRetry(from, to, tries = 40) {
  for (let i = 1; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= tries || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      await sleep(500);
    }
  }
}

function startApp(cmd) {
  const p = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
}

// pid of a running Kid Factory of this version, or 0
async function answering(version) {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
      const j = r.ok ? await r.json() : null;
      if (j?.version === version) return j.pid || -1;
    } catch {}
  }
  return 0;
}
const answers = async (version) => (await answering(version)) !== 0;

// A late or hung new version holds the folder open (Windows) or a port: stop it before moving folders back.
async function stopVersion(version) {
  const pid = await answering(version);
  if (pid <= 0) return;
  try { process.kill(pid); } catch {}
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(500);
}

async function waitHealthy(version, seconds = 60) {
  for (let i = 0; i < seconds / 2; i++) {
    if (await answers(version)) return true;
    await sleep(2000);
  }
  return false;
}

/**
 * job: { pid, root, staged, old, version, from, relaunch: [cmd, ...args], result }
 * deps (tests): start(cmd), healthy(version) → bool, exitWait seconds
 */
export async function swap(job, { start = startApp, healthy = waitHealthy, stop = stopVersion, exitWait = 30, tries } = {}) {
  const move = (from, to) => renameRetry(from, to, tries);
  const write = (r) => fs.writeFileSync(job.result, JSON.stringify({ ...r, from: job.from, to: job.version, at: new Date().toISOString() }));
  for (let i = 0; i < exitWait * 2 && alive(job.pid); i++) await sleep(500);

  try {
    fs.rmSync(job.old, { recursive: true, force: true });
    await move(job.root, job.old);
  } catch {
    write({ ok: false });
    return start(job.relaunch); // nothing moved yet: the old version simply starts again
  }
  try {
    await move(job.staged, job.root);
  } catch {
    await move(job.old, job.root); // throws only if the folder cannot be put back; KidFactory.exe also restores it on start
    write({ ok: false });
    return start(job.relaunch);
  }

  write({ ok: true }); // before the start: the new window reads it on its first load
  start(job.relaunch);
  if (await healthy(job.version)) return;

  // roll back: the new version did not come up
  const failed = `${job.staged}-failed`;
  await stop(job.version);
  try {
    fs.rmSync(failed, { recursive: true, force: true });
    await move(job.root, failed);
    await move(job.old, job.root);
  } catch {}
  if (!fs.existsSync(job.root) && fs.existsSync(job.old)) await move(job.old, job.root).catch(() => {});
  write({ ok: false });
  start(job.relaunch);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const job = JSON.parse(process.argv[2]);
  swap(job).catch((e) => {
    try { fs.appendFileSync(path.join(path.dirname(job.result), "update.log"), `${new Date().toISOString()} ${e?.stack || e}\n`); } catch {}
  });
}
