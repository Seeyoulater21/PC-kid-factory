export const MODELS = {
  ideas: "gemini-3.8-flash",
  story: "gemini-3.8-flash",
  image: "gemini-nano-banana-2.1",
  voice: "gemini-3.8-flash-tts",
  music: "lyria-3.5",
};

const URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 300_000;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 5000;

const THAI = {
  key: "คีย์ Gemini ไม่ถูกต้อง ลองวางใหม่",
  credit: "เครดิต Gemini หมด เติมเงินที่ Google AI Studio",
  busy: "Gemini ไม่ว่าง ลองใหม่อีกครั้ง",
  refused: "Gemini ไม่ยอมสร้างหน้านี้ ลองแก้คำเล่าแล้วกด ↻",
  network: "ต่ออินเทอร์เน็ตไม่ได้",
  empty: "Gemini ไม่ส่งผลลัพธ์กลับมา ลองใหม่",
};
const THAI_FREE_TIER = "ต้องเปิดการชำระเงินใน Google AI Studio ก่อนจึงจะวาดภาพได้";

export class GeminiError extends Error {
  constructor(code, message, thai = THAI[code]) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
    this.thai = thai;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGemini({ key, fetch = globalThis.fetch, sleep = realSleep }) {
  const scrub = (s) => {
    let t = String(s ?? "");
    if (key) t = t.split(key).join("[key]");
    return t.slice(0, 300);
  };

  function classify(status, text) {
    const t = text.toLowerCase();
    if (status === 429 && /free tier|limit:\s*0\b/.test(t)) return ["credit", THAI_FREE_TIER];
    if (/api key not valid|api_key_invalid|invalid api key/.test(t)) return ["key"];
    if (status === 401 || status === 403) return ["key"];
    if (/quota|billing|insufficient|payment/.test(t) || status === 402) return ["credit"];
    if (status === 429 || status >= 500) return ["busy"];
    if (/prohibited|blocked|safety/.test(t)) return ["refused"];
    return ["empty"];
  }

  async function call(body) {
    let attempt = 0;
    for (;;) {
      let res, text;
      try {
        res = await fetch(URL, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = await res.text();
      } catch (e) {
        throw new GeminiError("network", `network error: ${scrub(e?.message)}`);
      }
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new GeminiError("empty", "response was not JSON");
        }
      }
      const [code, thai] = classify(res.status, text);
      if (code === "busy" && attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        attempt++;
        continue;
      }
      throw new GeminiError(code, `Gemini HTTP ${res.status}: ${scrub(text)}`, thai);
    }
  }

  // Last content block of `type` across model_output steps, or null.
  function pick(resp, type) {
    let found = null;
    for (const step of resp?.steps ?? []) {
      if (step?.type !== "model_output") continue;
      for (const block of step.content ?? []) if (block?.type === type) found = block;
    }
    return found;
  }

  function missing(resp) {
    const raw = JSON.stringify(resp ?? {}).toLowerCase();
    if (/prohibited|blocked|safety/.test(raw)) {
      return new GeminiError("refused", "Gemini blocked the request");
    }
    return new GeminiError("empty", "Gemini returned no output");
  }

  async function bytes(body, type) {
    const resp = await call(body);
    const block = pick(resp, type);
    if (!block?.data) throw missing(resp);
    return Buffer.from(block.data, "base64");
  }

  return {
    async json(model, prompt, schema) {
      const resp = await call({
        model,
        input: prompt,
        response_format: { type: "text", mime_type: "application/json", schema },
      });
      const block = pick(resp, "text");
      if (!block?.text) throw missing(resp);
      try {
        return JSON.parse(block.text);
      } catch {
        throw new GeminiError("empty", "Gemini returned invalid JSON");
      }
    },

    image(prompt, refs = []) {
      return bytes(
        {
          model: MODELS.image,
          input: [
            { type: "text", text: prompt },
            ...refs.map((r) => ({ type: "image", data: r.data.toString("base64"), mime_type: r.mime })),
          ],
          response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "16:9", image_size: "2K" },
        },
        "image",
      );
    },

    speech(text, { voice, style }) {
      return bytes(
        {
          model: MODELS.voice,
          input: [
            {
              type: "user_input",
              content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }],
            },
          ],
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice }] },
        },
        "audio",
      );
    },

    music(prompt) {
      return bytes({ model: MODELS.music, input: prompt }, "audio");
    },
  };
}
