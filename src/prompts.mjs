// Prompt builders: the creative heart of Kid Factory.
// Stories are plain everyday life: one ordinary routine that shows the habit as clear, copyable steps.
// Characters and places come from the shared sheet library (src/sheets.mjs), referred to by tag.
import fs from "node:fs";

const asset = (rel) => new URL(`../assets/${rel}`, import.meta.url);

let castCache = null;
/** Narrator voice settings, from assets/cast.json. */
export function loadCast() {
  castCache ??= JSON.parse(fs.readFileSync(asset("cast.json"), "utf8"));
  return castCache;
}

let styleCache = null;
/** The art-style paragraph of the house theme. */
export function loadStyle() {
  styleCache ??= fs.readFileSync(asset("style.md"), "utf8").trim();
  return styleCache;
}

export const NO_TEXT =
  "No text, letters, numbers, words, signs with writing or speech bubbles anywhere in the image.";

export const DOT_EYES =
  "Every character, people and animals alike, has simple solid black dot eyes: small filled black ovals with no eye whites, no irises, no big pupils and no shine (on a black animal a thin white ring around each dot may show it on the fur). Feelings show through the mouth, eyebrows and body, never through big or wide eyes.";

/** The house theme: style + palette + dot eyes; part of every picture prompt. */
export const houseTheme = (style = loadStyle()) => `${style}\n${DOT_EYES}`;

// Characters from the style-reference series that must never be reproduced.
export const FORBIDDEN_LOOKS = ["panda", "rabbit", "bunny", "penguin", "kappa"];

export const SAFE_DRESS =
  "Characters are always fully dressed in their fixed outfits; no nudity, and no bathing or toilet scenes shown in detail.";

// Camera shot per page (#17): the story picks one, the picture prompt leads with its description.
export const SHOTS = {
  wide: "wide establishing shot: the whole place is visible and the characters are small to medium in the frame",
  medium: "medium shot: the characters from the waist up fill most of the frame, with only part of the room behind them",
  closeup: "close-up: one character's head and shoulders fill the frame and the facial expression is clear; the background is soft and simple",
  detail: "detail close-up: the hands and the key object fill the frame; faces are mostly outside the picture",
  "child-eye": "child's eye view: the camera is low, at a small child's eye height, looking up at the adult, who looks tall and kind",
  "adult-eye": "adult's eye view: the camera is high where the parent stands, looking down at the child, who looks up toward the camera",
  "over-shoulder": "over-the-shoulder shot: from just behind one character's shoulder (soft, in the near foreground) toward the other character or the thing they look at",
};

const strictObject = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const IDEAS_SCHEMA = strictObject({
  ideas: { type: "array", items: strictObject({ title: { type: "string" }, pitch: { type: "string" } }) },
});

export const STORY_SCHEMA = strictObject({
  title: { type: "string" },
  mood: { type: "string", enum: ["bright", "calm", "playful"] },
  timeOfDay: { type: "string" },
  props: { type: "array", items: strictObject({ id: { type: "string" }, look: { type: "string" } }) },
  newSheets: {
    type: "array",
    items: strictObject({
      tag: { type: "string" },
      kind: { type: "string", enum: ["character", "place"] },
      name: { type: "string" },
      description: { type: "string" },
    }),
  },
  pages: {
    type: "array",
    items: strictObject({
      narration: { type: "string" },
      scene: { type: "string" },
      cast: { type: "array", items: { type: "string" } },
      location: { type: "string" },
      props: { type: "array", items: { type: "string" } },
      shot: { type: "string", enum: Object.keys(SHOTS) },
    }),
  },
});

export const PACKAGE_SCHEMA = strictObject({
  title: { type: "string" },
  description: { type: "string" },
  hashtags: { type: "array", items: { type: "string" } },
  coverScene: { type: "string" },
});

