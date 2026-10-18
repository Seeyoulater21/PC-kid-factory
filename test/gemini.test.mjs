import { test } from "node:test";
import assert from "node:assert/strict";
import { createGemini, GeminiError, MODELS } from "../src/gemini.mjs";

const KEY = "SECRET-KEY-xyz-987";
const out = (...content) => ({ steps: [{ type: "model_output", content }] });
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => body,
});
function fake(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
function make(responses) {
  const f = fake(responses);
  const sleeps = [];
  const g = createGemini({ key: KEY, fetch: f, sleep: async (ms) => sleeps.push(ms) });
  return { g, f, sleeps };
}

test("MODELS constants", () => {
  assert.deepEqual(MODELS, {
    ideas: "gemini-3.8-flash", story: "gemini-4-argon", image: "gemini-nano-banana-2.1",
    voice: "gemini-3.8-flash-tts", music: "lyria-3.5",
  });
});

test("json parses model_output text", async () => {
  const { g, f } = make([reply(200, out({ type: "text", text: '{"a":1}' }))]);
  const schema = { type: "object" };
  assert.deepEqual(await g.json(MODELS.ideas, "hi", schema), { a: 1 });
  const c = f.calls[0];
  assert.equal(c.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(c.init.headers["x-goog-api-key"], KEY);
  assert.equal(c.body.model, MODELS.ideas);
  assert.equal(c.body.input, "hi");
  assert.deepEqual(c.body.response_format, { type: "text", mime_type: "application/json", schema });
});

test("image sends refs and 16:9 2K", async () => {
  const jpg = Buffer.from("JPEGBYTES");
  const { g, f } = make([reply(200, out({ type: "image", data: jpg.toString("base64"), mime_type: "image/jpeg" }))]);
  const refs = [{ data: Buffer.from("a"), mime: "image/jpeg" }, { data: Buffer.from("b"), mime: "image/jpeg" }];
  const buf = await g.image("draw", refs);
  assert.deepEqual(buf, jpg);
  const b = f.calls[0].body;
  assert.equal(b.model, MODELS.image);
  assert.equal(b.input.length, 3);
  assert.deepEqual(b.input[0], { type: "text", text: "draw" });
  assert.deepEqual(b.input[1], { type: "image", data: Buffer.from("a").toString("base64"), mime_type: "image/jpeg" });
  assert.equal(b.response_format.type, "image");
  assert.equal(b.response_format.mime_type, "image/jpeg");
  assert.equal(b.response_format.aspect_ratio, "16:9");
  assert.equal(b.response_format.image_size, "2K");
});

test("speech body shape and wav result", async () => {
  const wav = Buffer.from("RIFFwav");
  const { g, f } = make([reply(200, out({ type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" }))]);
  assert.deepEqual(await g.speech("สวัสดี", { voice: "V", style: "warm" }), wav);
  assert.deepEqual(f.calls[0].body, {
    model: MODELS.voice,
    input: [{ type: "user_input", content: [{ type: "text", text: "สวัสดี", annotations: [{ type: "speech_metadata", style: "warm" }] }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: "V" }] },
  });
});

test("music body and takes last audio block", async () => {
  const { g, f } = make([reply(200, out(
    { type: "audio", data: Buffer.from("one").toString("base64") },
    { type: "audio", data: Buffer.from("two").toString("base64") }))]);
  assert.deepEqual(await g.music("calm"), Buffer.from("two"));
  assert.deepEqual(f.calls[0].body, { model: "lyria-3.5", input: "calm" });
});

test("retries 429 then succeeds", async () => {
  const ok = reply(200, out({ type: "text", text: "{}" }));
  const { g, f, sleeps } = make([reply(429, { error: { message: "slow down", code: "too_many_requests" } }), reply(429, "{}"), ok]);
  assert.deepEqual(await g.json("m", "p", {}), {});
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [5000, 10000]);
});

async function fail(responses, call = (g) => g.json("m", "p", {})) {
  const { g, f, sleeps } = make(responses);
  try { await call(g); } catch (e) { return { e, f, sleeps }; }
  assert.fail("expected GeminiError");
}
function check(e, code) {
  assert.ok(e instanceof GeminiError);
  assert.equal(e.code, code);
  assert.ok(e.thai && /[ก-๙]/.test(e.thai));
  assert.ok(!e.message.includes(KEY) && !e.thai.includes(KEY));
}

test("errors are Thai and never contain the key", async () => {
  let r = await fail([reply(400, { error: { message: `API key not valid ${KEY}`, code: "invalid_request" } })]);
  check(r.e, "key"); assert.equal(r.f.calls.length, 1);
  r = await fail([reply(403, { error: { message: `forbidden ${KEY}` } })]);
  check(r.e, "key");
  r = await fail([reply(429, { error: { message: `busy ${KEY}`, code: "too_many_requests" } })]);
  check(r.e, "busy"); assert.equal(r.f.calls.length, 5); assert.equal(r.sleeps.length, 4);
  assert.deepEqual(r.sleeps, [5000, 10000, 20000, 40000]);
  r = await fail([reply(500, "boom")]);
  check(r.e, "busy"); assert.equal(r.f.calls.length, 5);
  r = await fail([reply(402, { error: { message: `billing quota exceeded ${KEY}` } })]);
  check(r.e, "credit");
  r = await fail([reply(200, out({ type: "text", text: `no image ${KEY}` }))], (g) => g.image("p", []));
  check(r.e, "empty");
  r = await fail([reply(400, { error: { message: `Input blocked: prohibited_content ${KEY}`, code: "prohibited_content" } })]);
  check(r.e, "refused");
  r = await fail([reply(200, { steps: [], error: "safety block" })], (g) => g.image("p", []));
  check(r.e, "refused");
  r = await fail([new Error(`fetch failed ${KEY}`)]);
  check(r.e, "network"); assert.equal(r.e.thai, "ต่ออินเทอร์เน็ตไม่ได้");
});

test("Free Tier limit 0 maps to credit and is not retried", async () => {
  const r = await fail([reply(429, { error: { message: "Rate limit exceeded for model gemini-nano-banana-2.1 (limit: 0 requests per day on Free Tier). Please upgrade your tier at https://ai.dev/rate-limit.", code: "too_many_requests" } })]);
  check(r.e, "credit");
  assert.equal(r.f.calls.length, 1);
  assert.equal(r.e.thai, "ต้องเปิดการชำระเงินใน Google AI Studio ก่อนจึงจะวาดภาพได้");
});
