// WebAudio playback: a small polyphonic synth with a few timbres + drum sounds, metronome, cursor tracking.
import { buildPlayback } from '../io/midi.js';

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class Player extends EventTarget {
  constructor(app) {
    super();
    this.app = app; this.ctx = null; this.master = null;
    this.playing = false; this.startAt = 0; this.offset = 0; this.pb = null; this.nextIdx = 0;
    this.tempoScale = 1; this.metronome = false; this.volume = 0.8; this.loop = null; this.timer = null; this.raf = null;
    this.scheduled = [];
  }
  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext; this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4;
      this.master.connect(comp); comp.connect(this.ctx.destination);
      this.noise = this.makeNoise();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  makeNoise() { const len = this.ctx.sampleRate; const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate); const d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; return buf; }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  prepare() { this.pb = buildPlayback(this.app.score); }
  get duration() { return this.pb ? this.pb.duration / this.tempoScale : 0; }
  get position() { return this.playing ? this.offset + (this.ctx.currentTime - this.startAt) * this.tempoScale : this.offset; }
  play(fromMeasure = null) {
    this.ensureCtx();
    this.prepare();
    if (fromMeasure != null) { const mt = this.pb.measureTimes.find(m => m.mi === fromMeasure); this.offset = mt ? mt.time : 0; }
    if (this.offset >= this.pb.duration - 0.01) this.offset = 0;
    this.playing = true; this.startAt = this.ctx.currentTime + 0.05;
    this.nextIdx = this.pb.notes.findIndex(n => n.time >= this.offset - 0.001); if (this.nextIdx < 0) this.nextIdx = this.pb.notes.length;
    this.nextClick = Math.ceil(this.offset / this.beatSec(this.offset) - 1e-6);
    this.scheduleLoop();
    this.tick();
    this.dispatchEvent(new Event('state'));
  }
  pause() { if (!this.playing) return; this.offset = this.position; this.playing = false; this.stopScheduling(); this.dispatchEvent(new Event('state')); this.dispatchEvent(new CustomEvent('cursor', { detail: null })); }
  stop() { this.playing = false; this.offset = 0; this.stopScheduling(); this.dispatchEvent(new Event('state')); this.dispatchEvent(new CustomEvent('cursor', { detail: null })); }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  stopScheduling() { clearTimeout(this.timer); cancelAnimationFrame(this.raf); for (const s of this.scheduled) { try { s.stop(); } catch { /* ignore */ } } this.scheduled = []; }
  seekMeasure(mi) { const was = this.playing; this.pause(); this.prepare(); const mt = this.pb.measureTimes.find(m => m.mi === mi); this.offset = mt ? mt.time : 0; if (was) this.play(); else this.dispatchEvent(new CustomEvent('cursor', { detail: { mi, ids: [] } })); }
  beatSec(time) {
    const mt = this.pb.measureTimes.find(m => time >= m.time && time < m.time + m.dur) || this.pb.measureTimes[0];
    if (!mt) return 0.5;
    const ts = this.measureTimeSig(mt.mi); return mt.dur / ts.num;
  }
  measureTimeSig(mi) { let m = mi; while (m > 0 && !this.app.score.measures[m].timeSig) m--; return this.app.score.measures[m].timeSig || { num: 4, den: 4 }; }
  scheduleLoop() {
    const ahead = 0.25;
    const now = this.position;
    const until = now + ahead;
    const notes = this.pb.notes;
    while (this.nextIdx < notes.length && notes[this.nextIdx].time <= until) {
      const n = notes[this.nextIdx++];
      const when = this.startAt + (n.time - this.offset) / this.tempoScale;
      this.playNote(n, when, n.dur / this.tempoScale);
    }
    if (this.metronome) {
      for (;;) {
        const bs = this.beatSec(this.nextClick * 0.5 * 0 + Math.max(0, this.nextClick) * this.beatSec(now));
        const t = this.nextClick * bs; if (t > until) break;
        const mt = this.pb.measureTimes.find(m => t >= m.time - 1e-6 && t < m.time + m.dur - 1e-6);
        const accent = mt && Math.abs(t - mt.time) < 1e-3;
        this.click(this.startAt + (t - this.offset) / this.tempoScale, accent);
        this.nextClick++;
      }
    }
    if (now >= this.pb.duration) { this.timer = setTimeout(() => { if (this.loop) { this.offset = 0; this.play(); } else this.stop(); }, 600); return; }
    this.timer = setTimeout(() => this.scheduleLoop(), 100);
  }
  tick() {
    if (!this.playing) return;
    const pos = this.position;
    const mt = this.pb.measureTimes.find(m => pos >= m.time && pos < m.time + m.dur);
    const ids = []; const notes = this.pb.notes;
    for (let i = Math.max(0, this.nextIdx - 64); i < this.nextIdx; i++) { const n = notes[i]; if (n.time <= pos && pos < n.time + Math.max(0.08, n.dur)) ids.push(...n.eventIds); }
    this.dispatchEvent(new CustomEvent('cursor', { detail: { mi: mt?.mi ?? null, ids, pos, frac: mt ? (pos - mt.time) / mt.dur : 0 } }));
    this.raf = requestAnimationFrame(() => this.tick());
  }
  playNote(n, when, dur) {
    const ctx = this.ctx;
    if (n.channel === 9) { this.drum(n.midi, when, n.velocity / 127); return; }
    const vel = n.velocity / 127;
    const g = ctx.createGain(); g.connect(this.master);
    const prog = n.program || 0;
    const f = mtof(n.midi);
    const fam = prog < 8 ? 'piano' : prog < 16 ? 'chrome' : prog < 24 ? 'organ' : prog < 32 ? 'guitar' : prog < 40 ? 'bass' : prog < 56 ? 'strings' : prog < 72 ? 'brass' : prog < 80 ? 'wind' : 'lead';
    const oscs = [];
    const mk = (type, detune = 0, mult = 1, amp = 1) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f * mult; o.detune.value = detune; const og = ctx.createGain(); og.gain.value = amp; o.connect(og); og.connect(g); oscs.push(o); return o; };
    let a = 0.01, d = 0.1, s = 0.6, r = 0.15, peak = 0.22 * vel;
    switch (fam) {
      case 'piano': mk('triangle', 0, 1, 1); mk('sine', 0, 2, 0.35); mk('sine', 0, 3, 0.12); a = 0.004; d = 0.35 + 1.2 * (1 - n.midi / 127); s = 0.25; r = 0.25; break;
      case 'chrome': mk('sine', 0, 1, 1); mk('sine', 0, 4, 0.3); a = 0.002; d = 0.6; s = 0.05; r = 0.4; break;
      case 'organ': mk('sine', 0, 1, 0.8); mk('sine', 0, 2, 0.5); mk('sine', 0, 4, 0.3); mk('sine', 0, 0.5, 0.3); a = 0.02; d = 0.05; s = 0.9; r = 0.08; peak *= 0.8; break;
      case 'guitar': mk('triangle', 0, 1, 1); mk('sawtooth', 0, 1, 0.15); a = 0.003; d = 0.5; s = 0.15; r = 0.2; break;
      case 'bass': mk('triangle', 0, 1, 1); mk('sine', 0, 0.5, 0.4); a = 0.005; d = 0.4; s = 0.3; r = 0.15; peak *= 1.2; break;
      case 'strings': mk('sawtooth', -6, 1, 0.5); mk('sawtooth', 6, 1, 0.5); a = 0.08; d = 0.2; s = 0.85; r = 0.25; peak *= 0.7; break;
      case 'brass': mk('sawtooth', 0, 1, 0.8); mk('square', 3, 1, 0.2); a = 0.04; d = 0.15; s = 0.8; r = 0.12; peak *= 0.75; break;
      case 'wind': mk('sine', 0, 1, 1); mk('triangle', 0, 1, 0.4); a = 0.05; d = 0.1; s = 0.85; r = 0.12; break;
      default: mk('square', 0, 1, 0.5); mk('sawtooth', 5, 1, 0.3); a = 0.01; d = 0.2; s = 0.6; r = 0.15; peak *= 0.6;
    }
    // low-pass for warmth
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(12000, 1200 + f * 4 + vel * 3000); g.disconnect(); g.connect(lp); lp.connect(this.master);
    const end = when + Math.max(0.05, dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * s), when + a + d);
    g.gain.setValueAtTime(Math.max(0.0002, peak * s), Math.max(when + a + d, end - 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, end + r);
    for (const o of oscs) { o.start(when); o.stop(end + r + 0.05); this.scheduled.push(o); }
    if (this.scheduled.length > 400) this.scheduled.splice(0, 100);
  }
  drum(midi, when, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.connect(this.master);
    const noiseBurst = (dur, hp, amp) => { const src = ctx.createBufferSource(); src.buffer = this.noise; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; const ng = ctx.createGain(); src.connect(f); f.connect(ng); ng.connect(this.master); ng.gain.setValueAtTime(amp * vel, when); ng.gain.exponentialRampToValueAtTime(0.0001, when + dur); src.start(when); src.stop(when + dur + 0.02); this.scheduled.push(src); };
    const tone = (f0, f1, dur, amp, type = 'sine') => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1, when + dur); const og = ctx.createGain(); o.connect(og); og.connect(this.master); og.gain.setValueAtTime(amp * vel, when); og.gain.exponentialRampToValueAtTime(0.0001, when + dur); o.start(when); o.stop(when + dur + 0.02); this.scheduled.push(o); };
    switch (midi) {
      case 35: case 36: tone(150, 45, 0.35, 0.9); noiseBurst(0.03, 200, 0.2); break;                 // kick
      case 38: case 40: tone(220, 120, 0.12, 0.4, 'triangle'); noiseBurst(0.18, 1500, 0.5); break;    // snare
      case 37: noiseBurst(0.05, 2500, 0.4); tone(800, 400, 0.04, 0.3); break;                        // rimshot
      case 42: case 44: noiseBurst(0.06, 7000, 0.35); break;                                          // hh closed/pedal
      case 46: noiseBurst(0.35, 6000, 0.3); break;                                                     // hh open
      case 49: case 57: case 55: case 52: noiseBurst(1.2, 4000, 0.35); tone(1200, 900, 0.8, 0.05); break; // crash
      case 51: case 59: case 53: noiseBurst(0.6, 5000, 0.18); tone(900, 850, 0.6, 0.12, 'triangle'); break; // ride
      case 41: case 43: tone(130, 80, 0.4, 0.6); break;                                                // floor tom
      case 45: case 47: tone(180, 110, 0.35, 0.6); break;                                              // low/mid tom
      case 48: case 50: tone(250, 160, 0.3, 0.6); break;                                               // high tom
      case 56: tone(560, 540, 0.15, 0.4, 'square'); break;                                             // cowbell
      default: noiseBurst(0.1, 3000, 0.3);
    }
    void g;
  }
  click(when, accent) {
    const ctx = this.ctx; const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = accent ? 1600 : 1100; const g = ctx.createGain(); o.connect(g); g.connect(this.master);
    g.gain.setValueAtTime(accent ? 0.25 : 0.15, when); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05); o.start(when); o.stop(when + 0.06); this.scheduled.push(o);
  }
  /** Audition a single pitch (used while entering/moving notes). */
  preview(midi, program = 0, channel = 0) {
    try { this.ensureCtx(); this.playNote({ midi, velocity: 80, program, channel, eventIds: [] }, this.ctx.currentTime + 0.01, 0.35); } catch { /* ignore */ }
  }
}
