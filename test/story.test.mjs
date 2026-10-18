import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiError, MODELS } from "../src/gemini.mjs";
import {
  ideas, writeStory, validateStory, pageBudget, estimateSeconds, imagePrompt,
} from "../src/story.mjs";
import { loadCast, loadStyle, NO_TEXT, storyPrompt, ideasPrompt } from "../src/prompts.mjs";

// Fake gemini: returns queued results in order and records every call.
function fakeGemini(results) {
  const calls = [];
  return {
    calls,
    async json(model, prompt, schema) {
      calls.push({ model, prompt, schema });
      const r = results[Math.min(calls.length - 1, results.length - 1)];
      if (r instanceof Error) throw r;
      return structuredClone(r);
    },
  };
}

const idea = (n) => ({ title: `เรื่อง ${n}`, pitch: `ปิ่นโตผจญภัยครั้งที่ ${n}` });

function page(i, extra = {}) {
  return {
    narration: `ปิ่นโตกับเพื่อนเดินไปที่สวน หน้า ${i} ฟองสบู่ลอยฟู่ฟ่า`,
    scene: `In the garden behind Pinto's home, Pinto and the friend chase soap bubbles (page ${i}).`,
    cast: ["pinto", "friend", "cat"],
    ...extra,
  };
}
function story(n = 14, patch = {}) {
  return {
    title: "ฟองสบู่วิเศษ",
    mood: "playful",
    sideCharacters: [{ id: "mom", look: "Thai woman about 35, black hair in a low bun, green apron" }],
    pages: Array.from({ length: n }, (_, i) => page(i + 1)),
    ...patch,
  };
}

// ---------- ideas ----------

test("ideas returns exactly 3 ideas using the ideas model", async () => {
  const g = fakeGemini([{ ideas: [idea(1), idea(2), idea(3)] }]);
  const out = await ideas(g, "ล้างมือ");
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], idea(1));
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].model, MODELS.ideas);
  assert.match(g.calls[0].prompt, /ล้างมือ/);
});

test("ideas retries when the model returns 2, then succeeds", async () => {
  const g = fakeGemini([{ ideas: [idea(1), idea(2)] }, { ideas: [idea(4), idea(5), idea(6)] }]);
  const out = await ideas(g, "แปรงฟัน");
  assert.equal(g.calls.length, 2);
  assert.deepEqual(out.map((i) => i.title), ["เรื่อง 4", "เรื่อง 5", "เรื่อง 6"]);
});

test("ideas rejects with GeminiError empty when the model keeps returning 2", async () => {
  const g = fakeGemini([{ ideas: [idea(1), idea(2)] }]);
  await assert.rejects(ideas(g, "กินผัก"), (e) => {
    assert.ok(e instanceof GeminiError);
    assert.equal(e.code, "empty");
    assert.equal(typeof e.thai, "string");
    return true;
  });
  assert.equal(g.calls.length, 2);
});

test("ideas drops ideas with an empty title or pitch", async () => {
  const g = fakeGemini([
    { ideas: [idea(1), { title: " ", pitch: "x" }, idea(3)] },
    { ideas: [idea(7), idea(8), idea(9)] },
  ]);
  const out = await ideas(g, "เก็บของเล่น");
  assert.equal(g.calls.length, 2);
  assert.equal(out[0].title, "เรื่อง 7");
});

test("ideas lets other Gemini errors through", async () => {
  const g = fakeGemini([new GeminiError("credit", "no money")]);
  await assert.rejects(ideas(g, "ล้างมือ"), (e) => e.code === "credit");
});

// ---------- budget / estimate ----------

test("pageBudget follows about 4 pages per minute", () => {
  assert.deepEqual(pageBudget(5), { min: 12, max: 20 });
  assert.deepEqual(pageBudget(3), { min: 7, max: 12 });
});

test("estimateSeconds: 18 pages x 210 chars = 387.1 s", () => {
  const pages = Array.from({ length: 18 }, () => ({ narration: "ก".repeat(210), scene: "", cast: [] }));
  const s = estimateSeconds(pages);
  assert.ok(Math.abs(s - 387.1) <= 0.5, `got ${s}`);
});

test("estimateSeconds of no pages is 0", () => {
  assert.equal(estimateSeconds([]), 0);
});

// ---------- validateStory ----------

test("validateStory accepts a good story", () => {
  assert.deepEqual(validateStory(story(14)), []);
});

