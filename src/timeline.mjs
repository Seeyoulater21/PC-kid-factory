// Book timeline: hold page 1 → turn → hold page 2 → ... (intro/outro are added by the video export).
export const TIMING = { lead: 0.4, tail: 1.0, turn: 1.5, fps: 30, zoomEnd: 1.06, intro: 5, outro: 15 };

const ms = (x) => Math.round(x * 1000) / 1000; // keeps 0.4 + 3 + 1 from drifting

/** voiceSeconds[i] = narration length of page i+1. Pages in segments are 1-based. */
export function buildTimeline(voiceSeconds) {
  const out = [];
  let t = 0;
  voiceSeconds.forEach((v, i) => {
    if (i > 0) {
      out.push({ kind: "turn", from: i, to: i + 1, start: t, end: ms(t + TIMING.turn) });
      t = ms(t + TIMING.turn);
    }
    const end = ms(t + TIMING.lead + Math.max(0, Number(v) || 0) + TIMING.tail);
    out.push({ kind: "hold", page: i + 1, start: t, end, voiceAt: ms(t + TIMING.lead) });
    t = end;
  });
  return out;
}

export const timelineSeconds = (segments) => (segments.length ? segments.at(-1).end : 0);

/** What to draw at time t: {kind:"hold", page, zoom} or {kind:"turn", from, to, fromZoom, progress}. */
export function sampleAt(segments, t) {
  let s = segments.find((x) => t < x.end) || segments.at(-1);
  if (!s) return null;
  const k = Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start || 1)));
  if (s.kind === "hold") return { kind: "hold", page: s.page, zoom: 1 + (TIMING.zoomEnd - 1) * k };
  return { kind: "turn", from: s.from, to: s.to, fromZoom: TIMING.zoomEnd, progress: k };
}
