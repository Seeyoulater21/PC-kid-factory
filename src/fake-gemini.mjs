// Offline stand-in for the AI clients (KIDFACTORY_FAKE=1): no network, no cost, no ChatGPT needed.
// Ideas, story and packaging come from docs/sample-story.json; pictures are solid-colour JPEGs; voices are short tones.
import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { IDEAS_SCHEMA, PACKAGE_SCHEMA } from "./prompts.mjs";
import { writeWav } from "./audio.mjs";

const sample = () => JSON.parse(fs.readFileSync(new URL("../docs/sample-story.json", import.meta.url), "utf8"));
const COLORS = ["#ffd56b", "#ff9a6b", "#8fd3c7", "#a7c7ff", "#f6a5c0", "#b9e48a", "#d3b8ff", "#ffc48a"];

function hash(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

function picture(seed) {
  const W = 1376, H = 768;
  const c = createCanvas(W, H);
  const x = c.getContext("2d");
  const h = hash(seed);
  x.fillStyle = COLORS[h % COLORS.length];
  x.fillRect(0, 0, W, H);
  x.fillStyle = COLORS[(h >> 3) % COLORS.length];
  x.beginPath();
  x.arc(W * (0.3 + ((h >> 6) % 40) / 100), H * 0.55, H * 0.28, 0, Math.PI * 2);
  x.fill();
  x.lineWidth = 14;
  x.strokeStyle = "#222";
  x.stroke();
  return c.toBuffer("image/jpeg");
}

function tone(text) {
  const rate = 24000;
  const seconds = Math.min(4, 1 + [...String(text)].length / 80);
  const n = Math.round(seconds * rate);
  const hz = 330 + (hash(text) % 6) * 55;
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2400, (n - i) / 2400);
    s[i] = Math.round(5000 * env * Math.sin((2 * Math.PI * hz * i) / rate));
  }
  return writeWav({ rate, channels: 1, samples: s });
}

export function createFakeGemini({ delayMs = 400 } = {}) {
  const wait = (ms = delayMs) => new Promise((r) => setTimeout(r, ms));
  return {
    async json(model, prompt, schema) {
      const s = sample();
      if (schema === IDEAS_SCHEMA) {
        await wait();
        return { ideas: s.ideas };
      }
      if (schema === PACKAGE_SCHEMA) {
        await wait();
        return s.package;
      }
      await wait(delayMs * 5);
      // name the story after the idea it was asked for, so a click-through reads naturally
      const idea = s.ideas.find((i) => String(prompt).includes(i.title));
      return idea ? { ...s.story, title: idea.title } : s.story;
    },
    async image(prompt) {
      await wait();
      return picture(prompt);
    },
    async speech(text) {
      await wait(delayMs / 2);
      return tone(text);
    },
    async music() {
      await wait();
      return fs.readFileSync(new URL("../assets/music/seed-calm.mp3", import.meta.url));
    },
  };
}
