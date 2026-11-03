// JSE OMR — lyric stage: finds the text lines printed under each staff, reads
// them with the Hangul recogniser (hangul.js) and attaches one syllable per
// note. Pure JS (typed arrays only), runs in the OMR Web Worker and in Node.
//
// Called by omr.js `recognize()` after assembly:
//   recognizeLyrics({ ctx, staves, events, score, image, nolines }) →
//     { lyrics: LyricSyllable[], lines: LyricLine[], warnings: string[], stats }
//   LyricSyllable { eventId|null, measureId|null, staffIndex, systemIndex, verse, text,
//                   confidence 0..1, lowConfidence, bbox:[x,y,w,h] (original image px), alternatives:[] }
//   LyricLine     { staffIndex, systemIndex, verse, text, bbox, confidence, syllables }
// The score's events get `lyrics: [{ verse, text, syllabic:'single' }]` exactly like the
// editor's Korean input (one Hangul syllable per note, no hyphens; trailing
// punctuation stays with its syllable). Everything here degrades gracefully: no
// text found → nothing changes; an exception is caught by the caller.
//
// Working coordinates (ctx.w × ctx.h, staff space ctx.sp ≈ 12 px) are used for
// detection; glyphs are resampled from the original image via ctx.toOrig.
import { sampleEmBox, normalizeInk, readInk, supersampleFactor, EM_BOX } from './hangul.js';

const LOW_CONF = 0.8;           // below this a syllable is flagged for review (dev set: flags ~70 % of misreads, ~2 % of correct syllables)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const isLatin = (t) => /^[A-Za-z]$/.test(t);
const isDigit = (t) => /^[0-9]$/.test(t);
const CLOSING = new Set([',', '.', '!', '?', '~', ':', ')', "'", '"']);
const OPENING = new Set(['(']);

// ---------------------------------------------------------------------------
// image helpers
// ---------------------------------------------------------------------------
function greyOf(image) {
  const { width: W, height: H, data } = image;
  const g = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    let v = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    const a = data[j + 3];
    if (a < 255) v = (v * a + 255 * (255 - a)) / 255;
    g[i] = v;
  }
  return { width: W, height: H, data: g };
}

/** 8-connected components of `img` inside the rectangle [x0,x1]×[y0,y1]. */
function labelRect(img, w, x0, y0, x1, y1) {
  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  const lab = new Int32Array(rw * rh);
  let parent = new Int32Array(256); let n = 0;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    if (!img[(y + y0) * w + x + x0]) continue;
    const i = y * rw + x;
    let l = 0;
    for (let k = 0; k < 4; k++) {
      const c = k === 0 ? (x > 0 ? lab[i - 1] : 0) : y === 0 ? 0 : k === 1 ? lab[i - rw] : k === 2 ? (x > 0 ? lab[i - rw - 1] : 0) : (x < rw - 1 ? lab[i - rw + 1] : 0);
      if (c) { if (!l) l = c; else if (c !== l) union(l, c); }
    }
    if (!l) { n++; if (n >= parent.length) { const p = new Int32Array(parent.length * 2); p.set(parent); parent = p; } parent[n] = n; l = n; }
    lab[i] = l;
  }
  const map = new Int32Array(n + 1); let m = 0;
  for (let i = 1; i <= n; i++) if (find(i) === i) map[i] = ++m;
  const comps = [null];
  for (let i = 1; i <= m; i++) comps.push({ id: i, x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0, sx: 0 });
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x; if (!lab[i]) continue;
    const l = map[find(lab[i])]; lab[i] = l;
    const c = comps[l], X = x + x0, Y = y + y0;
    if (X < c.x0) c.x0 = X; if (X > c.x1) c.x1 = X; if (Y < c.y0) c.y0 = Y; if (Y > c.y1) c.y1 = Y;
    c.area++; c.sx += X;
  }
  for (const c of comps) if (c) { c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; c.cx = c.sx / c.area; }
  return { lab, rw, rh, x0, y0, comps };
}

/** Binary of the rectangle for text: thin serif hairlines break apart at the
 * music threshold, so the text band is re-thresholded closer to the paper
 * level (local paper / ink levels of the working grey). */
