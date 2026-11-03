// Lyric metrics for run_eval.mjs (ground truth from gen_lyrics_corpus.py:
// note events carry `lyrics: [{verse, text, bbox}]`).
//
//  - detection recall   : GT syllables whose box is matched (IoU ≥ 0.3) by a
//                         syllable box of result.lyrics
//  - recognition acc    : matched GT syllables read with exactly the GT text
//                         (incl. attached punctuation)
//  - line char accuracy : 1 − edit distance / GT characters per verse between the
//                         GT lyric text and the text read (result.lyrics in
//                         reading order) — independent of note recognition
//  - char accuracy      : 1 − edit distance / GT characters, per staff and verse,
//                         between the GT lyric text and the lyrics stored in
//                         the recognised score (reading order)
//  - assignment acc     : GT syllables whose note was recognised (aligned in the
//                         note sequence) and whose recognised note carries a
//                         syllable of the same verse; "text+note" also needs
//                         the same text
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');

export function hasLyricsGT(gt) {
  return gt.measures.some(m => m.staves.some(evs => evs.some(e => e.lyrics && e.lyrics.length)));
}

function gtEvents(gt, si) {
  const out = [];
  for (const m of gt.measures) for (const e of m.staves[si] || []) out.push({ kind: e.kind, pitches: e.kind === 'note' ? e.pitches.slice().sort() : [], dur: e.base + (e.dots ? '.' : ''), lyrics: e.lyrics || [] });
  return out;
}
const pitchStr = (n) => n.step + ({ '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' }[n.alter || 0]) + n.octave;
function detEvents(score, si) {
  const out = [];
  for (const m of score.measures) for (const e of (m.staves[si]?.voices[0] || [])) out.push({ kind: e.kind, pitches: e.kind === 'note' ? e.notes.map(pitchStr).sort() : [], dur: e.dur.base + (e.dur.dots ? '.' : ''), lyrics: e.lyrics || [] });
  return out;
}
function subCost(a, b) {
  if (a.kind !== b.kind) return 0.95;
  if (a.kind === 'rest') return a.dur === b.dur ? 0 : 0.4;
  const p = a.pitches.length === b.pitches.length && a.pitches.every((x, i) => x === b.pitches[i]), d = a.dur === b.dur;
  return p && d ? 0 : p || d ? 0.4 : 0.75;
}
function align(A, B) {
  const n = A.length, m = B.length;
  const D = new Float64Array((n + 1) * (m + 1)), P = new Uint8Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) { D[at(i, 0)] = i; P[at(i, 0)] = 1; }
  for (let j = 1; j <= m; j++) { D[at(0, j)] = j; P[at(0, j)] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const s = D[at(i - 1, j - 1)] + subCost(A[i - 1], B[j - 1]), del = D[at(i - 1, j)] + 1, ins = D[at(i, j - 1)] + 1;
    if (s <= del && s <= ins) { D[at(i, j)] = s; P[at(i, j)] = 0; } else if (del <= ins) { D[at(i, j)] = del; P[at(i, j)] = 1; } else { D[at(i, j)] = ins; P[at(i, j)] = 2; }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const p = P[at(i, j)];
    if (i > 0 && j > 0 && p === 0) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && (p === 1 || j === 0)) { pairs.push([i - 1, null]); i--; }
    else { pairs.push([null, j - 1]); j--; }
  }
  return pairs.reverse();
}
function editDistance(a, b) {
  const n = a.length, m = b.length;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}
const iou = (a, b) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  if (x1 <= x0 || y1 <= y0) return 0;
  const i = (x1 - x0) * (y1 - y0);
  return i / (a[2] * a[3] + b[2] * b[3] - i);
};

