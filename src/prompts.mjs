// Prompt builders: the creative heart of Kid Factory.
// Stories are plain everyday life: one ordinary routine that shows the habit as clear, copyable steps.
import fs from "node:fs";

const asset = (rel) => new URL(`../assets/${rel}`, import.meta.url);

let castCache = null;
/** Main cast + narrator voice, from assets/cast.json (mirrors assets/characters/characters.md). */
export function loadCast() {
  castCache ??= JSON.parse(fs.readFileSync(asset("cast.json"), "utf8"));
  return castCache;
}

let styleCache = null;
/** The art-style paragraph used in every page image prompt. */
export function loadStyle() {
  styleCache ??= fs.readFileSync(asset("style.md"), "utf8").trim();
  return styleCache;
}

export const NO_TEXT =
  "No text, letters, numbers, words, signs with writing or speech bubbles anywhere in the image.";

// Characters from the style-reference series that must never be reproduced.
export const FORBIDDEN_LOOKS = ["panda", "rabbit", "bunny", "penguin", "kappa"];

export const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, pitch: { type: "string" } },
        required: ["title", "pitch"],
      },
    },
  },
  required: ["ideas"],
};

export const STORY_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    mood: { type: "string", enum: ["bright", "calm", "playful"] },
    sideCharacters: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, look: { type: "string" } },
        required: ["id", "look"],
      },
    },
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          narration: { type: "string" },
          scene: { type: "string" },
          cast: { type: "array", items: { type: "string" } },
        },
        required: ["narration", "scene", "cast"],
      },
    },
  },
  required: ["title", "mood", "sideCharacters", "pages"],
};

const CAST_BRIEF = `- น้องปิ่นโต (id "pinto"): a cheerful, kind girl of about 6. She leads the story and shows how the habit is done. Narration calls her "ปิ่นโต".
- Her best friend (id "friend"): a boy of about 6. He has NO NAME. Never give him a name or a nickname. Narration calls him only "เพื่อน" or "เพื่อนของปิ่นโต"; in dialogue Pinto calls him "เพื่อน" too. He is friendly and does the habit together with Pinto.
- The cat (id "cat"): Pinto's small black cat with a red scarf, an ordinary house pet. Call it "แมวดำ" or "เจ้าแมวดำ"; never invent another name. It never talks. If it appears at all, it is just a normal cat in the background (sleeping, sitting, watching); it is never part of the plot.
- Their looks never change: same clothes in every page, and the cat always wears its red scarf (never lost, taken off or hidden). Small props in hand or a paper hat are fine; costumes that cover their clothes are not.`;

export function ideasPrompt(topic) {
  return `You are a gentle Thai children's storyteller planning simple teaching picture-book videos for children aged 4–10.
The stars are always the same:
${CAST_BRIEF}

Topic (a good habit or a simple life lesson): "${topic}"

Suggest exactly 3 story ideas for this topic. Each idea is one plain, realistic everyday situation from a child's day, and the 3 ideas happen in clearly different everyday settings, for example:
- one at home (getting up, a meal, bath time dressed, bedtime),
- one at school (class, lunch, play time),
- one with family (with mom, dad or grandma, a visit, a trip to the market).
Everyday life only: no magic, no pretend worlds, no talking objects or animals, no treasure hunts, mysteries, races or surprise twists.

For each idea give:
- title: a short, simple Thai title of 2 to 6 words.
- pitch: one short, plain Thai sentence that says what Pinto does in this everyday situation and which habit she shows.

Gentle and safe for small children, who copy what they watch: the characters only eat food an adult gives them (never plants they pick), are gentle with animals, never treat medicine as candy, never climb high or go near roads, water, fire, stoves, knives or electric sockets, and never go off alone or with strangers. If the topic is unsafe, scary or odd, quietly turn it into a gentle, kid-safe version of the same idea. The boy is never named.
Return JSON only.`;
}

/** Target page count and narration length per page that lands near `minutes` of video. */
export function storyTargets(budget, minutes = 5) {
  const pages = Math.max(budget.min, budget.max - 2);
  const narrSeconds = minutes * 60 - pages * 1.0 - (pages - 1) * 1.5;
  const chars = Math.round((narrSeconds * 11) / pages / 10) * 10;
  return { pages, chars: Math.min(chars, 300) };
}

