// Runs renderEpisode off the server's main thread (frame drawing is CPU-bound for minutes).
// Messages to the parent: {progress}, then {done: file} or {error: thai}.
import { parentPort, workerData } from "node:worker_threads";
import { renderEpisode } from "./video.mjs";

try {
  const file = await renderEpisode(workerData.ep, {
    onProgress: (p) => parentPort.postMessage({ progress: p }),
  });
  parentPort.postMessage({ done: file });
} catch (e) {
  const thai = e?.thai === true && e.message ? e.message : "สร้างวิดีโอไม่สำเร็จ";
  parentPort.postMessage({ error: thai, detail: String(e?.detail || "").slice(-500) });
}