function textBinary(ctx, img, x0, y0, x1, y1) {
  const { w } = ctx, rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  const out = new Uint8Array(rw * rh);
  const G = ctx.gray;
  if (!G || G.length !== ctx.w * ctx.h) {
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) out[y * rw + x] = img[(y + y0) * w + x + x0] ? 1 : 0;
    return out;
  }
  const hist = new Uint32Array(256);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hist[G[y * w + x]]++;
  const n = rw * rh, q = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; } return 255; };
  const paper = q(0.7), ink = q(0.005);
  const thr = paper - 0.4 * Math.max(paper - ink, 60);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = (y + y0) * w + x + x0;
    out[y * rw + x] = G[i] < thr || img[i] ? 1 : 0;
  }
  return out;
}
function shiftRect(R, dx, dy) {
  R.x0 = dx; R.y0 = dy;
  for (const c of R.comps) if (c) { c.x0 += dx; c.x1 += dx; c.y0 += dy; c.y1 += dy; c.cx += dx; c.sx += dx * c.area; }
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------
export function recognizeLyrics({ ctx, staves, events, score, image, nolines }) {
  const t0 = Date.now();
  const out = { lyrics: [], lines: [], warnings: [], stats: { lines: 0, tokens: 0, reads: 0, ms: 0 } };
  if (!staves || !staves.length || !image) return out;
  const { sp } = ctx;
  const img = nolines || ctx.bin;
  const order = staves.slice().sort((a, b) => a.top - b.top);
  const evById = indexScore(score);
  let grey = null;
  const reader = {
    read(tok, line, maskFn) {
      if (!grey) grey = ctx.origGray && ctx.origGray.length === image.width * image.height ? { width: image.width, height: image.height, data: ctx.origGray } : greyOf(image);
      out.stats.reads++;
      const cx = (tok.x0 + tok.x1) / 2, cy = line.yAt(cx) + line.mid, S = EM_BOX * line.H;
      const aff = affineAt(ctx, cx, cy);
      const k = supersampleFactor(S * Math.hypot(aff[0], aff[3]));
      return readInk(normalizeInk(sampleEmBox(grey, cx, cy, S, aff, k, maskFn)));
    },
  };
  for (const st of order) {
    let lines;
    try { lines = findTextLines(ctx, img, st, order, events, sp); } catch (e) { continue; }
    const lyricLines = [];
    let lastBot = 0;                       // lyric lines hang below the staff, one under the other
    for (const line of lines) {
      if (line.ra > (lyricLines.length ? lastBot + 3.0 * (line.rb - line.ra + 1) : 9 * sp)) break;   // footer / unrelated text further down
      const toks = segmentLine(line, reader, sp);
      out.stats.tokens += toks.length;
      const lyr = interpretLine(toks, line);
      if (lyr) { lyricLines.push(lyr); lastBot = line.rb; }
    }
    if (!lyricLines.length) continue;
    // verse numbers: explicit "1." wins, otherwise top-to-bottom order
    let prev = 0;
    for (const L of lyricLines) { L.verse = L.verseNumber > prev ? L.verseNumber : prev + 1; prev = L.verse; }
    const notes = staffNotes(events, st, evById);
    for (const L of lyricLines) {
      assignSyllables(L.syllables, notes, sp);
      // lyrics sit under their notes; text that does not line up with the notes is not lyrics
      const dxs = L.syllables.filter(s => s.note).map(s => Math.abs(s.x - s.note.x) / sp).sort((a, b) => a - b);
      if (notes.length >= 3 && dxs.length >= 3 && dxs[dxs.length >> 1] > 1.2) continue;
      out.stats.lines++;
      const entries = [];
      for (const s of L.syllables) {
        const ev = s.note ? s.note.ev : null;
        const sev = ev && evById.get(ev.eventId);
        const conf = s.conf * (s.note ? s.assignConf : 0.5);
        const entry = { eventId: sev ? ev.eventId : null, measureId: sev ? sev.measureId : null, staffIndex: st.index ?? staves.indexOf(st), systemIndex: st.systemIndex ?? 0,
          verse: L.verse, text: s.text, confidence: round3(conf), lowConfidence: conf < LOW_CONF,
          bbox: ctx.bboxToOrig([s.bx0, s.y0, s.bx1 - s.bx0 + 1, s.y1 - s.y0 + 1]), alternatives: s.alts };
        if (sev) setLyric(sev.ev, L.verse, s.text);
        entries.push(entry);
        out.lyrics.push(entry);
      }
      out.lines.push({ staffIndex: st.index ?? staves.indexOf(st), systemIndex: st.systemIndex ?? 0, verse: L.verse,
        text: L.syllables.map(s => s.text).join(' '), bbox: ctx.bboxToOrig([L.x0, L.y0, L.x1 - L.x0 + 1, L.y1 - L.y0 + 1]),
        confidence: round3(entries.reduce((a, e) => a + e.confidence, 0) / Math.max(1, entries.length)), syllables: entries.length });
    }
  }
  const low = out.lyrics.filter(l => l.lowConfidence).length;
  const unassigned = out.lyrics.filter(l => !l.eventId).length;
  if (out.lyrics.length && low) out.warnings.push(`가사 ${out.lyrics.length}개 음절 중 ${low}개는 인식이 불확실합니다. 표시된 가사를 확인해 주세요.`);
  if (unassigned) out.warnings.push(`가사 ${unassigned}개 음절을 음표에 연결하지 못했습니다.`);
  out.stats.ms = Date.now() - t0;
  return out;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function indexScore(score) {
  const map = new Map();
  if (!score) return map;
  for (const m of score.measures || []) for (const sm of m.staves || []) for (const v of sm.voices || []) for (const ev of v) map.set(ev.id, { ev, measureId: m.id });
  return map;
}

function setLyric(ev, verse, text) {
  const ly = (ev.lyrics || []).filter(l => (l.verse || 1) !== verse);
  ly.push({ verse, text, syllabic: 'single' });
  ly.sort((a, b) => (a.verse || 1) - (b.verse || 1));
  ev.lyrics = ly;
}

/** Local affine approximation of ctx.toOrig around (x, y): [a,b,c,d,e,f]. */
function affineAt(ctx, x, y) {
  const p0 = ctx.toOrig(x, y), px = ctx.toOrig(x + 8, y), py = ctx.toOrig(x, y + 8);
  const a = (px[0] - p0[0]) / 8, b = (py[0] - p0[0]) / 8, d = (px[1] - p0[1]) / 8, e = (py[1] - p0[1]) / 8;
  return [a, b, p0[0] - a * x - b * y, d, e, p0[1] - d * x - e * y];
}

// ---------------------------------------------------------------------------
// text lines below a staff
// ---------------------------------------------------------------------------
function findTextLines(ctx, img, st, order, events, sp) {
  const { w, h } = ctx;
  const xa = clamp(Math.round(st.x0 - 2.5 * sp), 0, w - 1), xb = clamp(Math.round(st.x1 + 1 * sp), 0, w - 1);
  const bottomAt = (x) => st.lines[4][clamp(Math.round(x), 0, w - 1)];
  // the next staff below (any system) limits the search band
  const below = order.filter(o => o !== st && o.top > st.bottom && o.x1 > st.x0 && o.x0 < st.x1).sort((a, b) => a.top - b.top)[0];
  const limitAt = (x) => {
    const xi = clamp(Math.round(x), 0, w - 1);
    const lim = st.lines[4][xi] + 16 * sp;
    return below ? Math.min(lim, below.lines[0][xi] - 1.0 * sp) : lim;
  };
  let yMin = Infinity, yMax = -Infinity;
  for (let x = xa; x <= xb; x += 4) { yMin = Math.min(yMin, bottomAt(x) + 0.3 * sp); yMax = Math.max(yMax, limitAt(x)); }
  const y0 = clamp(Math.floor(yMin), 0, h - 1), y1 = clamp(Math.ceil(yMax), 0, h - 1);
  if (y1 - y0 < 1.0 * sp) return [];
  const R = labelRect(textBinary(ctx, img, xa, y0, xb, y1), xb - xa + 1, 0, 0, xb - xa, y1 - y0);
  shiftRect(R, xa, y0);
  // music symbols: note / rest boxes of any staff, grown a little
  const boxes = [];
  for (const ev of events || []) {
    const b = ev.bbox; if (!b) continue;
    if (b.y1 < y0 - sp || b.y0 > y1 + sp) continue;
    boxes.push({ x0: b.x0 - 0.15 * sp, y0: b.y0 - 0.15 * sp, x1: b.x1 + 0.15 * sp, y1: b.y1 + 0.15 * sp });
  }
  const keep = [];
  for (const c of R.comps) {
    if (!c) continue;
    if (c.y0 <= y0) continue;                                                      // cut by the band top: continues into the staff (clef, stems, accidentals)
    const xc = (c.x0 + c.x1) / 2;
    const bot = bottomAt(xc);
    if (c.y1 < bot + 0.5 * sp || c.y0 > limitAt(xc)) continue;
    if (c.h > 3.4 * sp || c.w > 5 * sp) continue;                                  // slurs, beams, brackets
    if (c.w > 2.6 * sp && c.h < 0.45 * sp) continue;                               // extender / hairpin / ledger lines
    if (c.w > 2.0 * sp && c.area < 0.12 * c.w * c.h) continue;                     // thin arcs
    let music = false;
    const ca = c.w * c.h;
    for (const b of boxes) {
      const ox = Math.min(c.x1, b.x1) - Math.max(c.x0, b.x0), oy = Math.min(c.y1, b.y1) - Math.max(c.y0, b.y0);
      if (ox > 0 && oy > 0 && ox * oy > 0.25 * ca) { music = true; break; }
    }
    if (music) continue;
    c.rel0 = c.y0 - bottomAt(xc); c.rel1 = c.y1 - bottomAt(xc);
    keep.push(c);
  }
  if (!keep.length) return [];
  // row profile in staff-relative coordinates (robust to tilt / page curl);
  // each component counts with its width, capped so that stray wide marks do not dominate
  const nRows = Math.ceil(17 * sp) + 2;
  const prof = new Float32Array(nRows);
  for (const c of keep) {
    if (c.area < 3) continue;
    const wgt = Math.min(c.w, 1.5 * sp);
    for (let r = Math.max(0, Math.floor(c.rel0)); r <= Math.min(nRows - 1, Math.ceil(c.rel1)); r++) prof[r] += wgt;
  }
  let pk = 0; for (let r = 0; r < nRows; r++) pk = Math.max(pk, prof[r]);
  if (pk < 0.8 * sp) return [];
  const thr = Math.max(1, 0.06 * pk);
  const runs = [];
  for (let r = 0; r < nRows;) {
    if (prof[r] < thr) { r++; continue; }
    let r2 = r; while (r2 < nRows && prof[r2] >= thr) r2++;
    runs.push([r, r2 - 1]); r = r2;
  }
  // split runs at deep valleys (two verse lines touching through stray marks)
  const cores = [];
  for (const [ra, rb] of runs) {
    let m = 0; for (let r = ra; r <= rb; r++) m = Math.max(m, prof[r]);
    const hi = 0.3 * m;
    for (let r = ra; r <= rb;) {
      if (prof[r] < hi) { r++; continue; }
      let r2 = r; while (r2 <= rb && prof[r2] >= hi) r2++;
      cores.push([r, r2 - 1]); r = r2;
    }
  }
  // every component joins exactly one line: the core band it overlaps most (or is nearest to)
  const good = cores.filter(([a, b]) => b - a + 1 >= 0.45 * sp && b - a + 1 <= 4.5 * sp);
  const members = good.map(() => []);
  for (const c of keep) {
    const hh = c.rel1 - c.rel0 + 1;
    let bi = -1, bs = -Infinity;
    good.forEach(([ca0, cb0], k) => {
      const cH = cb0 - ca0 + 1;
      const ov = Math.min(c.rel1, cb0) - Math.max(c.rel0, ca0) + 1;
      let sc;
      if (ov >= 0.5 * hh) sc = 1 + ov / hh;                                           // mostly inside
      else if (c.rel0 >= ca0 - 0.35 * cH && c.rel1 <= cb0 + 0.35 * cH && hh < 0.5 * cH) // small mark next to the band
        sc = 0.5 - Math.max(ca0 - c.rel1, c.rel0 - cb0, 0) / cH;
      else return;
      if (sc > bs) { bs = sc; bi = k; }
    });
    if (bi >= 0) members[bi].push(c);
  }
  const lines = [];
  good.forEach(([ca0, cb0], k) => { if (members[k].length) lines.push({ st, comps: members[k], R, ra: ca0, rb: cb0, bottomAt, yAt: bottomAt }); });
  return lines;
}

// ---------------------------------------------------------------------------
// segmentation: components → atoms (vertical stacks) → tokens (syllables)
// ---------------------------------------------------------------------------
function segmentLine(line, reader, sp) {
  const comps = line.comps.slice().sort((a, b) => a.x0 - b.x0);
  // atoms: components overlapping horizontally (stacked jamo, ㅎ dots …)
  const atoms = [];
  for (const c of comps) {
    const a = atoms.find(t => {
      const ov = Math.min(t.x1, c.x1) - Math.max(t.x0, c.x0) + 1;
      const stacked = ov >= 1 && (c.rel0 > t.rel1 || c.rel1 < t.rel0);          // one above the other (방: ㅂ over ㅇ)
      return ov >= 0.4 * Math.min(t.w, c.w) || stacked || (c.cx >= t.x0 && c.cx <= t.x1);
    });
    if (a) { a.comps.push(c); a.x0 = Math.min(a.x0, c.x0); a.x1 = Math.max(a.x1, c.x1); a.y0 = Math.min(a.y0, c.y0); a.y1 = Math.max(a.y1, c.y1); a.w = a.x1 - a.x0 + 1; a.area += c.area; a.rel0 = Math.min(a.rel0, c.rel0); a.rel1 = Math.max(a.rel1, c.rel1); }
    else atoms.push({ comps: [c], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, w: c.w, area: c.area, rel0: c.rel0, rel1: c.rel1 });
  }
  // a second pass merges atoms that became overlapping after growing
  atoms.sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i + 1 < atoms.length;) {
    const a = atoms[i], b = atoms[i + 1];
    const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
    const stacked = ov >= 1 && (b.rel0 > a.rel1 || b.rel1 < a.rel0);
    if (ov >= 0.4 * Math.min(a.w, b.x1 - b.x0 + 1) || stacked) {
      a.comps.push(...b.comps); a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1); a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
      a.w = a.x1 - a.x0 + 1; a.area += b.area; a.rel0 = Math.min(a.rel0, b.rel0); a.rel1 = Math.max(a.rel1, b.rel1);
      atoms.splice(i + 1, 1);
    } else i++;
  }
  for (const a of atoms) a.h = a.rel1 - a.rel0 + 1;
  // provisional Hangul ink band from the tall atoms
  const hs = atoms.map(a => a.h).sort((x, y) => x - y);
  const h90 = hs[Math.min(hs.length - 1, Math.floor(0.9 * (hs.length - 1)))];
  const tall = atoms.filter(a => a.h >= 0.6 * h90 && a.w >= 0.25 * h90);
  if (!tall.length) return [];
  let top = median(tall.map(a => a.rel0 - 0.3)), bot = median(tall.map(a => a.rel1 + 0.3));
  let H = bot - top;
  if (!(H >= 0.6 * sp && H <= 4.5 * sp)) return [];
  line.mid = (top + bot) / 2; line.H = H; line.top = top; line.bot = bot;
  // thin flat fragments (broken hairlines, e.g. the bar of ㅗ in light serif
  // fonts) belong to the atom they nearly touch, not to a punctuation token
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (!(a.h <= Math.max(1.5, 0.08 * H) && a.w < 0.4 * H)) continue;
    let best = -1, bg = 0.12 * H;
    for (const j of [i - 1, i + 1]) {
      const b = atoms[j]; if (!b || b.h <= Math.max(1.5, 0.08 * H)) continue;
      const g = j < i ? a.x0 - b.x1 - 1 : b.x0 - a.x1 - 1;
      if (g <= bg && a.rel0 >= b.rel0 - 1 && a.rel1 <= b.rel1 + 1) { bg = g; best = j; }
    }
    if (best < 0) continue;
    const b = atoms[best];
    b.comps.push(...a.comps); b.x0 = Math.min(b.x0, a.x0); b.x1 = Math.max(b.x1, a.x1); b.w = b.x1 - b.x0 + 1; b.area += a.area;
    atoms.splice(i, 1); i--;
  }
  // split very wide atoms (touching syllables) at projection minima
  const R = line.R;
  const parts = [];
  for (const a of atoms) {
    if (a.w > 1.45 * H && a.h >= 0.6 * H) parts.push(...splitWide(a, R, H)); else parts.push(a);
  }
  // tokens: small atoms stay alone (punctuation); others are grouped by a
  // recognition-driven DP between forced boundaries (large gaps)
  const tokOf = (list) => {
    const t = { atoms: list, x0: Math.min(...list.map(a => a.x0)), x1: Math.max(...list.map(a => a.x1)), y0: Math.min(...list.map(a => a.y0)), y1: Math.max(...list.map(a => a.y1)),
      rel0: Math.min(...list.map(a => a.rel0)), rel1: Math.max(...list.map(a => a.rel1)) };
    t.w = t.x1 - t.x0 + 1; t.h = t.rel1 - t.rel0 + 1; return t;
  };
  const memo = new Map();
  const read = (tok) => {
    if (tok.res) return tok.res;
    const key = tok.atoms.map(a => a.x0 + ':' + a.x1).join('|');
    tok.res = memo.get(key) || reader.read(tok, line, maskFn(R, tok));
    memo.set(key, tok.res);
    return tok.res;
  };
  // quick look first: a line whose widest blocks are not Hangul is not Korean lyrics
  const probe = parts.filter(a => a.w >= 0.6 * H && a.w <= 1.2 * H && a.h >= 0.6 * H).sort((a, b) => b.w - a.w).slice(0, 6);
  if (probe.length >= 3) {
    const hits = probe.filter(a => { const r = read(tokOf([a])); return r.kind === 'hangul' && r.conf >= 0.5; }).length;
    if (hits === 0) return [];
  }
  const tokens = [];
  let seg = [];
  const flush = () => { if (seg.length) tokens.push(...segmentRun(seg, H, tokOf, read)); seg = []; };
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    const small = a.h < 0.45 * H && a.w < 0.6 * H;
    const low = a.rel0 >= top + 0.55 * H, high = a.rel1 <= top + 0.4 * H;
    if (small && (low || high)) { flush(); tokens.push(tokOf([a])); continue; }
    if (seg.length) { const gap = a.x0 - seg[seg.length - 1].x1 - 1; if (gap >= 0.4 * H) flush(); }
    seg.push(a);
  }
  flush();
  for (const t of tokens) read(t);
  return tokens;
}