export function storyPrompt(idea, budget, cast = loadCast(), minutes = 5) {
  const t = storyTargets(budget, minutes);
  const mainIds = cast.characters.map((c) => `"${c.id}"`).join(", ");
  return `You are a warm, gentle Thai children's storyteller. Write a picture book for children aged 4–10. It becomes a video: one picture per page, and one warm Thai female narrator reads every page aloud.

THE IDEA
Title: ${idea.title}
Pitch: ${idea.pitch}

THE MOST IMPORTANT RULE: PLAIN EVERYDAY LIFE THAT TEACHES ONE HABIT
- This is a simple teaching cartoon about realistic everyday life: home, school, family, meals, bedtime. No magic, no pretend worlds, no talking objects, talking animals or talking germs, no treasure hunts or mysteries, no surprise twists, no big silly moments.
- The story follows ONE ordinary routine around the topic, step by step, in the order it happens in a real day (for example for eating vegetables: Pinto wakes up, goes to school, opens her lunch box, finds vegetables and eats them).
- Show the habit as clear steps a child can copy, one step at a time (for example for brushing teeth: a little toothpaste, brush the top teeth, brush the bottom teeth, rinse).
- The narrator may teach directly in simple, gentle words: once or twice, a short reason why the habit is good (for example "แปรงฟันแล้วฟันจะไม่ปวดนะ"). Never scolding, never a long speech, no grown-up health facts.
- End with one short closing lesson line on the last page, warm and simple.
- Calm, small, real stakes only; nothing scary or sad. No sweets, toys or prizes as a reward for doing the habit.
- Story shape:
  1. Start (pages 1–2): Pinto's ordinary day begins (waking up, getting ready, arriving somewhere). A simple, calm opening; no "กาลครั้งหนึ่ง".
  2. The everyday moment where the habit comes up.
  3. Pinto (and her friend) do the habit, step by step, over several pages, with a short reason why it is good.
  4. A small, real good result (clean hands, a full tummy, feeling fresh, ready for bed).
  5. A cosy ending and one short closing lesson line.

THE CHARACTERS (the same in every episode)
${CAST_BRIEF}
- Side characters are optional and are ordinary people (for example แม่, พ่อ, คุณครู, ยาย, classmates). At most 3. Give each a short lowercase English id (like "mom", "teacher", "grandma") and a "look": a short English visual description (who or what it is, age or species, colours, clothes) so the illustrator draws it the same on every page. Never use pandas, rabbits, penguins, kappa or a second cat.

HOW THE THAI MUST SOUND (it is read aloud)
- Natural spoken Thai that a 4-year-old understands, the way a loving Thai mother tells a bedtime story. Short sentences, one idea each.
- Plain, calm words. No chants, no repeated catchphrases, no playful noise words, no jokes.
- Sometimes talk to the listener gently (for example "หนูล้างมือแบบนี้ได้ไหมคะ") but not on every page.
- A little simple dialogue in quotation marks is fine; make clear who is speaking.
- Write numbers as Thai words. No English words, no emoji, no brackets, no lists, no stage directions: only what the narrator says.
- Vary how pages begin; do not start every page with a name.

PAGES
- Write between ${budget.min} and ${budget.max} pages; aim for about ${t.pages} pages.
- Each page is ONE clear moment that can be drawn as a single picture. Give the pictures variety: change the action, the spot or the view from page to page, and when the story allows, move through two or three different places.
- narration: Thai, between ${t.chars - 10} and ${t.chars + 40} characters (about 4 to 6 short sentences). Too short makes the video too short; too long makes it drag. Never more than 380 characters.
- scene: English, for the illustrator. ALWAYS begin with the exact location (for example "In the bathroom at Pinto's home, beside the sink, ..."), even when it is the same place as the page before; never leave the location unsaid. In scenes call the boy "the friend" (never "Friend" as a name). Then say who is there, where they stand, what they are doing, their expressions, and the key objects. One frozen moment, not a sequence. Never ask for written words, letters, numbers or signs.
- cast: ids of every character visible in the picture: ${mainIds}, or your side-character ids. Pinto is in almost every page.

SAFETY
- Gentle and safe for ages 4–10. If the idea is scary, unsafe, unclear or odd, quietly turn it into a gentle, kid-safe version of the same topic. No violence, no shaming anyone, no real brands, no real people.
- Children copy what they watch, so the characters never do anything unsafe, not even as a joke or a mistake:
  - They only eat food an adult gives them or that comes washed from the kitchen or from an adult's basket. They never eat leaves, flowers, berries, mushrooms or plants they pick themselves, and never eat anything straight from the soil.
  - No medicine or vitamins treated as candy or a game.
  - Be gentle with animals: no pulling tails, no chasing to grab them, no squeezing, lifting roughly or dressing them up. The children only pet the cat softly.
  - No climbing high places (shelves, trees, furniture, windows). Nothing near roads, water, fire, stoves, knives or electric sockets.
  - They never go off alone or with strangers.
  - An adult is nearby whenever food is picked, cut or cooked.
- The pictures show children: nobody is ever undressed, in underwear or in the bath without clothes, and there are no underwear or toilet jokes.

ALSO
- title: a short, catchy Thai title (it may improve on the idea's title).
- mood: "bright", "calm" or "playful", whichever background music fits best.

Return JSON only.`;
}

export function retryNote(problems) {
  return `

YOUR PREVIOUS DRAFT WAS REJECTED. Write the whole story again and fix these problems:
${problems.map((p) => `- ${p}`).join("\n")}`;
}

const MOOD_WORDS = {
  bright: "bright, sunny and cheerful",
  calm: "calm, soft and cosy",
  playful: "playful, lively and fun",
};

function describe(id, story, cast) {
  const main = cast.characters.find((c) => c.id === id);
  if (main) {
    const who = { pinto: "Pinto (the girl)", friend: "Pinto's friend (the boy)", cat: "Pinto's black cat" }[id] ?? id;
    const outfit = main.outfit ? ` Outfit: ${main.outfit}` : "";
    return `- ${who}: ${main.look}${outfit} Exactly as in the reference sheet.`;
  }
  const side = (story.sideCharacters ?? []).find((c) => c.id === id);
  return side ? `- ${id}: ${side.look} Same art style as the main characters.` : null;
}

/** The image prompt for one page. */
export const SAFE_DRESS =
  "Characters are always fully dressed in their fixed outfits; no nudity, and no bathing or toilet scenes shown in detail.";

export function imagePrompt(page, story, style = loadStyle(), cast = loadCast()) {
  const people = (page.cast ?? []).map((id) => describe(id, story, cast)).filter(Boolean);
  const who = people.length
    ? `Characters in this picture (draw only these, each exactly as described):\n${people.join("\n")}`
    : "No characters in this picture, only the place.";
  const mood = MOOD_WORDS[story.mood] ?? MOOD_WORDS.bright;
  return `${style}

Scene (draw this place exactly as described, do not move it elsewhere): ${page.scene}

${who}

Mood: ${mood}.
${SAFE_DRESS}
${NO_TEXT}`;
}
