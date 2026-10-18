// Episode → MP4: intro clip, the book (frames drawn here, piped raw into ffmpeg), outro clip.
// Video (one H.264 encode: intro + piped frames + outro) and audio (narration + looped music,
// loudness-normalised in two passes) are built in parallel, then muxed without re-encoding video.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createBook } from "./book.mjs";
import { TIMING, buildTimeline, timelineSeconds, sampleAt } from "../timeline.mjs";
import { narrationTrack, wavSeconds } from "../audio.mjs";
import { staleVoices } from "../pages.mjs";
import { listTracks, pickTrack, markUsed } from "../music.mjs";
import { dataDir } from "../data.mjs";

const CLIPS_DIR = fileURLToPath(new URL("../../assets/clips/", import.meta.url));
const FFMPEG = () => process.env.KIDFACTORY_FFMPEG || "ffmpeg";
const FFPROBE = () => process.env.KIDFACTORY_FFPROBE || "ffprobe";
const RENDER_FAILED = "สร้างวิดีโอไม่สำเร็จ";
const LOUDNESS = { I: -14, TP: -1, LRA: 20 };
const MUSIC_UNDER = 20; // music sits this many LU below the narration
const AF = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

/** Thai title → safe file name (illegal characters on Windows/macOS removed, Thai and spaces kept). */
export function safeTitle(title) {
  const s = String(title ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return Array.from(s).slice(0, 80).join("").trim() || "episode";
}

const fail = (detail) => Object.assign(new Error(RENDER_FAILED), { detail: String(detail || "").slice(-2000) });

// Run a tool to completion; resolves with stdout/stderr text, rejects (Thai message, detail = stderr tail).
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err = (err + d).slice(-20000); });
    p.on("error", (e) => reject(fail(e.message)));
    p.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(fail(err))));
  });
}

