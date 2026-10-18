import { test } from "node:test";
import assert from "node:assert/strict";
import { readWav, writeWav, wavSeconds, narrationTrack } from "../src/audio.mjs";

const tone = (n, v = 8000) => Int16Array.from({ length: n }, () => v);

test("wav round-trip", () => {
  const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
  const back = readWav(writeWav({ rate: 24000, channels: 1, samples }));
  assert.equal(back.rate, 24000);
  assert.equal(back.channels, 1);
  assert.deepEqual(Array.from(back.samples), Array.from(samples));
});

test("wavSeconds of 24000 samples at 24 kHz is 1.0", () => {
  assert.equal(wavSeconds(writeWav({ rate: 24000, channels: 1, samples: new Int16Array(24000) })), 1);
});

test("readWav skips extra chunks and tolerates a bad data size", () => {
  const good = writeWav({ rate: 16000, channels: 1, samples: tone(10) });
  const extra = Buffer.from("LIST\x04\x00\x00\x00abcd", "latin1");
  const buf = Buffer.concat([good.subarray(0, 36), extra, good.subarray(36)]);
  buf.writeUInt32LE(0xffffffff, 36 + extra.length + 4); // streaming-style size
  const w = readWav(buf);
  assert.equal(w.rate, 16000);
  assert.equal(w.samples.length, 10);
});

test("readWav rejects non-WAV input", () => {
  assert.throws(() => readWav(Buffer.from("nope")), /WAV/);
});

test("narrationTrack places parts", () => {
  const part = writeWav({ rate: 24000, channels: 1, samples: tone(12000) });
  const out = readWav(narrationTrack([{ wav: part, at: 0 }, { wav: part, at: 2 }], 3));
  assert.equal(wavSeconds(writeWav(out)), 3);
  assert.equal(out.rate, 24000);
  assert.equal(out.samples[Math.round(0.25 * 24000)], 8000);
  assert.equal(out.samples[Math.round(1.0 * 24000)], 0);
  assert.equal(out.samples[Math.round(2.1 * 24000)], 8000);
});

test("narrationTrack sums overlap and clamps", () => {
  const part = writeWav({ rate: 24000, channels: 1, samples: tone(24000, 20000) });
  const out = readWav(narrationTrack([{ wav: part, at: 0 }, { wav: part, at: 0.5 }], 2));
  assert.equal(out.samples[Math.round(0.25 * 24000)], 20000);
  assert.equal(out.samples[Math.round(0.75 * 24000)], 32767);
  assert.equal(out.samples[Math.round(1.25 * 24000)], 20000);
});

test("narrationTrack truncates a part past totalSeconds", () => {
  const part = writeWav({ rate: 24000, channels: 1, samples: tone(24000) });
  const out = readWav(narrationTrack([{ wav: part, at: 1.5 }], 2));
  assert.equal(out.samples.length, 48000);
  assert.equal(out.samples[Math.round(1.75 * 24000)], 8000);
  assert.equal(out.samples[Math.round(1.25 * 24000)], 0);
});

test("narrationTrack resamples a 16 kHz part to 24 kHz length", () => {
  const part = writeWav({ rate: 16000, channels: 1, samples: tone(16000) });
  const out = readWav(narrationTrack([{ wav: part, at: 0 }], 2));
  assert.equal(out.samples[23999], 8000);
  assert.equal(out.samples[24000], 0);
});
