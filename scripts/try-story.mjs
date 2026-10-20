// Dev tool: real story check with ChatGPT (KF_PROVIDER=gemini for Gemini).
// Usage: node scripts/try-story.mjs <topic> <fileId> [ideaIndex 0-2] [reuseIdeasFromId]
// Prints 3 ideas and the story; saves JSON to <dataDir>/spike/stories/<fileId>.json. Never prints the key.
import fs from "node:fs";
import path from "node:path";
import { createGemini } from "../src/gemini.mjs";
import { CodexBridge } from "../src/codex.mjs";
import { createAi } from "../src/ai.mjs";
import { library } from "../src/sheets.mjs";
import { dataDir, readConfig } from "../src/data.mjs";
import { ideas, writeStory, validateStory, estimateSeconds } from "../src/story.mjs";

const [topic, fileId, pick = "0", reuse] = process.argv.slice(2);
if (!topic || !/^[\w-]+$/.test(fileId ?? "")) {
  console.error("usage: node scripts/try-story.mjs <topic> <fileId> [ideaIndex] [reuseIdeasFromId]");
  process.exit(2);
}
const { key } = readConfig();
const provider = process.env.KF_PROVIDER === "gemini" ? "gemini" : "chatgpt";
if (provider === "gemini" && !key) { console.error("no key in config.json"); process.exit(2); }
const mask = (s) => (key ? String(s).split(key).join("[key]") : String(s));
const bridge = new CodexBridge();

try {
  const gemini = createAi({ provider, codex: bridge, gemini: () => createGemini({ key }) });
  const t0 = Date.now();
  const dir = path.join(dataDir(), "spike", "stories");
  const list = reuse && /^[\w-]+$/.test(reuse)
    ? JSON.parse(fs.readFileSync(path.join(dir, `${reuse}.json`), "utf8")).ideas
    : await ideas(gemini, topic);
  list.forEach((i, n) => console.log(`IDEA ${n}: ${i.title} — ${i.pitch}`));
  const idea = list[Number(pick)] ?? list[0];
  const story = await writeStory(gemini, idea, { minutes: 5, library: library() });
  const secs = estimateSeconds(story.pages);
  console.log(`\n# ${story.title}  (mood ${story.mood}, ${story.pages.length} pages, ~${secs.toFixed(0)} s, ${((Date.now() - t0) / 1000).toFixed(0)} s to write)`);
  console.log("time:", story.timeOfDay);
  console.log("props:", story.props.map((p) => `${p.id}: ${p.look}`).join(" | ") || "none");
  console.log("new sheets:", story.newSheets.map((n) => `${n.tag} (${n.kind}): ${n.description}`).join(" | ") || "none");
  story.pages.forEach((p, i) => {
    console.log(`\n[${i + 1}] (${[...p.narration].length} ch) @${p.location || "-"} cast=${p.cast.join(",")} props=${p.props.join(",")}\n${p.narration}\n  > ${p.scene}`);
  });
  console.log("\nproblems:", validateStory(story, { library: library() }));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fileId}.json`);
  fs.writeFileSync(file, JSON.stringify({ topic, ideas: list, idea, estimateSeconds: Math.round(secs * 10) / 10, story }, null, 2) + "\n");
  console.log("saved", file);
} catch (e) {
  console.error("FAILED", e?.code ?? "", mask(e?.message ?? e));
  process.exitCode = 1;
} finally {
  bridge.stop();
}
