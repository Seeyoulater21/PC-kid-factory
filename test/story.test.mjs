import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { GeminiError, MODELS } from "../src/gemini.mjs";
import {
  ideas, writeStory, validateStory, pageBudget, estimateSeconds, imagePrompt,
} from "../src/story.mjs";
import { loadCast, loadStyle, NO_TEXT, DOT_EYES, storyPrompt, ideasPrompt, sheetPrompt } from "../src/prompts.mjs";

// The starting library (characters pinto, friend, mom, cat; places bedroom, living-room, bathroom, dining-room).
const LIB = JSON.parse(fs.readFileSync(new URL("../assets/sheets.json", import.meta.url), "utf8"));
const validate = (s, o = {}) => validateStory(s, { library: LIB, ...o });
const write = (g, i, o = {}) => writeStory(g, i, { library: LIB, ...o });

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
    location: "living-room",
    props: [],
    ...extra,
  };
}
function story(n = 14, patch = {}) {
  return {
    title: "ฟองสบู่วิเศษ",
    mood: "playful",
    timeOfDay: "morning, soft daylight",
    props: [{ id: "soap", look: "a round pink bar of soap" }],
    newSheets: [{ tag: "grandma", kind: "character", name: "ยาย", description: "Thai grandmother about 65, short grey hair, purple blouse" }],
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
  assert.deepEqual(validate(story(14)), []);
});

test("validateStory flags 21 pages", () => {
  const p = validate(story(21));
  assert.ok(p.some((m) => /21 pages/.test(m)), p.join("; "));
});

test("validateStory flags 11 pages", () => {
  const p = validate(story(11));
  assert.ok(p.some((m) => /11 pages/.test(m)), p.join("; "));
});

test("validateStory uses the budget for the requested minutes", () => {
  assert.deepEqual(validate(story(8), { minutes: 3 }), []);
  assert.ok(validate(story(14), { minutes: 3 }).length > 0);
});

test("validateStory flags empty narration", () => {
  const s = story(14);
  s.pages[3].narration = "   ";
  const p = validate(s);
  assert.ok(p.some((m) => /page 4/.test(m) && /narration/.test(m)), p.join("; "));
});

test("validateStory flags a cast id that is neither main nor side character", () => {
  const s = story(14);
  s.pages[2].cast = ["pinto", "teacher"];
  const p = validate(s);
  assert.ok(p.some((m) => /page 3/.test(m) && /teacher/.test(m)), p.join("; "));
});

test("validateStory accepts a library character and a newSheets character in cast", () => {
  const s = story(14);
  s.pages[2].cast = ["pinto", "mom", "grandma"];
  assert.deepEqual(validate(s), []);
});

test("validateStory: location must be a library place, a newSheets place, or empty; props must be declared", () => {
  const s = story(14);
  s.pages[0].location = "school";
  s.pages[1].props = ["spoon"];
  const p = validate(s).join("; ");
  assert.match(p, /page 1: location "school"/);
  assert.match(p, /page 2: prop "spoon"/);
  s.newSheets.push({ tag: "school", kind: "place", name: "โรงเรียน", description: "a small school building" });
  s.pages[1].props = ["soap"];
  s.pages[2].location = "";
  assert.deepEqual(validate(s), []);
});

test("validateStory flags a bad new sheet tag and a missing time of day", () => {
  const s = story(14, { timeOfDay: "" });
  s.newSheets.push({ tag: "คุณครู", kind: "character", name: "ครู", description: "x" });
  const p = validate(s).join("; ");
  assert.match(p, /timeOfDay/);
  assert.match(p, /lowercase English/);
});

test("writeStory drops a new sheet the library already has, so the existing sheet is reused", async () => {
  const s = story(14);
  s.newSheets.push({ tag: "Mom", kind: "character", name: "แม่", description: "a different mother" });
  s.pages[0].cast = ["pinto", "mom"];
  const out = await write(fakeGemini([s]), idea(1));
  assert.deepEqual(out.newSheets.map((n) => n.tag), ["grandma"]);
  assert.deepEqual(out.pages[0].cast, ["pinto", "mom"]);
});

test("validateStory flags narration over 400 chars", () => {
  const s = story(14);
  s.pages[5].narration = "ก".repeat(401);
  const p = validate(s);
  assert.ok(p.some((m) => /page 6/.test(m) && /400/.test(m)), p.join("; "));
});

test("validateStory flags letters from other scripts in narration (TTS would misread them)", () => {
  const s = story(14);
  s.pages[4].narration = "ฟองสบู่ লอยละลิ่ว";
  s.pages[6].narration = "ปิ่นโตพูดว่า OK";
  const p = validate(s).join("; ");
  assert.match(p, /page 5.*non-Thai/);
  assert.match(p, /page 7.*non-Thai/);
  s.pages[4].narration = "\"เมี้ยว!\" ฟองฟู่ๆ... 3 ลูก";
  s.pages[6].narration = "ปิ่นโต";
  assert.deepEqual(validate(s), []);
});