/** Mask for a token's em-box: true near ink of any other component, so the
 * crop shows the token alone (as in training). */
function maskFn(R, tok) {
  const own = new Uint8Array(R.comps.length + 1);
  for (const a of tok.atoms) for (const c of a.comps) own[c.id] = 1;
  const { lab, rw, rh, x0, y0 } = R;
  return (x, y) => {
    const xi = Math.round(x) - x0, yi = Math.round(y) - y0;
    const ya = Math.max(0, yi - 1), yb = Math.min(rh - 1, yi + 1), xa = Math.max(0, xi - 1), xb = Math.min(rw - 1, xi + 1);
    for (let yy = ya; yy <= yb; yy++) { const row = yy * rw; for (let xx = xa; xx <= xb; xx++) { const l = lab[row + xx]; if (l && !own[l]) return true; } }
    return false;
  };
}

function splitWide(a, R, H) {
  const { lab, rw, x0: rx, y0: ry } = R;
  const ids = new Set(a.comps.map(c => c.id));
  const proj = new Float32Array(a.w);
  for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) if (ids.has(lab[(y - ry) * rw + x - rx])) proj[x - a.x0]++;
  const n = Math.max(2, Math.round(a.w / (0.95 * H)));
  const cuts = [];
  for (let k = 1; k < n; k++) {
    const c = Math.round(k * a.w / n);
    let best = c, bv = Infinity;
    for (let x = Math.max(1, c - Math.round(0.3 * H)); x <= Math.min(a.w - 2, c + Math.round(0.3 * H)); x++) if (proj[x] < bv) { bv = proj[x]; best = x; }
    cuts.push(best);
  }
  const out = [];
  let prev = 0;
  for (const c of [...cuts, a.w]) {
    if (c - prev >= 2) out.push({ comps: a.comps, x0: a.x0 + prev, x1: a.x0 + c - 1, y0: a.y0, y1: a.y1, w: c - prev, area: a.area * (c - prev) / a.w, rel0: a.rel0, rel1: a.rel1, h: a.h, piece: true });
    prev = c;
  }
  return out.length ? out : [a];
}

