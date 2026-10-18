// Prompt builders: the creative heart of Kid Factory.
// Stories must be FUN first: the habit rides on a small adventure, never a lecture.
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

const CAST_BRIEF = `- น้องปิ่นโต (id "pinto"): a cheerful, curious, brave girl of about 6. She leads the story and she is the one who has the clever idea. Narration calls her "ปิ่นโต".
- Her best friend (id "friend"): a boy of about 6. He has NO NAME. Never give him a name or a nickname. Narration calls him only "เพื่อน" or "เพื่อนของปิ่นโต"; in dialogue Pinto calls him "เพื่อน" too. He is a bit silly and easily excited, a great partner for jokes.
- The cat (id "cat"): Pinto's small black cat with a red scarf. Call it "แมวดำ" or "เจ้าแมวดำ"; never invent another name. It never talks in words. It says "เมี้ยว" and acts: pounces, hides, steals things, gets into funny trouble, and often finds the clue.
- Their looks never change: same clothes in every page, and the cat always wears its red scarf (never lost, taken off or hidden). Small props in hand or a paper hat are fine; costumes that cover their clothes are not.`;

export function ideasPrompt(topic) {
  return `You are a playful Thai children's storyteller planning picture-book videos for children aged 4–10.
The stars are always the same:
${CAST_BRIEF}

Topic (a good habit or a simple life lesson): "${topic}"

Suggest exactly 3 story ideas for this topic. The 3 ideas must be clearly different from each other in setting and kind of fun, for example:
- one everyday adventure at home, at school or outdoors with a funny problem,
- one imaginative twist (pretend play, a tiny world, a talking object, a magic surprise),
- one playful game, challenge or little mystery (a race, a hunt, something missing).

For each idea give:
- title: a short, catchy Thai title of 2 to 6 words.
- pitch: one short Thai sentence that makes a child say "อยากฟัง!": show the fun problem or surprise, not the moral.

Fun first, never a lecture. Gentle and safe for small children, who copy what they watch: the characters only eat food an adult gives them (never plants they pick), are gentle with animals, never treat medicine as candy, never climb high or go near roads, water, fire or knives, and never go off alone or with strangers. If the topic is unsafe, scary or odd, quietly turn it into a gentle, kid-safe version of the same idea. The boy is never named.
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
  return `You are a warm, playful Thai children's storyteller. Write a picture book for children aged 4–10. It becomes a video: one picture per page, and one warm Thai female narrator reads every page aloud.

THE IDEA
Title: ${idea.title}
Pitch: ${idea.pitch}

THE MOST IMPORTANT RULE: IT MUST BE FUN
- This is an adventure, not a lesson. Children should giggle, gasp and want to know what happens next.
- The good habit is shown through what the characters DO and what happens because of it. The narrator never preaches. Never write lines like "เด็กๆ ต้อง...", "เราควร...", "นิทานเรื่องนี้สอนให้รู้ว่า", and never end with a moral. Never say why the habit is good in adult words (no germs-cause-disease explanations, no health facts).
- Story shape:
  1. Hook (pages 1–2): jump straight into something fun or curious. No "กาลครั้งหนึ่ง", no slow introductions.
  2. A problem that matters to the characters appears.
  3. They try something that goes wrong in a really funny way: a big silly moment (something slippery, a giant mess, a chase, the cat doing something unexpected).
  4. A real surprise twist the listener does not see coming, something that changes the situation (not just a small joke).
  5. Pinto has the idea that fixes it, and the good habit is the key that makes it work. Let the characters enjoy doing the habit (a game, a song, a race), so children want to copy it. The fun of doing it is the reward: no sweets, toys or prizes as a bribe for doing the habit.
  6. A happy, cosy ending with one last funny or warm beat; a callback to an earlier joke is great.
- Small, safe stakes only (a lost toy, a party, a race, a mystery); never scary or sad for long.

THE CHARACTERS (the same in every episode)
${CAST_BRIEF}
- Side characters are optional (for example แม่, พ่อ, คุณครู, ยาย, a puppy, a bird, a tiny germ, a talking toothbrush). At most 3. Give each a short lowercase English id (like "mom", "teacher", "germ") and a "look": a short English visual description (who or what it is, age or species, colours, clothes) so the illustrator draws it the same on every page. Never use pandas, rabbits, penguins, kappa or a second cat.

HOW THE THAI MUST SOUND (it is read aloud)
- Natural spoken Thai that a 4-year-old understands, the way a loving Thai mother tells a bedtime story. Short sentences, one idea each.
- Use playful sound words (like ซู่ซ่า, ปุ๊บปั๊บ, ตุ้บ, ฟึ่บ, กรุ๊งกริ๊ง, จ๊ะเอ๋) and a bit of rhythm.
- Invent ONE short, catchy refrain (a chant, a magic phrase or a little song line) that comes back at least 3 times, so children can say it along.
- Sometimes talk to the listener (for example "หนูว่า...อยู่ไหนนะ") but not on every page.
- Lively dialogue in quotation marks, and make clear who is speaking.
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
  - Be gentle with animals: no pulling tails, no chasing to grab them, no squeezing, lifting roughly or dressing them up. The cat chases them or plays on its own; the children only pet it softly.
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
