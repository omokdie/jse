// Module worker for audio transcription (see audio/engine.js for the pool that drives it).
// in:  { id, type:'run', audio: ArrayBuffer (Float32 mono 22050 Hz), from, to }   — Basic Pitch over windows [from, to)
//      { id, type:'post', post }                                              — keep stitched posteriorgrams here
//      { id, type:'transcribe', opts }                                        — score-ification of the kept posteriorgrams
// out: { id, type:'progress', done, total } | { id, type:'result', ... } | { id, type:'error', message }
import { loadGraph, convBackend } from './tfgraph.js';
import { BasicPitch } from './basicpitch.js';
import { transcribe } from './transcribe.js';

let bpP = null, post = null, cache = {};
const MODEL = new URL('../../vendor/basic-pitch/', import.meta.url);
function model(base) {
  if (!bpP) bpP = (async () => {
    const b = base ? new URL(base, self.location.href) : MODEL;
    const [mj, w] = await Promise.all([
      fetch(new URL('model.json', b)).then(r => { if (!r.ok) throw new Error('모델을 불러오지 못했습니다 (' + r.status + ')'); return r.json(); }),
      fetch(new URL('group1-shard1of1.bin', b)).then(r => { if (!r.ok) throw new Error('모델 가중치를 불러오지 못했습니다'); return r.arrayBuffer(); }),
    ]);
    return new BasicPitch(loadGraph(mj, w));
  })();
  return bpP;
}

self.onmessage = async e => {
  const d = e.data || {}, id = d.id;
  try {
    if (d.type === 'run') {
      const bp = await model(d.modelBase);
      const audio = new Float32Array(d.audio);
      const r = bp.evaluate(audio, { from: d.from, to: d.to, contours: false, onWindow: (done, total) => self.postMessage({ id, type: 'progress', done, total }) });
      self.postMessage({ id, type: 'result', nFrames: r.nFrames, note: r.note, onset: r.onset, backend: convBackend() }, [r.note.buffer, r.onset.buffer]);
    } else if (d.type === 'post') {
      post = d.post; cache = {};
      self.postMessage({ id, type: 'result' });
    } else if (d.type === 'transcribe') {
      if (!post) throw new Error('분석 결과가 없습니다');
      // extracted notes depend only on the posteriorgrams, so re-quantising (tempo, grid, metre…) reuses them
      const r = transcribe(post, { ...d.opts, notes: cache });
      cache = { poly: r.cache.poly || cache.poly, melody: r.cache.melody || cache.melody };
      delete r.cache;
      self.postMessage({ id, type: 'result', result: r });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