export function lyricMetrics(gt, res) {
  const m = { gtSyl: 0, detSyl: (res.lyrics || []).length, boxMatched: 0, boxTextOk: 0, lineChars: 0, lineEdits: 0, chars: 0, charEdits: 0, assignTotal: 0, assignOk: 0, assignTextOk: 0, lowConf: 0, lowConfWrong: 0, wrong: 0 };
  if (!hasLyricsGT(gt)) return m;
  // --- box matching (recognition independent of note assignment) -------------
  const det = (res.lyrics || []).map(l => ({ ...l, used: false }));
  const gtSyl = [];
  for (const mm of gt.measures) mm.staves.forEach((evs, si) => { for (const e of evs) for (const l of e.lyrics || []) gtSyl.push({ ...l, si }); });
  m.gtSyl = gtSyl.length;
  for (const g of gtSyl) {
    let best = null, bv = 0.3;
    for (const d of det) { if (d.used) continue; const v = iou(g.bbox, d.bbox); if (v >= bv) { bv = v; best = d; } }
    if (!best) continue;
    best.used = true; m.boxMatched++;
    if (best.text === g.text) m.boxTextOk++;
    else { m.wrong++; if (best.lowConfidence) m.lowConfWrong++; }
  }
  m.lowConf = det.filter(d => d.lowConfidence).length;
  // --- text read per verse, reading order (systems top→bottom, then x) ---------
  const verses = new Set(gtSyl.map(g => g.verse));
  for (const v of verses) {
    const g = [...gtSyl.filter(x => x.verse === v).map(x => x.text).join('')];
    const d = [...(res.lyrics || []).filter(x => x.verse === v).sort((a, b) => (a.systemIndex - b.systemIndex) || (a.staffIndex - b.staffIndex) || (a.bbox[0] - b.bbox[0])).map(x => x.text).join('')];
    m.lineChars += g.length;
    m.lineEdits += editDistance(g, d);
  }
  // --- sequences per staff / verse -------------------------------------------
  const nStaves = gt.staffCount;
  for (let si = 0; si < nStaves; si++) {
    const G = gtEvents(gt, si), D = res.score ? detEvents(res.score, si) : [];
    const verses = new Set(G.flatMap(e => e.lyrics.map(l => l.verse)));
    for (const v of verses) {
      const gtText = [...G.flatMap(e => e.lyrics.filter(l => l.verse === v).map(l => l.text)).join('')];
      const dtText = [...D.flatMap(e => e.lyrics.filter(l => (l.verse || 1) === v).map(l => l.text)).join('')];
      m.chars += gtText.length;
      m.charEdits += editDistance(gtText, dtText);
    }
    for (const [i, j] of align(G, D)) {
      if (i == null) continue;
      for (const l of G[i].lyrics) {
        if (j == null || G[i].kind !== 'note' || D[j].kind !== 'note') continue;
        m.assignTotal++;
        const dl = D[j].lyrics.find(x => (x.verse || 1) === l.verse);
        if (dl) { m.assignOk++; if (dl.text === l.text) m.assignTextOk++; }
      }
    }
  }
  return m;
}

export function lyricSummary(rows) {
  const s = rows.reduce((acc, r) => { for (const k of Object.keys(r.lm || {})) acc[k] = (acc[k] || 0) + r.lm[k]; return acc; }, {});
  return {
    pages: rows.filter(r => r.lm && r.lm.gtSyl).length, gtSyl: s.gtSyl || 0, detRecall: pct(s.boxMatched, s.gtSyl), recogAcc: pct(s.boxTextOk, s.boxMatched),
    lineCharAcc: s.lineChars ? (100 * (1 - s.lineEdits / s.lineChars)).toFixed(1) + '%' : '-',
    charAcc: s.chars ? (100 * (1 - s.charEdits / s.chars)).toFixed(1) + '%' : '-', assignAcc: pct(s.assignOk, s.assignTotal), assignTextAcc: pct(s.assignTextOk, s.assignTotal),
    flaggedErr: pct(s.lowConfWrong, s.wrong), lyricMs: rows.length ? Math.round(rows.reduce((a, r) => a + (r.lyricMs || 0), 0) / rows.length) + ' ms' : '-',
  };
}

/** Markdown section for the evaluation report (empty when no GT has lyrics). */
export function lyricReport(rows, groups) {
  const withL = rows.filter(r => r.lm && r.lm.gtSyl);
  if (!withL.length) return [];
  const head = ['group', 'pages', 'GT syllables', 'detected (box)', 'read correctly (matched boxes)', 'lyric char accuracy (text read)', 'char accuracy in score', 'on the right note', 'right text on the right note', 'errors flagged', 'lyric stage'];
  const lines = ['## Lyrics', '', '| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  for (const g of [...groups, 'ALL']) {
    const rs = (g === 'ALL' ? withL : withL.filter(r => r.group === g));
    if (!rs.length) continue;
    const s = lyricSummary(rs);
    lines.push(`| ${g} | ${s.pages} | ${s.gtSyl} | ${s.detRecall} | ${s.recogAcc} | ${s.lineCharAcc} | ${s.charAcc} | ${s.assignAcc} | ${s.assignTextAcc} | ${s.flaggedErr} | ${s.lyricMs} |`);
  }
  lines.push('', 'detected = GT syllable boxes matched by a recognised syllable box (IoU ≥ 0.3); read correctly = exact text incl. punctuation;',
    'lyric char accuracy = 1 − edit distance / GT characters per verse, GT text vs. result.lyrics in reading order (independent of note recognition);',
    'char accuracy in score = the same for the lyrics stored on the recognised notes (missed / extra notes lose syllables);',
    'on the right note = GT syllables whose note was recognised and carries a syllable of that verse (text+note: and the same text);',
    'errors flagged = misread syllables marked lowConfidence in result.lyrics; lyric stage = mean extra time per page.', '');
  return lines;
}