/** Groups consecutive atoms (no large gap between them) into tokens: a
 * shape-only DP (Hangul syllables are ≈ 0.75–1.05 band heights wide, gaps
 * inside a syllable are small) proposes the split; tokens whose reading is
 * doubtful are re-segmented locally by a recognition-driven DP. */
function segmentRun(seg, H, tokOf, read) {
  const n = seg.length;
  if (n === 1) return [tokOf(seg)];
  const gapAfter = (k) => (seg[k + 1].x0 - seg[k].x1 - 1) / H;
  const shape = (i, j) => {
    const W = (seg[j - 1].x1 - seg[i].x0 + 1) / H;
    const gb = i > 0 ? gapAfter(i - 1) : 1;                 // gap before this token
    const cut = gb < 0.08 ? 2.0 * (0.08 - gb) / 0.08 : 0;   // splitting touching ink is unlikely
    let g = 0; for (let k = i; k < j - 1; k++) g = Math.max(g, gapAfter(k));     // ≥ 0: overlapping atoms have no gap
    let r0 = Infinity, r1 = -Infinity; for (let k = i; k < j; k++) { r0 = Math.min(r0, seg[k].rel0); r1 = Math.max(r1, seg[k].rel1); }
    const hgt = (r1 - r0 + 1) / H;
    let sc = 1.5;
    if (W < 0.55) sc -= hgt < 0.6 ? 0.5 : 3;
    else if (W <= 1.15) sc -= 0.5 * ((W - 0.88) / 0.15) ** 2;
    else sc -= 3 + 30 * (W - 1.15);
    return sc - (g / 0.12) ** 2 - cut;
  };
  const best = new Float64Array(n + 1).fill(-Infinity), from = new Int32Array(n + 1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) for (let i = j - 1; i >= Math.max(0, j - 5); i--) {
    if (j - i > 1 && seg[j - 1].x1 - seg[i].x0 + 1 > 1.45 * H) break;
    const v = best[i] + shape(i, j);
    if (v > best[j]) { best[j] = v; from[j] = i; }
  }
  const ranges = [];
  for (let j = n; j > 0; j = from[j]) ranges.unshift([from[j], j]);
  // read; doubtful tokens are re-segmented with recognition (with their neighbours)
  const toks = ranges.map(([i, j]) => ({ i, j, t: tokOf(seg.slice(i, j)) }));
  const doubtful = toks.map(({ t }) => { const r = read(t); return r.kind === 'noise' || r.conf < 0.4 || (r.kind === 'symbol' && isLatin(r.text)) || (r.kind === 'hangul' && t.w < 0.5 * H); });
  if (!doubtful.some(Boolean)) return toks.map(x => x.t);
  const out = [];
  for (let k = 0; k < toks.length;) {
    if (!doubtful[k]) { out.push(toks[k].t); k++; continue; }
    let a = k, b = k;
    while (b + 1 < toks.length && doubtful[b + 1]) b++;
    const lo = a > 0 && !doubtful[a - 1] ? a - 1 : a, hi = b + 1 < toks.length ? b + 1 : b;
    if (lo < a) out.pop();
    out.push(...dpSegment(seg.slice(toks[lo].i, toks[hi].j), H, tokOf, read));
    k = hi + 1;
  }
  return out;
}