test("validateStory flags missing scene, bad mood, missing title, empty cast", () => {
  const s = story(14, { mood: "angry", title: "" });
  s.pages[0].scene = "";
  s.pages[1].cast = [];
  const p = validate(s).join("; ");
  assert.match(p, /mood/);
  assert.match(p, /title/);
  assert.match(p, /page 1.*scene/);
  assert.match(p, /page 2.*cast/);
});

test("validateStory flags a story where Pinto never appears", () => {
  const s = story(14);
  for (const pg of s.pages) pg.cast = ["friend"];
  assert.ok(validate(s).some((m) => /pinto/i.test(m)));
});

test("validateStory flags new sheets that reuse a library tag or look like reference characters", () => {
  const s = story(14, {
    newSheets: [
      { tag: "cat", kind: "character", name: "แมว", description: "another cat" },
      { tag: "bird", kind: "character", name: "นก", description: "a small penguin with a scarf" },
    ],
  });
  const p = validate(s).join("; ");
  assert.match(p, /cat/);
  assert.match(p, /penguin/);
});

test("validateStory handles garbage without throwing", () => {
  assert.ok(validate(null).length > 0);
  assert.ok(validate({}).length > 0);
  assert.ok(validate({ pages: [null] }).length > 0);
});

// ---------- writeStory ----------

test("writeStory uses the story model and returns a valid story", async () => {
  const g = fakeGemini([story(16)]);
  const s = await write(g, idea(1), { minutes: 5 });
  assert.equal(s.pages.length, 16);
  assert.equal(g.calls[0].model, MODELS.story);
  assert.match(g.calls[0].prompt, /เรื่อง 1/);
  assert.match(g.calls[0].prompt, /12/);
  assert.match(g.calls[0].prompt, /20/);
});

test("writeStory strips markdown emphasis from narration but keeps the words", async () => {
  const s = story(16);
  s.pages[0].narration = "เพื่อนกระโดด *ฟุ่บ!* แล้ว **ปี๊บ!**";
  s.pages[1].narration = "กบ _ก๊าบ_ ร้องดัง";
  const g = fakeGemini([s]);
  const out = await write(g, idea(1), { minutes: 5 });
  assert.equal(out.pages[0].narration, "เพื่อนกระโดด ฟุ่บ! แล้ว ปี๊บ!");
  assert.equal(out.pages[1].narration, "กบ ก๊าบ ร้องดัง");
});

test("writeStory retries once on an invalid story then succeeds", async () => {
  const g = fakeGemini([story(25), story(15)]);
  const s = await write(g, idea(1), {});
  assert.equal(g.calls.length, 2);
  assert.equal(s.pages.length, 15);
  // the retry tells the model what was wrong
  assert.match(g.calls[1].prompt, /25 pages/);
});