test("validateStory flags 21 pages", () => {
  const p = validateStory(story(21));
  assert.ok(p.some((m) => /21 pages/.test(m)), p.join("; "));
});

test("validateStory flags 11 pages", () => {
  const p = validateStory(story(11));
  assert.ok(p.some((m) => /11 pages/.test(m)), p.join("; "));
});

test("validateStory uses the budget for the requested minutes", () => {
  assert.deepEqual(validateStory(story(8), { minutes: 3 }), []);
  assert.ok(validateStory(story(14), { minutes: 3 }).length > 0);
});

test("validateStory flags empty narration", () => {
  const s = story(14);
  s.pages[3].narration = "   ";
  const p = validateStory(s);
  assert.ok(p.some((m) => /page 4/.test(m) && /narration/.test(m)), p.join("; "));
});

test("validateStory flags a cast id that is neither main nor side character", () => {
  const s = story(14);
  s.pages[2].cast = ["pinto", "teacher"];
  const p = validateStory(s);
  assert.ok(p.some((m) => /page 3/.test(m) && /teacher/.test(m)), p.join("; "));
});

test("validateStory accepts a declared side character in cast", () => {
  const s = story(14);
  s.pages[2].cast = ["pinto", "mom"];
  assert.deepEqual(validateStory(s), []);
});

test("validateStory flags narration over 400 chars", () => {
  const s = story(14);
  s.pages[5].narration = "ก".repeat(401);
  const p = validateStory(s);
  assert.ok(p.some((m) => /page 6/.test(m) && /400/.test(m)), p.join("; "));
});

test("validateStory flags letters from other scripts in narration (TTS would misread them)", () => {
  const s = story(14);
  s.pages[4].narration = "ฟองสบู่ লอยละลิ่ว";
  s.pages[6].narration = "ปิ่นโตพูดว่า OK";
  const p = validateStory(s).join("; ");
  assert.match(p, /page 5.*non-Thai/);
  assert.match(p, /page 7.*non-Thai/);
  s.pages[4].narration = "\"เมี้ยว!\" ฟองฟู่ๆ... 3 ลูก";
  s.pages[6].narration = "ปิ่นโต";
  assert.deepEqual(validateStory(s), []);
});

test("validateStory flags missing scene, bad mood, missing title, empty cast", () => {
  const s = story(14, { mood: "angry", title: "" });
  s.pages[0].scene = "";
  s.pages[1].cast = [];
  const p = validateStory(s).join("; ");
  assert.match(p, /mood/);
  assert.match(p, /title/);
  assert.match(p, /page 1.*scene/);
  assert.match(p, /page 2.*cast/);
});

test("validateStory flags a story where Pinto never appears", () => {
  const s = story(14);
  for (const pg of s.pages) pg.cast = ["friend"];
  assert.ok(validateStory(s).some((m) => /pinto/i.test(m)));
});

test("validateStory flags side characters that reuse a main id or look like reference characters", () => {
  const s = story(14, {
    sideCharacters: [
      { id: "cat", look: "another cat" },
      { id: "bird", look: "a small penguin with a scarf" },
    ],
  });
  const p = validateStory(s).join("; ");
  assert.match(p, /cat/);
  assert.match(p, /penguin/);
});

test("validateStory handles garbage without throwing", () => {
  assert.ok(validateStory(null).length > 0);
  assert.ok(validateStory({}).length > 0);
  assert.ok(validateStory({ pages: [null] }).length > 0);
});

// ---------- writeStory ----------

test("writeStory uses the story model and returns a valid story", async () => {
  const g = fakeGemini([story(16)]);
  const s = await writeStory(g, idea(1), { minutes: 5 });
  assert.equal(s.pages.length, 16);
  assert.equal(g.calls[0].model, MODELS.story);
  assert.match(g.calls[0].prompt, /เรื่อง 1/);
  assert.match(g.calls[0].prompt, /12/);
  assert.match(g.calls[0].prompt, /20/);
});

test("writeStory retries once on an invalid story then succeeds", async () => {
  const g = fakeGemini([story(25), story(15)]);
  const s = await writeStory(g, idea(1), {});
  assert.equal(g.calls.length, 2);
  assert.equal(s.pages.length, 15);
  // the retry tells the model what was wrong
  assert.match(g.calls[1].prompt, /25 pages/);
});