/** Recognition-driven grouping: maximises Σ log(conf/τ) with shape priors. */
function dpSegment(seg, H, tokOf, read) {
  const n = seg.length;
  if (n === 1) return [tokOf(seg)];
  const width = (i, j) => seg[j].x1 - seg[i].x0 + 1;
  const TAU = Math.log(0.35);
  const best = new Float64Array(n + 1).fill(-Infinity), from = new Int32Array(n + 1);
  const cache = new Map();
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= Math.max(0, j - 4); i--) {
      const W = width(i, j - 1);
      if (W > 1.4 * H && j - i > 1) break;
      const key = i * 1000 + j;
      let tok = cache.get(key);
      if (!tok) { tok = tokOf(seg.slice(i, j)); cache.set(key, tok); }
      const s = tokenScore(read(tok), W / H) - TAU;
      if (best[i] + s > best[j]) { best[j] = best[i] + s; from[j] = i; }
    }
  }
  const out = [];
  for (let j = n; j > 0; j = from[j]) out.unshift(cache.get(from[j] * 1000 + j));
  return out;
}

function tokenScore(r, wr) {
  let c = r.conf;
  if (r.kind === 'noise') c = 0.02;
  else if (r.kind === 'symbol' && isLatin(r.text)) c *= 0.3;
  if (r.kind === 'hangul' && wr < 0.5) c *= 0.3;
  if (r.kind === 'hangul' && wr > 1.3) c *= 0.3;
  return Math.log(Math.max(c, 1e-4));
}

