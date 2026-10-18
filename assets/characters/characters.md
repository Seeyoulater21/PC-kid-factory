# Main characters (locked — owner approved 2026-10-18)

Sheets are reference images for every page image. Look and art style come from `origin.jpg`.

## pinto — น้องปิ่นโต
- Sheet: `pinto.jpg`
- Look: Thai girl about 6, short black bob with straight bangs, round face, small friendly black eyes, pink dash blush.
- Outfit (fixed): yellow short-sleeve shirt with small pink hearts, pink shorts, white socks, red sneakers.
- Role: the main character; leads every story.

## friend — เพื่อน (never named)
- Sheet: `friend.jpg`
- Look: Thai boy about 6, short messy black hair, round face, small black eyes, pink dash blush.
- Outfit (fixed): light blue T-shirt with a white star, dark green shorts, white socks, yellow sneakers.
- Role: Pinto's friend. Narration calls him only "เพื่อน" or "เพื่อนของปิ่นโต".

## cat — แมวดำ
- Sheet: `cat.jpg`
- Look: small round black house cat, big cream-colored round eyes, small pink nose, pink blush, red scarf tied at the neck.
- Role: Pinto's animal friend.

## Voice
- voice: `en-us-sola` (owner picked 2026-10-18 from achernar / vindemiatrix / en-us-sola / en-us-assistant-5)
- voice_style: A warm, cheerful young Thai woman reading a picture book aloud to children aged 4 to 10. Natural native Thai pronunciation and tones, smiling voice, lively but gentle, clear and a little slow, playful with sound words, brief natural pauses between sentences.

## Spike notes (2026-10-18)
- Images: 3 sheets as references keep all 3 characters consistent across 6 test pages; no style anchor needed.
  Each page prompt must name the location explicitly (a "soap bubble" page drifted outdoors).
- Image call ~30–60 s at 2K; 6 in parallel fine on Paid tier 1. Output 2752×1536 JPEG.
- Voice: gemini-3.8-flash-tts returns audio/wav; ~28 s for a 300-char Thai paragraph (~11 chars/s).
- Music: lyria-3.5 returns audio/mpeg, ~120 s stereo. Prompts containing "cartoon"/"comedic" were blocked
  (`prohibited_content`); use neutral wording. Seed tracks: `assets/music/seed-*.mp3`.
- No Thai-specific prebuilt voices exist; global voices auto-detect Thai.
