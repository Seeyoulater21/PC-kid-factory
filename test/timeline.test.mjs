import { test } from "node:test";
import assert from "node:assert/strict";
import { TIMING, buildTimeline, timelineSeconds, sampleAt } from "../src/timeline.mjs";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("TIMING has the agreed values", () => {
  assert.deepEqual(TIMING, { lead: 0.4, tail: 1.0, turn: 1.5, fps: 30, zoomEnd: 1.06, introOutro: 5 });
});

test("buildTimeline for voices [3, 4]", () => {
  const t = buildTimeline([3, 4]);
  assert.equal(t.length, 3);
  const [a, b, c] = t;
  assert.equal(a.kind, "hold"); assert.equal(a.page, 1);
  close(a.start, 0, "hold1 start"); close(a.end, 4.4, "hold1 end"); close(a.voiceAt, 0.4, "voice1");
  assert.equal(b.kind, "turn"); assert.equal(b.from, 1); assert.equal(b.to, 2);
  close(b.start, 4.4, "turn start"); close(b.end, 5.9, "turn end");
  assert.equal(c.kind, "hold"); assert.equal(c.page, 2);
  close(c.start, 5.9, "hold2 start"); close(c.end, 11.3, "hold2 end"); close(c.voiceAt, 6.3, "voice2");
  close(timelineSeconds(t), 11.3, "total");
});

test("buildTimeline: one page has no turn; empty is empty", () => {
  assert.deepEqual(buildTimeline([2]).map((s) => s.kind), ["hold"]);
  assert.deepEqual(buildTimeline([]), []);
  assert.equal(timelineSeconds([]), 0);
});

test("sampleAt: zoom grows during a hold, turn progress runs 0..1", () => {
  const t = buildTimeline([3, 4]);
  const s0 = sampleAt(t, 0);
  assert.equal(s0.kind, "hold"); assert.equal(s0.page, 1); close(s0.zoom, 1, "zoom at start");
  const s1 = sampleAt(t, 4.4 - 1e-6);
  assert.ok(s1.zoom > 1.0599 && s1.zoom <= 1.06, `zoom near end ${s1.zoom}`);
  const mid = sampleAt(t, 2.2);
  assert.ok(mid.zoom > 1 && mid.zoom < 1.06);
  const tr = sampleAt(t, 4.4 + 0.75);
  assert.equal(tr.kind, "turn"); assert.equal(tr.from, 1); assert.equal(tr.to, 2);
  close(tr.progress, 0.5, "turn progress");
  close(tr.fromZoom, 1.06, "old page keeps its final zoom");
  const h2 = sampleAt(t, 5.9);
  assert.equal(h2.kind, "hold"); assert.equal(h2.page, 2); close(h2.zoom, 1, "new page starts at 1");
  const end = sampleAt(t, 99);
  assert.equal(end.kind, "hold"); assert.equal(end.page, 2); close(end.zoom, 1.06, "past the end clamps");
});