test("writeStory throws GeminiError empty with Thai message after a second invalid result", async () => {
  const g = fakeGemini([story(25), story(3)]);
  await assert.rejects(writeStory(g, idea(1)), (e) => {
    assert.ok(e instanceof GeminiError);
    assert.equal(e.code, "empty");
    assert.equal(e.thai, "เขียนเรื่องไม่สำเร็จ ลองใหม่");
    return true;
  });
  assert.equal(g.calls.length, 2);
});

test("writeStory trims text fields", async () => {
  const s0 = story(14);
  s0.title = "  ฟองสบู่วิเศษ  ";
  s0.pages[0].narration = "  สวัสดีค่ะ  ";
  const g = fakeGemini([s0]);
  const s = await writeStory(g, idea(1));
  assert.equal(s.title, "ฟองสบู่วิเศษ");
  assert.equal(s.pages[0].narration, "สวัสดีค่ะ");
});

// ---------- prompts ----------

test("story prompt sets the fun-story rules", () => {
  const p = storyPrompt(idea(1), pageBudget(5), loadCast());
  assert.match(p, /ปิ่นโต/);
  assert.match(p, /เพื่อนของปิ่นโต/);
  assert.match(p, /4.{0,3}10/);
  assert.match(p, /location/i);
  assert.match(p, /never/i);
});

test("story prompt spells out the child-safety rules kids could copy", () => {
  const p = storyPrompt(idea(1), pageBudget(5), loadCast()).toLowerCase();
  for (const phrase of [
    "only eat food an adult gives",           // food from an adult / kitchen
    "never eat leaves, flowers, berries, mushrooms or plants", // no foraging
    "medicine or vitamins",                   // not candy
    "gentle with animals",                    // no tail pulling / grabbing
    "pulling tails",
    "no climbing high places",
    "roads, water, fire, stoves, knives or electric sockets",
    "never go off alone or with strangers",
    "an adult is nearby whenever food is picked, cut or cooked",
  ]) assert.ok(p.includes(phrase), `story prompt missing: ${phrase}`);
});

test("ideas prompt carries the short safety rules", () => {
  const p = ideasPrompt("กินผัก").toLowerCase();
  for (const phrase of ["food an adult gives", "gentle with animals", "medicine", "strangers"]) {
    assert.ok(p.includes(phrase), `ideas prompt missing: ${phrase}`);
  }
});

test("validateStory flags a side character that is another cat", () => {
  for (const look of ["a grey kitten with a bell", "an orange tabby cat", "two cats"]) {
    const s = story(14, { sideCharacters: [{ id: "neighbor", look }] });
    assert.ok(validateStory(s).some((m) => /neighbor/.test(m) && /cat/.test(m)), look);
  }
  const ok = story(14, { sideCharacters: [{ id: "bird", look: "a small blue bird, catching a seed" }] });
  assert.deepEqual(validateStory(ok), []);
});

test("ideas prompt asks for 3 different angles", () => {
  const p = ideasPrompt("ล้างมือ");
  assert.match(p, /3|three/i);
  assert.match(p, /ล้างมือ/);
});

test("loadCast mirrors characters.md", () => {
  const c = loadCast();
  assert.deepEqual(c.characters.map((x) => x.id), ["pinto", "friend", "cat"]);
  assert.equal(c.voice, "en-us-sola");
  for (const ch of c.characters) {
    assert.ok(ch.look.length > 10);
    assert.match(ch.sheet, /^assets\/characters\/\w+\.jpg$/);
  }
  assert.match(c.voiceStyle, /Thai/);
});

const FORBIDDEN = ["green cap panda", "pink rabbit", "penguin", "kappa"];

test("imagePrompt has style, every cast member's look, the scene and the no-text rule", () => {
  const style = loadStyle();
  const cast = loadCast();
  const s = story(14);
  const pg = { ...page(1), cast: ["pinto", "cat", "mom"] };
  const p = imagePrompt(pg, s, style);
  assert.ok(p.includes(style), "style text");
  assert.ok(p.includes(pg.scene), "scene");
  assert.ok(p.includes(NO_TEXT), "no-text phrase");
  for (const id of ["pinto", "cat"]) {
    const ch = cast.characters.find((c) => c.id === id);
    assert.ok(p.includes(ch.look), `${id} look`);
  }
  assert.ok(p.includes(s.sideCharacters[0].look), "side character look");
  // characters not on the page are not described
  assert.ok(!p.includes(cast.characters.find((c) => c.id === "friend").look));
  const low = p.toLowerCase();
  for (const w of FORBIDDEN) assert.ok(!low.includes(w), `mentions ${w}`);
});
