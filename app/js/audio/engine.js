// Browser driver for audio transcription: decodes the file, splits the Basic Pitch windows over a small pool of
// module workers (navigator.hardwareConcurrency), stitches the posteriorgrams and asks worker 0 to build scores.
// Falls back to the main thread (with yields) when module workers are unavailable. No DOM access here.
import { decodeAudioFile } from './decode.js';
import { numWindows, numOutputFrames, FRAMES_PER_WINDOW, N_PITCH } from './basicpitch.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
export const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|wav|wave|ogg|oga|opus|flac|webm|weba|aif|aiff|caf|amr|3gp)$/i;
export function isAudioFile(name = '', type = '') { return AUDIO_EXT.test(name) || /^audio\//.test(type); }

export class AudioTranscriber {
  constructor({ workers = null } = {}) {
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    this.nWorkers = workers || Math.max(1, Math.min(4, hc >= 4 ? hc - 1 : hc));
    this.pool = []; this.seq = 0; this.cancelled = false; this.post = null; this.samples = null;
  }
  workers() {
    if (this.pool.length) return this.pool;
    try { for (let i = 0; i < this.nWorkers; i++) this.pool.push(new Worker(WORKER_URL, { type: 'module' })); }
    catch { this.pool.forEach(w => w.terminate()); this.pool = []; }
    return this.pool;
  }
  call(w, msg, transfer = [], onProgress = null) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const onMsg = e => {
        const d = e.data; if (d.id !== id) return;
        if (d.type === 'progress') { onProgress?.(d); return; }
        w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr);
        d.type === 'error' ? reject(new Error(d.message)) : resolve(d);
      };
      const onErr = e => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); e.preventDefault?.(); reject(new Error(e.message || '작업자 오류')); };
      w.addEventListener('message', onMsg); w.addEventListener('error', onErr);
      w.postMessage({ id, ...msg }, transfer);
    });
  }
  /** File/Blob → mono 22050 Hz samples. */
  async decode(blob) { const r = await decodeAudioFile(blob); this.samples = r.samples; return r; }
  /** Run the network over this.samples. onProgress({stage, percent, message}). */
  async analyze(onProgress = () => {}) {
    const audio = this.samples, nW = numWindows(audio.length), nOut = numOutputFrames(audio.length);
    const t0 = performance.now();
    const pool = this.workers();
    let parts;
    if (pool.length) {
      const per = Math.ceil(nW / pool.length), done = new Array(pool.length).fill(0);
      const report = () => { const d = done.reduce((a, b) => a + b, 0); onProgress({ stage: 'network', percent: 100 * d / nW, message: `소리 분석 중… ${Math.round(100 * d / nW)}%` }); };
      try {
        parts = await Promise.all(pool.map((w, i) => {
          const from = i * per, to = Math.min(nW, from + per);
          if (from >= to) return Promise.resolve(null);
          return this.call(w, { type: 'run', audio: audio.buffer.slice(0), from, to }, [], p => { done[i] = p.done; report(); });
        }));
      } catch (e) { if (this.cancelled) throw new Error('취소했습니다'); throw e; }
    } else {
      // main-thread fallback: window by window, yielding to keep the page responsive
      const [{ loadGraph }, { BasicPitch }] = await Promise.all([import('./tfgraph.js'), import('./basicpitch.js')]);
      const base = new URL('../../vendor/basic-pitch/', import.meta.url);
      const [mj, wb] = await Promise.all([fetch(new URL('model.json', base)).then(r => r.json()), fetch(new URL('group1-shard1of1.bin', base)).then(r => r.arrayBuffer())]);
      const bp = new BasicPitch(loadGraph(mj, wb));
      parts = [];
      for (let w = 0; w < nW; w++) {
        if (this.cancelled) throw new Error('취소했습니다');
        parts.push({ ...bp.evaluate(audio, { from: w, to: w + 1, contours: false }) });
        onProgress({ stage: 'network', percent: 100 * (w + 1) / nW, message: `소리 분석 중… ${Math.round(100 * (w + 1) / nW)}%` });
        await new Promise(r => setTimeout(r, 0));
      }
    }
    // stitch
    const note = new Float32Array(nOut * N_PITCH), onset = new Float32Array(nOut * N_PITCH);
    let k = 0;
    for (const p of parts) { if (!p) continue; const n = Math.min(p.nFrames, nOut - k); note.set(new Float32Array(p.note.buffer || p.note).subarray(0, n * N_PITCH), k * N_PITCH); onset.set(new Float32Array(p.onset.buffer || p.onset).subarray(0, n * N_PITCH), k * N_PITCH); k += n; }
    this.post = { nFrames: nOut, note, onset };
    this.stats = { windows: nW, ms: Math.round(performance.now() - t0), workers: pool.length || 0, backend: parts.find(p => p?.backend)?.backend || 'main', framesPerWindow: FRAMES_PER_WINDOW };
    if (pool.length) await this.call(pool[0], { type: 'post', post: this.post });
    return this.post;
  }
  /** Score-ification (fast; reuses the posteriorgrams and extracted notes). */
  async transcribe(opts) {
    const pool = this.workers();
    if (pool.length) { const r = await this.call(pool[0], { type: 'transcribe', opts }); return r.result; }
    const { transcribe } = await import('./transcribe.js');
    const r = transcribe(this.post, { ...opts, notes: this._cache }); this._cache = r.cache; return r;
  }
  cancel() { this.cancelled = true; this.pool.forEach(w => w.terminate()); this.pool = []; }
  dispose() { this.pool.forEach(w => w.terminate()); this.pool = []; }
}