test("writeStory throws GeminiError empty with Thai message after a second invalid result", async () => {
  const g = fakeGemini([story(25), story(3)]);
  await assert.rejects(write(g, idea(1)), (e) => {
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
  const s = await write(g, idea(1));
  assert.equal(s.title, "ฟองสบู่วิเศษ");
  assert.equal(s.pages[0].narration, "สวัสดีค่ะ");
});

// ---------- prompts ----------

test("story prompt sets the plain everyday-lesson rules", () => {
  const p = storyPrompt(idea(1), pageBudget(5), LIB);
  assert.match(p, /ปิ่นโต/);
  assert.match(p, /เพื่อนของปิ่นโต/);
  assert.match(p, /4.{0,3}10/);
  assert.match(p, /location/i);
  assert.match(p, /never/i);
  const low = p.toLowerCase();
  for (const phrase of ["everyday", "routine", "no magic", "no pretend worlds", "talking objects", "no treasure hunts", "no surprise twists", "steps a child can copy", "closing lesson", "never scolding"]) {
    assert.ok(low.includes(phrase), `story prompt missing: ${phrase}`);
  }
  for (const old of ["must be fun", "refrain", "sound words", "real surprise twist", "talking toothbrush", "tiny germ", "never end with a moral"]) {
    assert.ok(!low.includes(old), `story prompt still has: ${old}`);
  }
});

test("cast brief keeps the cat an ordinary pet", () => {
  for (const p of [ideasPrompt("กินผัก"), storyPrompt(idea(1), pageBudget(5), LIB)]) {
    const low = p.toLowerCase();
    for (const old of ["steals", "clue", "partner for jokes", "funny trouble"]) {
      assert.ok(!low.includes(old), `prompt still has: ${old}`);
    }
  }
});

test("story prompt spells out the child-safety rules kids could copy", () => {
  const p = storyPrompt(idea(1), pageBudget(5), LIB).toLowerCase();
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

test("validateStory flags a new character that is another cat", () => {
  const sheet = (description) => [{ tag: "neighbor", kind: "character", name: "เพื่อนบ้าน", description }];
  for (const look of ["a grey kitten with a bell", "an orange tabby cat", "two cats"]) {
    const s = story(14, { newSheets: sheet(look) });
    assert.ok(validate(s).some((m) => /neighbor/.test(m) && /cat/.test(m)), look);
  }
  const ok = story(14, { newSheets: sheet("a small blue bird, catching a seed") });
  assert.deepEqual(validate(ok), []);
});

test("ideas prompt asks for 3 plain everyday situations", () => {
  const p = ideasPrompt("ล้างมือ");
  assert.match(p, /3|three/i);
  assert.match(p, /ล้างมือ/);
  const low = p.toLowerCase();
  for (const phrase of ["everyday", "no magic", "no talking objects", "no treasure hunts"]) {
    assert.ok(low.includes(phrase), `ideas prompt missing: ${phrase}`);
  }
  for (const old of ["imaginative twist", "magic surprise", "mystery", "fun first"]) {
    assert.ok(!low.includes(old), `ideas prompt still has: ${old}`);
  }
});

test("cast.json holds the narrator voice; the starting library has the 4 characters and 4 places", () => {
  const c = loadCast();
  assert.equal(c.voice, "en-us-sola");
  assert.match(c.voiceStyle, /Thai/);
  const md = fs.readFileSync(new URL("../assets/characters/characters.md", import.meta.url), "utf8");
  assert.ok(md.includes(`voice_style: ${c.voiceStyle}`), "characters.md voice_style differs from cast.json");
  assert.deepEqual(LIB.map((x) => x.tag), ["pinto", "friend", "mom", "cat", "bedroom", "living-room", "bathroom", "dining-room"]);
  for (const x of LIB) assert.ok(x.name && x.description.length > 20 && ["character", "place"].includes(x.kind));
  assert.ok(!/eyes/i.test(LIB.find((x) => x.tag === "cat").description), "the cat's eyes come from the dot-eye rule");
});

test("story prompt lists the library by tag and asks to reuse tags, add newSheets, one time of day and fixed props", () => {
  const p = storyPrompt(idea(1), pageBudget(5), LIB);
  for (const x of LIB) assert.ok(p.includes(`"${x.tag}" (${x.name})`), x.tag);
  assert.match(p, /Reuse a library tag whenever it fits: a teacher is always "teacher"/);
  assert.match(p, /newSheets/);
  assert.match(p, /ONE part of the day/);
  assert.match(p, /props/);
  assert.match(p, /never write "wide eyes"/);
});

test("sheet prompts: characters get turnaround views and expressions, places are empty; all have the house theme", () => {
  const ch = sheetPrompt(LIB[0]);
  assert.match(ch, /front view, a side view and a back view/);
  assert.match(ch, /expressions/);
  const pl = sheetPrompt(LIB[4]);
  assert.match(pl, /empty place with nobody in it/);
  for (const p of [ch, pl]) {
    assert.ok(p.includes(DOT_EYES) && p.includes(loadStyle()) && p.includes(NO_TEXT));
  }
});

const FORBIDDEN = ["green cap panda", "pink rabbit", "penguin", "kappa"];

test("imagePrompt has the house theme, every cast member's look, the place, time, props, scene and the no-text rule", () => {
  const style = loadStyle();
  const s = story(14);
  const pg = { ...page(1), cast: ["pinto", "cat", "grandma"], location: "dining-room", props: ["soap"] };
  const lib = [...LIB, { ...s.newSheets[0] }];
  const p = imagePrompt(pg, s, lib, style);
  assert.ok(p.includes(style), "style text");
  assert.ok(p.includes(DOT_EYES), "dot eyes");
  assert.ok(p.includes(pg.scene), "scene");
  assert.ok(p.includes(NO_TEXT), "no-text phrase");
  assert.match(p, /fully dressed in their fixed outfits; no nudity, and no bathing or toilet scenes/);
  for (const tag of ["pinto", "cat", "grandma"]) assert.ok(p.includes(lib.find((x) => x.tag === tag).description), `${tag} look`);
  assert.ok(p.includes(LIB.find((x) => x.tag === "dining-room").description), "place");
  assert.match(p, /Time of day and light \(the same on every page\): morning, soft daylight/);
  assert.match(p, /soap: a round pink bar of soap/);
  // characters not on the page are not described
  assert.ok(!p.includes(LIB.find((x) => x.tag === "friend").description));
  const low = p.toLowerCase();
  for (const w of FORBIDDEN) assert.ok(!low.includes(w), `mentions ${w}`);
});

test("imagePrompt of an episode from before the library still describes its side characters and main cast", () => {
  const old = { title: "t", mood: "calm", sideCharacters: [{ id: "teacher", look: "a kind teacher in blue" }], pages: [] };
  const p = imagePrompt({ scene: "In the classroom", cast: ["pinto", "teacher"] }, old, []);
  assert.match(p, /a kind teacher in blue/);
  assert.match(p, /Pinto \(the girl\)/);
});
