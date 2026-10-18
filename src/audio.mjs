// Minimal 16-bit PCM WAV helpers. Headers are parsed, never assumed.

export function readWav(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let rate = 0, channels = 0, bits = 0, data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(start + 2);
      rate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === "data") {
      // Streamed WAVs may carry a bogus size: clamp to what is really there.
      const end = Math.min(buf.length, start + size);
      data = buf.subarray(start, end);
      break;
    }
    pos = start + size + (size % 2);
  }
  if (!data || !rate || !channels) throw new Error("Bad WAV: missing fmt or data chunk");
  if (bits !== 16) throw new Error(`Unsupported WAV: ${bits}-bit`);
  const n = Math.floor(data.length / 2);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2);
  return { rate, channels, samples };
}

export function writeWav({ rate, channels, samples }) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVEfmt ", 8, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

export function wavSeconds(buf) {
  const { rate, channels, samples } = readWav(buf);
  return samples.length / channels / rate;
}

// Mono narration bed: each part (mixed to mono, resampled by nearest sample) at `at` seconds.
export function narrationTrack(parts, totalSeconds, rate = 24000) {
  const out = new Int16Array(Math.round(totalSeconds * rate));
  for (const { wav, at } of parts) {
    const w = readWav(wav);
    const frames = Math.floor(w.samples.length / w.channels);
    const outLen = Math.round((frames * rate) / w.rate);
    const offset = Math.round(at * rate);
    for (let i = 0; i < outLen; i++) {
      const o = offset + i;
      if (o < 0 || o >= out.length) continue;
      const f = Math.min(frames - 1, Math.floor((i * w.rate) / rate));
      let sum = 0;
      for (let c = 0; c < w.channels; c++) sum += w.samples[f * w.channels + c];
      const v = out[o] + Math.round(sum / w.channels);
      out[o] = Math.max(-32768, Math.min(32767, v));
    }
  }
  return writeWav({ rate, channels: 1, samples: out });
}