// ---------------------------------------------------------------------------
// tokens → syllables of a lyric line
// ---------------------------------------------------------------------------
function interpretLine(tokens, line) {
  if (!tokens.length) return null;
  const H = line.H;
  // a lyric line: confidently read, syllable-shaped Hangul tokens dominate
  // (Latin lyrics, dynamics, fingering or stray marks do not qualify)
  const syllableShaped = (t) => t.h >= 0.45 * H && t.w >= 0.45 * H;
  const nH = tokens.filter(t => t.res.kind === 'hangul' && t.res.conf >= 0.5 && syllableShaped(t)).length;
  const nWeak = tokens.filter(t => t.res.kind === 'hangul' && !(t.res.conf >= 0.5 && syllableShaped(t))).length;
  const nOther = tokens.filter(t => t.res.kind === 'symbol' && !CLOSING.has(t.res.text) && !OPENING.has(t.res.text) && t.res.text !== '-').length;
  if (nH < 2 || nH < 0.6 * (nH + nWeak + nOther)) return null;
  // verse number at the start ("1." / "2" left of the first syllable)
  let verseNumber = 0, start = 0;
  const firstH = tokens.findIndex(t => t.res.kind === 'hangul');
  if (firstH > 0) {
    const t0 = tokens[0];
    const digitRes = isDigit(t0.res.text) ? t0.res : (t0.res.alts || []).find(a => isDigit(a.text) && a.conf > 0.2);
    if (digitRes && (t0.res.kind === 'symbol' || digitRes.conf > 0.2) && digitRes.text !== '0') {
      verseNumber = +digitRes.text; start = 1;
      while (start < firstH && ['.', ')', ':'].includes(tokens[start].res.text)) start++;
    }
  }
  const syl = [];
  let pendingPrefix = '';
  // a syllable must sit in the line's ink band (ties, ledger lines, accidental tails do not)
  const inBand = (t) => { const ov = Math.min(t.rel1, line.bot) - Math.max(t.rel0, line.top); return ov >= 0.6 * t.h && t.h >= 0.45 * H && t.h <= 1.6 * H; };
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i], r = t.res;
    if (r.kind === 'noise') continue;
    if ((r.kind === 'hangul' || isLatin(r.text)) && !inBand(t)) continue;
    if (r.kind === 'hangul' && t.w < 0.45 * H) continue;                 // far too narrow for a syllable
    if (r.kind === 'hangul' || (r.kind === 'symbol' && isLatin(r.text) && r.conf > 0.5)) {
      const prevS = syl[syl.length - 1];
      // Latin letters close together form one word-syllable
      if (r.kind === 'symbol' && prevS && prevS.latin && t.x0 - prevS.x1 < 0.35 * H) {
        prevS.text += r.text; prevS.x1 = t.x1; prevS.bx1 = t.x1; prevS.y0 = Math.min(prevS.y0, t.y0); prevS.y1 = Math.max(prevS.y1, t.y1); prevS.conf = Math.min(prevS.conf, r.conf); continue;
      }
      syl.push({ text: pendingPrefix + r.text, conf: r.conf, x0: t.x0, x1: t.x1, bx0: t.x0, bx1: t.x1, y0: t.y0, y1: t.y1, latin: r.kind === 'symbol',
        alts: (r.alts || []).filter(a => a.conf > 0.05).map(a => a.text).slice(0, 3) });
      pendingPrefix = '';
      continue;
    }
    const s = r.text;
    if (CLOSING.has(s) && syl.length && t.x0 - syl[syl.length - 1].x1 < 1.0 * H) { const q = syl[syl.length - 1]; q.text += s; q.bx1 = Math.max(q.bx1, t.x1); q.y1 = Math.max(q.y1, t.y1); continue; }
    if (OPENING.has(s) || s === '"' || s === "'") { pendingPrefix += s; continue; }
    // '-' between Korean syllables and anything else unattached is dropped
  }
  // Latin letters inside a Korean line: keep real words only (no dynamics, no single letters)
  const DYN = /^(p+|f+|mp|mf|sf|sfz|fp|fz|rfz|sfp)$/;
  const kept = syl.filter(s => !s.latin || (s.text.replace(/[^A-Za-z]/g, '').length >= 2 && s.conf > 0.7 && !DYN.test(s.text.replace(/[^A-Za-z]/g, ''))));
  if (kept.filter(s => !s.latin).length < 2) return null;
  syl.length = 0; syl.push(...kept);
  for (const s of syl) s.x = (s.x0 + s.x1) / 2;
  return { syllables: syl, verseNumber, x0: Math.min(...tokens.map(t => t.x0)), x1: Math.max(...tokens.map(t => t.x1)), y0: Math.min(...tokens.map(t => t.y0)), y1: Math.max(...tokens.map(t => t.y1)) };
}

