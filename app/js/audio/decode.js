// Audio input: WAV parsing (pure JS, for Node tests and as a browser fallback), mono mix-down, resampling to the
// 22050 Hz the transcription network expects, and browser decoding of MP3/M4A/OGG/WAV/FLAC via WebAudio.
export const TARGET_RATE = 22050;

/** Parse a RIFF/WAVE file (PCM 8/16/24/32-bit, IEEE float 32/64, WAVE_FORMAT_EXTENSIBLE) → {sampleRate, channels: Float32Array[]} */
export function parseWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = o => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV 파일이 아닙니다');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= u8.length) {
    const id = tag(off), len = dv.getUint32(off + 4, true), body = off + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true), sampleRate = dv.getUint32(body + 4, true), bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && len >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') data = { off: body, len: Math.min(len, u8.length - body) };
    off = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV 형식을 읽을 수 없습니다');
  const { format, channels, bits } = fmt, bps = bits >> 3, n = Math.floor(data.len / (bps * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) {
    const p = data.off + (i * channels + c) * bps; let v;
    if (format === 3) v = bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
    else if (bits === 16) v = dv.getInt16(p, true) / 32768;
    else if (bits === 24) v = ((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) << 8 >> 8) / 8388608;
    else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
    else if (bits === 8) v = (u8[p] - 128) / 128;
    else throw new Error(`지원하지 않는 WAV 비트 수: ${bits}`);
    out[c][i] = v;
  }
  return { sampleRate: fmt.sampleRate, channels: out };
}

/** Encode mono Float32 → 16-bit PCM WAV bytes (used for tests and for playing back the prepared signal). */
export function encodeWav(samples, sampleRate) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return new Uint8Array(buf);
}

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n), k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

/** Windowed-sinc resampler (Blackman window, anti-aliased when downsampling). */
export function resample(x, from, to = TARGET_RATE) {
  if (from === to) return x;
  const ratio = to / from, n = Math.floor(x.length * ratio), out = new Float32Array(n);
  const cutoff = Math.min(1, ratio) * 0.97, half = Math.ceil(16 / Math.min(1, ratio));
  for (let i = 0; i < n; i++) {
    const t = i / ratio, c = Math.floor(t);
    let acc = 0, wsum = 0;
    for (let j = c - half + 1; j <= c + half; j++) {
      if (j < 0 || j >= x.length) continue;
      const d = t - j, xx = Math.PI * d * cutoff;
      const sinc = d === 0 ? 1 : Math.sin(xx) / xx;
      const wpos = (d / half + 1) / 2;   // 0..1 across the window
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
      const k = sinc * win; acc += x[j] * k; wsum += k;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

/** Peak-normalise to ~-1 dBFS (the network normalises its CQT per window anyway; this only helps playback). */
export function normalizePeak(x, peak = 0.89) {
  let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m < 1e-6) return x;
  const g = peak / m, out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

/**
 * Browser: decode any file the platform can decode (MP3, M4A/AAC, OGG/Opus, WAV, FLAC, WebM audio…) →
 * { samples: Float32Array mono @22050, duration, sampleRate: 22050, original: {sampleRate, channels} }.
 */
export async function decodeAudioFile(blobOrBuffer) {
  const buf = blobOrBuffer instanceof ArrayBuffer ? blobOrBuffer : await blobOrBuffer.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 12));
  const isWav = String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WAVE';
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  let channels, sampleRate;
  if (AC) {
    const ctx = new AC();
    try {
      const ab = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf.slice(0), res, rej); if (p?.then) p.then(res, rej); });
      sampleRate = ab.sampleRate; channels = Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c));
      if (OAC && sampleRate !== TARGET_RATE) {
        // let the browser's high-quality resampler do the work
        const mono = mixToMono(channels);
        const len = Math.ceil(mono.length * TARGET_RATE / sampleRate);
        const off = new OAC(1, len, TARGET_RATE);
        const src = off.createBuffer(1, mono.length, sampleRate); src.copyToChannel ? src.copyToChannel(mono, 0) : src.getChannelData(0).set(mono);
        const node = off.createBufferSource(); node.buffer = src; node.connect(off.destination); node.start();
        const r = await off.startRendering();
        const samples = new Float32Array(r.getChannelData(0));
        return { samples, sampleRate: TARGET_RATE, duration: samples.length / TARGET_RATE, original: { sampleRate, channels: channels.length } };
      }
    } catch (e) {
      if (!isWav) throw new Error('이 파일의 소리를 읽을 수 없습니다 (지원하지 않는 형식이거나 손상된 파일). MP3·M4A·WAV·OGG·FLAC 파일을 사용하세요.');
    } finally { ctx.close?.(); }
  }
  if (!channels) { const w = parseWav(buf); channels = w.channels; sampleRate = w.sampleRate; }
  const samples = resample(mixToMono(channels), sampleRate, TARGET_RATE);
  return { samples, sampleRate: TARGET_RATE, duration: samples.length / TARGET_RATE, original: { sampleRate, channels: channels.length } };
}

/** Node / tests: WAV bytes → mono 22050 Float32Array. */
export function wavToMono22050(bytes) {
  const w = parseWav(bytes);
  return resample(mixToMono(w.channels), w.sampleRate, TARGET_RATE);
}
