// Dev tool: real-API story check. Usage: node scripts/try-story.mjs <topic> <fileId> [ideaIndex 0-2] [reuseIdeasFromId]
// Prints 3 ideas and the story; saves JSON to <dataDir>/spike/stories/<fileId>.json. Never prints the key.
import fs from "node:fs";
import path from "node:path";
import { createGemini } from "../src/gemini.mjs";
import { dataDir, readConfig } from "../src/data.mjs";
import { ideas, writeStory, validateStory, estimateSeconds } from "../src/story.mjs";

const [topic, fileId, pick = "0", reuse] = process.argv.slice(2);
if (!topic || !/^[\w-]+$/.test(fileId ?? "")) {
  console.error("usage: node scripts/try-story.mjs <topic> <fileId> [ideaIndex]");
  process.exit(2);
}
const { key } = readConfig();
if (!key) { console.error("no key in config.json"); process.exit(2); }
const mask = (s) => String(s).split(key).join("[key]");

try {
  const gemini = createGemini({ key });
  const t0 = Date.now();
  const dir = path.join(dataDir(), "spike", "stories");
  const list = reuse && /^[\w-]+$/.test(reuse)
    ? JSON.parse(fs.readFileSync(path.join(dir, `${reuse}.json`), "utf8")).ideas
    : await ideas(gemini, topic);
  list.forEach((i, n) => console.log(`IDEA ${n}: ${i.title} — ${i.pitch}`));
  const idea = list[Number(pick)] ?? list[0];
  const story = await writeStory(gemini, idea, { minutes: 5 });
  const secs = estimateSeconds(story.pages);
  console.log(`\n# ${story.title}  (mood ${story.mood}, ${story.pages.length} pages, ~${secs.toFixed(0)} s, ${((Date.now() - t0) / 1000).toFixed(0)} s to write)`);
  console.log("side:", story.sideCharacters.map((c) => `${c.id}: ${c.look}`).join(" | ") || "none");
  story.pages.forEach((p, i) => {
    console.log(`\n[${i + 1}] (${[...p.narration].length} ch) cast=${p.cast.join(",")}\n${p.narration}\n  > ${p.scene}`);
  });
  console.log("\nproblems:", validateStory(story));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fileId}.json`);
  fs.writeFileSync(file, JSON.stringify({ topic, ideas: list, idea, estimateSeconds: Math.round(secs * 10) / 10, story }, null, 2));
  console.log("saved", file);
} catch (e) {
  console.error("FAILED", e?.code ?? "", mask(e?.message ?? e));
  process.exit(1);
}