async function hasAudio(file) {
  const { out } = await run(FFPROBE(), ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
  return out.trim().length > 0;
}

// Integrated loudness in LUFS (NaN when silent / unmeasurable).
async function loudnessOf(file) {
  const { err } = await run(FFMPEG(), ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
  const m = [...err.matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop();
  const v = m ? Number(m[1]) : NaN;
  return v > -69 ? v : NaN;
}

function checkReady(ep, epPath) {
  const pages = ep.story?.pages || [];
  const voices = new Set(staleVoices(ep));
  pages.forEach((p, i) => {
    if (!p.voice?.file || !fs.existsSync(epPath(p.voice.file))) voices.add(i + 1);
  });
  if (voices.size) throw new Error(`เสียงหน้า ${[...voices].sort((a, b) => a - b).join(", ")} ยังไม่อัปเดต`);
  const images = [];
  pages.forEach((p, i) => {
    if (p.image?.state !== "done" || !p.image.file || !fs.existsSync(epPath(p.image.file))) images.push(i + 1);
  });
  if (images.length) throw new Error(`ภาพหน้า ${images.join(", ")} ยังไม่เสร็จ`);
  if (!pages.length) throw new Error("ยังไม่มีหน้าหนังสือ");
}

function chooseMusic(ep) {
  const tracks = listTracks();
  const t = (ep.musicId && tracks.find((x) => x.id === ep.musicId)) || pickTrack(ep.story.mood);
  return t ? { id: t.id, file: path.join(dataDir(), "music", `${t.id}.mp3`) } : null;
}

// Inputs + filter graph producing [full]: 5 s intro audio, main mix (mainSec), 5 s outro audio, 48 kHz stereo.
function audioGraph({ intro, outro, narration, music, mainSec }) {
  const D = TIMING.introOutro;
  const args = [];
  const silence = (sec) => ["-f", "lavfi", "-t", String(sec), "-i", "anullsrc=r=48000:cl=stereo"];
  const clipIn = (c) => (c.audio ? ["-i", c.file] : silence(D));
  args.push(...clipIn(intro), "-i", narration);
  if (music) args.push("-stream_loop", "-1", "-i", music.file);
  args.push(...clipIn(outro));
  const outroIdx = music ? 3 : 2;
  const fit = (sec) => `apad=whole_dur=${sec},atrim=0:${sec},asetpts=N/SR/TB`;
  const f = [
    `[0:a]${AF},${fit(D)}[ia]`,
    `[1:a]${AF},${fit(mainSec)}[na]`,
    `[${outroIdx}:a]${AF},${fit(D)}[oa]`,
  ];
  if (music) {
    const outAt = Math.max(0, mainSec - 3);
    f.push(`[2:a]${AF},atrim=0:${mainSec},asetpts=N/SR/TB,volume=${music.gain.toFixed(2)}dB,afade=t=in:st=0:d=2,afade=t=out:st=${outAt}:d=3[ma]`);
    f.push(`[na][ma]amix=inputs=2:duration=first:normalize=0[mix]`);
  } else {
    f.push(`[na]anull[mix]`);
  }
  f.push(`[ia][mix][oa]concat=n=3:v=0:a=1[full]`);
  return { args, filter: f.join(";") };
}

async function buildAudio({ work, intro, outro, narrationWav, music, mainSec }) {
  const narration = path.join(work, "narration.wav");
  fs.writeFileSync(narration, narrationWav);
  if (music) {
    const [nI, mI] = await Promise.all([loudnessOf(narration), loudnessOf(music.file)]);
    const gain = Number.isFinite(nI) && Number.isFinite(mI) ? nI - MUSIC_UNDER - mI : -MUSIC_UNDER;
    music = { ...music, gain: Math.min(10, Math.max(-40, gain)) };
  }
  const g = audioGraph({ intro, outro, narration, music, mainSec });
  const L = `I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
  const base = ["-hide_banner", "-nostats", "-y", ...g.args];

  // pass 1: measure
  const { err } = await run(FFMPEG(), [...base, "-filter_complex", `${g.filter};[full]loudnorm=${L}:print_format=json[out]`, "-map", "[out]", "-f", "null", "-"]);
  const json = err.slice(err.lastIndexOf("{"), err.lastIndexOf("}") + 1);
  let m = null;
  try { m = JSON.parse(json); } catch {}
  const measured = m && Number.isFinite(Number(m.input_i)) && Number(m.input_i) > -69
    ? `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : "";
  // pass 2: apply (silent mixes skip loudnorm: nothing to normalise)
  const final = path.join(work, "final.wav");
  const tailF = measured ? `[full]loudnorm=${L}${measured},${AF}[out]` : `[full]anull[out]`;
  await run(FFMPEG(), [...base, "-filter_complex", `${g.filter};${tailF}`, "-map", "[out]", "-c:a", "pcm_s16le", final]);
  return final;
}

// One ffmpeg: [intro][piped frames][outro] → H.264 (video only; audio is muxed afterwards).
function encoderArgs({ W, H, intro, outro, out }) {
  const D = TIMING.introOutro, fps = TIMING.fps;
  const clip = (i, label) =>
    `[${i}:v]setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=${D},trim=duration=${D},setpts=PTS-STARTPTS[${label}]`;
  const filter = [
    clip(0, "iv"),
    `[1:v]format=yuv420p,setsar=1[mv]`,
    clip(2, "ov"),
    `[iv][mv][ov]concat=n=3:v=1:a=0[v]`,
  ].join(";");
  return [
    "-hide_banner", "-nostats", "-y",
    "-i", intro.file,
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(fps), "-i", "-",
    "-i", outro.file,
    "-filter_complex", filter,
    "-map", "[v]", "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-f", "mp4", out,
  ];
}

const muxArgs = ({ video, audio, out }) => [
  "-hide_banner", "-nostats", "-y", "-i", video, "-i", audio,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
  "-movflags", "+faststart", "-f", "mp4", out,
];

async function encode({ args, frames, draw, onFrame }) {
  const ff = spawn(FFMPEG(), args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d) => { err = (err + d).slice(-20000); });
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies early; the exit code tells the story
  let exited = false;
  const done = new Promise((resolve) => {
    ff.on("error", (e) => { exited = true; err += `\n${e.message}`; resolve(-1); });
    ff.on("close", (code) => { exited = true; resolve(code); });
  });
  for (let f = 0; f < frames && !exited; f++) {
    const buf = await draw(f);
    if (!ff.stdin.write(buf)) await Promise.race([once(ff.stdin, "drain").catch(() => {}), done]);
    onFrame(f);
  }
  ff.stdin.end();
  const code = await done;
  if (code !== 0) throw fail(err);
}

/**
 * Renders the episode to <episode>/out/<title>.mp4 and returns that path.
 * opts: onProgress(0..1), width/height (tests render small), clips {intro, outro} to override assets/clips.
 */
export async function renderEpisode(ep, { onProgress, width = 1920, height = 1080, clips = {} } = {}) {
  const epRoot = path.join(dataDir(), "episodes", ep.id);
  const epPath = (rel) => path.join(epRoot, rel);
  checkReady(ep, epPath);
  const progress = (x) => { try { onProgress?.(Math.min(1, Math.max(0, x))); } catch {} };
  progress(0);

  const W = Math.round(width / 2) * 2, H = Math.round(height / 2) * 2;
  const pages = ep.story.pages;
  const voices = pages.map((p) => fs.readFileSync(epPath(p.voice.file)));
  const timeline = buildTimeline(voices.map((v) => wavSeconds(v)));
  const frames = Math.round(timelineSeconds(timeline) * TIMING.fps);
  const mainSec = frames / TIMING.fps;

  const clip = async (name) => {
    const file = clips[name] || path.join(CLIPS_DIR, `${name}.mp4`);
    if (!fs.existsSync(file)) throw new Error(`ไม่พบคลิป ${name}.mp4`);
    return { file, audio: await hasAudio(file) };
  };
  const [intro, outro] = await Promise.all([clip("intro"), clip("outro")]);
  const music = chooseMusic(ep);

  const outDir = epPath("out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${safeTitle(ep.story.title)}.mp4`);
  const part = `${outFile}.part`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kf-render-"));
  let audioJob = null;
  try {
    const parts = timeline.filter((s) => s.kind === "hold").map((s) => ({ wav: voices[s.page - 1], at: s.voiceAt }));
    audioJob = buildAudio({ work, intro, outro, narrationWav: narrationTrack(parts, mainSec), music, mainSec });
    audioJob.catch(() => {}); // awaited below; avoid an unhandled rejection while frames render
    const video = path.join(work, "video.mp4");

    const book = createBook({ width: W, height: H });
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    // each page decoded once and reused (book.mjs caches its scaled copy by object identity)
    const images = new Map();
    const image = async (n) => {
      if (!images.has(n)) images.set(n, await loadImage(fs.readFileSync(epPath(pages[n - 1].image.file))));
      return images.get(n);
    };
    const keepOnly = (...ns) => { for (const k of images.keys()) if (!ns.includes(k)) images.delete(k); };

    await encode({
      args: encoderArgs({ W, H, intro, outro, out: video }),
      frames,
      draw: async (f) => {
        const s = sampleAt(timeline, f / TIMING.fps);
        if (s.kind === "hold") {
          keepOnly(s.page);
          book.frame(ctx, { page: await image(s.page), zoom: s.zoom });
        } else {
          keepOnly(s.from, s.to);
          book.turn(ctx, { from: await image(s.from), fromZoom: s.fromZoom, to: await image(s.to), progress: s.progress });
        }
        return canvas.data();
      },
      onFrame: (f) => { if (f % 15 === 0) progress((0.97 * f) / frames); },
    });
    progress(0.97);
    await run(FFMPEG(), muxArgs({ video, audio: await audioJob, out: part }));
    fs.renameSync(part, outFile);
  } finally {
    await audioJob?.catch(() => {}); // never delete the work folder under a running audio job
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(part, { force: true });
  }
  if (music) {
    try { markUsed(music.id); } catch {}
  }
  progress(1);
  return outFile;
}