// ---------------------------------------------------------------------------
// syllables → notes
// ---------------------------------------------------------------------------
function staffNotes(events, st, evById) {
  return (events || []).filter(ev => ev.kind === 'note' && ev.staff === st && ev.eventId && evById.has(ev.eventId))
    .map(ev => ({ ev, x: ev.heads && ev.heads.length ? ev.heads.reduce((a, hd) => a + hd.cx, 0) / ev.heads.length : ev.x, tieEnd: !!ev.tieEnd, grace: !!ev.grace }))
    .sort((a, b) => a.x - b.x);
}

/** Monotonic alignment of syllables (by x) to notes; notes may stay empty
 * (melisma, tied continuation) and stray syllables may stay unassigned. */
function assignSyllables(syl, notes, sp) {
  const K = syl.length, M = notes.length;
  for (const s of syl) { s.note = null; s.assignConf = 0; }
  if (!K || !M) return;
  const SKIP = 0.15, DROP = 3.0;
  const match = (k, j) => { const d = Math.abs(syl[k].x - notes[j].x) / sp; return Math.min(d, 6) * 0.8 + (notes[j].tieEnd ? 1.2 : 0) + (notes[j].grace ? 2 : 0); };
  const D = new Float64Array((K + 1) * (M + 1)), P = new Uint8Array((K + 1) * (M + 1));
  const at = (k, j) => k * (M + 1) + j;
  for (let j = 1; j <= M; j++) { D[at(0, j)] = D[at(0, j - 1)] + SKIP; P[at(0, j)] = 2; }
  for (let k = 1; k <= K; k++) { D[at(k, 0)] = D[at(k - 1, 0)] + DROP; P[at(k, 0)] = 1; }
  for (let k = 1; k <= K; k++) for (let j = 1; j <= M; j++) {
    const m = D[at(k - 1, j - 1)] + match(k - 1, j - 1), dr = D[at(k - 1, j)] + DROP, sk = D[at(k, j - 1)] + SKIP;
    if (m <= dr && m <= sk) { D[at(k, j)] = m; P[at(k, j)] = 0; } else if (sk <= dr) { D[at(k, j)] = sk; P[at(k, j)] = 2; } else { D[at(k, j)] = dr; P[at(k, j)] = 1; }
  }
  let k = K, j = M;
  while (k > 0 && j > 0) {
    const p = P[at(k, j)];
    if (p === 0) { const s = syl[k - 1], n = notes[j - 1]; s.note = n; const d = Math.abs(s.x - n.x) / sp; s.assignConf = clamp(1.25 - d / 2, 0.3, 1); k--; j--; }
    else if (p === 2) j--; else k--;
  }
}

/** Lyric stage for omr.js `recognize()`: fills out.lyrics / out.lyricLines,
 * writes the syllables into out.score and appends warnings. Never throws. */
export function runLyricStage(out, { ctx, staves, events, image, nolines, options = {}, progress = null }) {
  out.lyrics = []; out.lyricLines = [];
  // evaluation hook: lets a tool re-run recognizeLyrics() on the same music result
  if (typeof options.onLyricStage === 'function') { try { options.onLyricStage({ ctx, staves, events, image, nolines, score: out.score }); } catch (_) { /* tool error */ } }
  if (options.lyrics === false) return out;
  try {
    if (progress) progress('assemble', 92, '가사 인식 중…');
    const r = recognizeLyrics({ ctx, staves, events, score: out.score, image, nolines });
    out.lyrics = r.lyrics; out.lyricLines = r.lines; out.lyricStats = r.stats;
    if (r.warnings.length && Array.isArray(out.warnings)) out.warnings.push(...r.warnings);
  } catch (e) { out.lyricError = String((e && e.message) || e); }
  return out;
}