const CAST_BRIEF = `- น้องปิ่นโต (tag "pinto"): a cheerful, kind girl of about 6. She leads the story and shows how the habit is done. Narration calls her "ปิ่นโต".
- Her best friend (tag "friend"): a boy of about 6. He has NO NAME. Never give him a name or a nickname. Narration calls him only "เพื่อน" or "เพื่อนของปิ่นโต"; in dialogue Pinto calls him "เพื่อน" too. He is friendly and does the habit together with Pinto.
- Pinto's mother (tag "mom"): narration calls her "แม่" or "คุณแม่".
- The cat (tag "cat"): Pinto's small black cat with a red scarf, an ordinary house pet. Call it "แมวดำ" or "เจ้าแมวดำ"; never invent another name. It never talks. If it appears at all, it is just a normal cat in the background (sleeping, sitting, watching); it is never part of the plot.
- Their looks never change: same clothes in every page, and the cat always wears its red scarf (never lost, taken off or hidden). Small props in hand or a paper hat are fine; costumes that cover their clothes are not.`;

export function ideasPrompt(topic) {
  return `You are a gentle Thai children's storyteller planning simple teaching picture-book videos for children aged 4–10.
The stars are always the same:
${CAST_BRIEF}

Topic (a good habit or a simple life lesson): "${topic}"

Suggest exactly 3 story ideas for this topic. Each idea is one plain, realistic everyday situation from a child's day, and the 3 ideas happen in clearly different everyday settings, for example:
- one at home (getting up, brushing teeth, a meal, bedtime),
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

const libraryLines = (library, kind) =>
  library.filter((s) => s.kind === kind).map((s) => `- "${s.tag}" (${s.name}): ${s.description}`).join("\n") || "- (none yet)";

export function storyPrompt(idea, budget, library, minutes = 5) {
  const t = storyTargets(budget, minutes);
  return `You are a warm, gentle Thai children's storyteller. Write a picture book for children aged 4–10. It becomes a video: one picture per page, and one warm Thai female narrator reads every page aloud.

THE IDEA
Title: ${idea.title}
Pitch: ${idea.pitch}

THE MOST IMPORTANT RULE: PLAIN EVERYDAY LIFE THAT TEACHES ONE HABIT
- This is a simple teaching cartoon about realistic everyday life: home, school, family, meals, bedtime. No magic, no pretend worlds, no talking objects, talking animals or talking germs, no treasure hunts or mysteries, no surprise twists, no big silly moments.
- The story follows ONE ordinary routine around the topic, step by step, in the order it happens in a real day.
- Show the habit as clear steps a child can copy, one step at a time (for example for brushing teeth: a little toothpaste, brush the top teeth, brush the bottom teeth, rinse).
- The narrator may teach directly in simple, gentle words: once or twice, ONE short sentence on why the habit is good (for example "แปรงฟันแล้วฟันจะไม่ปวดนะ"). Never scolding, never a long speech, never a list of benefits, no grown-up health facts and no talk about the body's insides or the toilet.
- End with one short closing lesson line on the last page only, warm and simple.
- Calm, small, real stakes only; nothing scary or sad. No sweets, toys or prizes as a reward for doing the habit.
- Story shape:
  1. Start (pages 1–2): Pinto's ordinary moment begins. A simple, calm opening; no "กาลครั้งหนึ่ง".
  2. The everyday moment where the habit comes up.
  3. Pinto (and her friend) do the habit, step by step, over several pages, with a short reason why it is good.
  4. A small, real good result (clean hands, a full tummy, feeling fresh, ready for bed).
  5. A cosy ending and one short closing lesson line.

THE MAIN CHARACTERS (the same in every episode)
${CAST_BRIEF}

THE LIBRARY: characters and places that are already drawn. Use them by tag.
Characters:
${libraryLines(library, "character")}
Places:
${libraryLines(library, "place")}

NEW CHARACTERS OR PLACES
- Reuse a library tag whenever it fits: a teacher is always "teacher", the same teacher in every episode; a school classroom is always the same classroom.
- Only when the story needs someone or somewhere that is not in the library, add it to newSheets: tag = a short lowercase English role or place word with dashes (like "teacher", "grandma", "school-classroom", "market"), kind = "character" or "place", name = a short Thai name, description = an English visual description. For a character: who it is, age, hair, face and one fixed outfit. For a place: the empty place, its furniture, colours and materials. At most 3 new sheets. Ordinary people and places only; never pandas, rabbits, penguins, kappa or a second cat.

HOW THE THAI MUST SOUND (it is read aloud)
- Natural spoken Thai that a 4-year-old understands, the way a loving Thai mother tells a bedtime story. Short sentences, one idea each.
- Plain, calm words. No chants, no repeated catchphrases, no playful noise words, no jokes.
- Sometimes talk to the listener gently (for example "หนูล้างมือแบบนี้ได้ไหมคะ") but not on every page.
- A little simple dialogue in quotation marks is fine; make clear who is speaking.
- Write numbers as Thai words. No English words, no emoji, no brackets, no lists, no stage directions: only what the narrator says.
- Vary how pages begin; do not start every page with a name.

TIME AND THINGS THAT STAY THE SAME
- timeOfDay: English. The whole story happens in ONE part of the day; name it with its light (for example "evening, warm yellow lamp light indoors, dark blue sky in the windows"). Every page uses this same time and light.
- props: the things the story carries from page to page (the same dish, the same lunch box, the same toothbrush). Give each a short id and one fixed English look (for example id "lunchbox", look "a pink plastic lunch box with a white lid and two compartments"). They look exactly the same on every page.

PAGES
- Write between ${budget.min} and ${budget.max} pages; aim for about ${t.pages} pages.
- Each page is ONE clear moment that can be drawn as a single picture. Give the pictures variety: change the action, the spot in the room or the view from page to page.
- narration: Thai, between ${t.chars - 10} and ${t.chars + 40} characters (about 4 to 6 short sentences). Too short makes the video too short; too long makes it drag. Never more than 380 characters.
- location: the tag of the place where this picture happens (a library place or one of your newSheets places). Use "" only for a close-up of hands or objects where the room cannot be seen.
- cast: tags of every character visible in the picture (library characters or your newSheets characters). Pinto is in almost every page.
- props: ids of the props visible in this picture ([] when none).
- scene: English, for the illustrator. ALWAYS begin with the place (for example "In the bathroom at Pinto's home, beside the sink, ..."), even when it is the same place as the page before. In scenes call the boy "the friend" (never "Friend" as a name). Then say who is there, where they stand, what they are doing, their expressions, and the key objects. Show feelings with the mouth, eyebrows and body; never write "wide eyes" or "big eyes". One frozen moment, not a sequence. Never ask for written words, letters, numbers or signs.
- shot: the camera for this picture, one of ${Object.keys(SHOTS).map((k) => `"${k}"`).join(", ")}. Film it like a gentle movie, not a stage seen from one seat:
  - page 1 is "wide" so the viewer sees where the story happens; after that only about one page in four is "wide".
  - Use at least four different shots in the story, and never the same shot more than twice in a row.
  - "closeup" for a feeling; "detail" for the steps of a habit (hands, toothbrush, spoon); "child-eye" and "adult-eye" when a child and a grown-up talk; "over-shoulder" when one character watches or listens to another.
  - Write the scene for that camera: say only what this shot can see.

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

/** The picture prompt for one library sheet. */
export function sheetPrompt(sheet, style = loadStyle()) {
  if (sheet.kind === "place") {
    return `Place reference sheet: ${sheet.description}
Show the empty place with nobody in it: one wide, straight-on view of the whole place so that its furniture, colours, materials, table shapes, curtains, floor and decorations are clearly visible, in soft daylight.

${houseTheme(style)}
${NO_TEXT}`;
  }
  return `Character reference sheet on a plain white background: ${sheet.description}
Top row: the full body standing in a front view, a side view and a back view. Bottom row: four head close-ups with different expressions (happy, surprised, sad, laughing), shown with the mouth and eyebrows only. The same outfit and colours in every view.

${houseTheme(style)}
${SAFE_DRESS}
${NO_TEXT}`;
}

// Main-cast looks for episodes made before the sheet library (their pages name these ids but have no sheets).
const OLD_MAIN = {
  pinto: "Pinto (the girl): Thai girl about 6, short black bob with straight bangs, yellow shirt with small pink hearts, pink shorts, red sneakers.",
  friend: "Pinto's friend (the boy): Thai boy about 6, short messy black hair, light blue T-shirt with a white star, dark green shorts, yellow sneakers.",
  cat: "Pinto's small black cat with a red scarf.",
};

function describe(tag, story, library) {
  const s = library.find((x) => x.tag === tag && x.kind === "character");
  if (s) return `- ${s.name} (${tag}): ${s.description} Exactly as on their character sheet.`;
  const side = (story.sideCharacters ?? []).find((c) => c.id === tag);
  if (side) return `- ${tag}: ${side.look} Same art style as the main characters.`;
  return OLD_MAIN[tag] ? `- ${OLD_MAIN[tag]}` : null;
}

/** The picture prompt for one page. library: the sheet list (tags, names, descriptions). */
export function imagePrompt(page, story, library = [], style = loadStyle()) {
  const people = (page.cast ?? []).map((tag) => describe(tag, story, library)).filter(Boolean);
  const who = people.length
    ? `Characters in this picture (draw only these, each exactly as described):\n${people.join("\n")}`
    : "No characters in this picture, only the place.";
  const place = library.find((x) => x.tag === page.location && x.kind === "place");
  const props = (page.props ?? []).map((id) => (story.props ?? []).find((p) => p.id === id)).filter(Boolean);
  const mood = MOOD_WORDS[story.mood] ?? MOOD_WORDS.bright;
  return [
    houseTheme(style),
    "",
    ...(Object.hasOwn(SHOTS, page.shot ?? "") ? [`Camera: ${SHOTS[page.shot]}.`] : []),
    `Scene (draw this place exactly as described, do not move it elsewhere): ${page.scene}`,
    ...(place ? [`The place is ${place.name} (${place.tag}): ${place.description} Same room, furniture and colours as on its place sheet.`] : []),
    ...(story.timeOfDay ? [`Time of day and light (the same on every page): ${story.timeOfDay}.`] : []),
    ...(props.length ? [`Things in this picture that must look exactly like this on every page:\n${props.map((p) => `- ${p.id}: ${p.look}`).join("\n")}`] : []),
    "",
    who,
    "",
    `Mood: ${mood}.`,
    SAFE_DRESS,
    NO_TEXT,
  ].join("\n");
}

export function packagePrompt(ep) {
  const lines = ep.story.pages.map((p, i) => `${i + 1}. ${p.narration}`).join("\n");
  return `You prepare the YouTube upload for one episode of "ปิ่นโตเก่งขึ้นทุกวัน", a Thai picture-book cartoon for children aged 4–10 (made-for-kids content).

Story title: ${ep.story.title}
Story (Thai narration, page by page):
${lines}

Write, in Thai:
- title: a short, warm Thai video title (at most 40 characters) that says what Pinto learns. Plain and honest: no clickbait, no shouting, no "!!!", no emoji, no ALL-CAPS, no promises the video does not keep.
- description: 2 to 4 short Thai sentences: what happens in the story, then one line with the lesson of the story. Gentle and child-safe. No links, no emoji.
- hashtags: 5 to 8 hashtags, each starting with "#", Thai or simple English, no spaces inside a hashtag (for example "#นิทานเด็ก", "#ปิ่นโตเก่งขึ้นทุกวัน").
- coverScene: English, for the illustrator of the thumbnail: one happy, simple moment from this story with the characters large, close to the camera and on the RIGHT side of the picture, happy open faces, bright colours, an uncluttered background, and the top-left area kept calm and plain (sky, wall or soft background) for the title.

Return JSON only.`;
}

/** The text-free cover picture: the title is drawn on top later by the app. */
export function coverPrompt(ep, coverScene, library = [], style = loadStyle()) {
  const tags = [...new Set(ep.story.pages.flatMap((p) => p.cast ?? []))].filter((t) => library.some((s) => s.tag === t && s.kind === "character"));
  const people = tags.map((t) => describe(t, ep.story, library)).filter(Boolean);
  return [
    houseTheme(style),
    "",
    `YouTube thumbnail picture, 16:9: ${coverScene}`,
    "Thumbnail composition: the characters big, clear and close on the RIGHT half of the picture (faces large and easy to see on a small phone screen), happy faces, bright cheerful colours, an uncluttered background. Keep the TOP-LEFT area (about the left half of the width and the top 45% of the height) calm and plain so the title can be placed there later.",
    ...(people.length ? ["", `Characters (each exactly as on their character sheet):\n${people.join("\n")}`] : []),
    "",
    SAFE_DRESS,
    NO_TEXT,
  ].join("\n");
}
