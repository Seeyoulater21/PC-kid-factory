// Shared test helpers: a real small JPEG (pictures go through the canvas) and a library whose sheets are all drawn.
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { library, saveLibrary, addNewSheets, sheetDir } from "../src/sheets.mjs";
import { createAi } from "../src/ai.mjs";

let cached = null;
export function jpeg() {
  if (!cached) {
    const c = createCanvas(64, 36);
    const x = c.getContext("2d");
    x.fillStyle = "#8fd3c7";
    x.fillRect(0, 0, 64, 36);
    cached = c.toBuffer("image/jpeg");
  }
  return Buffer.from(cached);
}

/** Every sheet in the library (plus newSheets) gets a drawn take, so page jobs draw only pages. */
export function readyLibrary(newSheets = []) {
  addNewSheets(newSheets);
  fs.mkdirSync(sheetDir(), { recursive: true });
  for (const s of library()) {
    if (s.chosen) continue;
    const file = `${s.tag}-1.jpg`;
    fs.writeFileSync(path.join(sheetDir(), file), jpeg());
    s.takes.push({ file, prompt: "p" });
    s.chosen = file;
    s.state = "done";
  }
  saveLibrary();
}

/** An AI client over a Gemini-like fake (image(prompt, refs) → bytes, speech, json). */
export const gem = (g) => createAi({ provider: "gemini", gemini: () => g });
