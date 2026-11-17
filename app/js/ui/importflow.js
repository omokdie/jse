// Opening score files written by other notation programs.
//   MuseScore (.mscz/.mscx), NoteWorthy Composer (.nwc/.nwctxt) and MIDI are converted to a ScoreDoc;
//   closed formats (Sibelius .sib, old Finale .mus, Encore …) get a short how-to for the MusicXML route.
import { showDialog } from './dialogs.js';
import { FOREIGN_SCORE_FORMATS } from '../io/ssnap.js';
import { pickFiles } from '../native.js';
import { escapeXml } from '../engrave/text.js';

const toSsnap = name => String(name || 'score').replace(/\.[^./\\]+$/, '') + '.ssnap';
/** Last text-encoding-dependent import ({ kind, name, bytes }) — kept so it can be re-read with another encoding. */
let lastEncoded = null;

function koreanUi(app) { return (app.settings?.lang || 'ko') === 'ko' || /^ko\b/i.test(navigator.language || ''); }

function noteWarnings(ui, label, score) {
  const w = score.importInfo?.warnings || [];
  if (w.length) setTimeout(() => ui.toast(`${label} 파일을 가져왔습니다. 참고: ${w.slice(0, 2).join(' · ')}${w.length > 2 ? ` 외 ${w.length - 2}건` : ''}`, 'info', { timeout: 8000 }), 600);
}

/** Open `f` ({ name, blob, kind }) — returns true when a score was loaded into the editor. */
export async function openForeign(ui, f) {
  if (FOREIGN_SCORE_FORMATS[f.kind]) { await foreignGuide(ui, f.kind); return false; }
  const app = ui.app;
  if (f.kind === 'musescore') {
    const busy = ui.toast('MuseScore 파일을 변환하는 중…', 'info', { timeout: 0 });
    try {
      const mod = await import('../io/mscz.js');
      const score = await mod.importMscz(await f.blob.arrayBuffer(), { fileName: f.name });
      app.setScore(score, { fileName: toSsnap(f.name) }); app.dirty = true;
      noteWarnings(ui, 'MuseScore', score);
      return true;
    } finally { busy?.remove(); }
  }
  if (f.kind === 'nwc' || f.kind === 'midi') {
    const bytes = await f.blob.arrayBuffer();
    lastEncoded = { kind: f.kind, name: f.name, bytes };
    return loadEncoded(ui, 'auto');
  }
  return false;
}

async function loadEncoded(ui, encoding) {
  const { kind, name, bytes } = lastEncoded;
  const app = ui.app;
  const label = kind === 'nwc' ? 'NWC' : 'MIDI';
  const busy = ui.toast(`${label} 파일을 변환하는 중…`, 'info', { timeout: 0 });
  try {
    const opts = { encoding, fallbackEncoding: koreanUi(app) ? 'euc-kr' : 'windows-1252', fileName: name };
    let score, encodings = [];
    if (kind === 'nwc') { const mod = await import('../io/nwc.js'); score = await mod.importNwc(bytes.slice(0), opts); encodings = mod.NWC_ENCODINGS || []; }
    else {
      let mod; try { mod = await import('../io/midi-import.js'); } catch { ui.toast('MIDI 가져오기는 아직 지원하지 않습니다. MusicXML이나 사진을 사용하세요.', 'warn'); return false; }
      score = await mod.importMidi(bytes.slice(0), opts); encodings = mod.MIDI_ENCODINGS || (await import('../io/nwc.js').then(m => m.NWC_ENCODINGS, () => []));
    }
    app.setScore(score, { fileName: toSsnap(name) }); app.dirty = true;
    const info = score.importInfo || {};
    const hasText = textOf(score).length > 0;
    // text in old NWC files / MIDI lyrics has no declared encoding — offer a second try when it was a guess
    if (hasText && info.encoding && info.encoding !== 'utf-8' && encodings.length) {
      const encLabel = encodings.find(e => e.id === info.encoding)?.label || info.encoding;
      setTimeout(() => ui.toast(`${label} 파일을 가져왔습니다 · 글자: ${escapeXml(encLabel)}`, 'ok', { timeout: 10000, action: { label: '글자가 깨졌나요?', onClick: () => encodingDialog(ui, encodings, info.encoding) } }), 300);
    } else noteWarnings(ui, label, score);
    return true;
  } finally { busy?.remove(); }
}

/** All user-visible text of a score that depends on the file's text encoding (title, lyrics, texts). */
function textOf(score) {
  const out = [score.meta?.title, score.meta?.composer, score.meta?.lyricist].filter(Boolean);
  for (const m of score.measures || []) {
    for (const t of m.texts || []) out.push(t.text);
    for (const sm of m.staves || []) for (const v of sm.voices || []) for (const e of v) { for (const l of e.lyrics || []) out.push(l.text); for (const t of e.texts || []) out.push(t.text); }
  }
  return out.join('').replace(/[\x00-\x7f]/g, '');   // only non-ASCII characters can be mis-decoded
}

async function encodingDialog(ui, encodings, current) {
  const sample = () => { const s = ui.app.score; const ly = []; for (const m of s.measures) for (const sm of m.staves) for (const v of sm.voices) for (const e of v) for (const l of e.lyrics || []) { if (ly.length < 14) ly.push(l.text); } return [s.meta.title, ly.join(' ')].filter(Boolean).join(' — '); };
  const res = await showDialog({ title: '글자 인코딩 바꿔 다시 열기', body: `
      <p>옛 NWC·MIDI 파일은 글자를 만든 컴퓨터의 방식으로 저장해서, 자동 판별이 틀리면 가사나 제목이 깨져 보입니다. 맞는 언어를 고르면 같은 파일을 다시 읽습니다.</p>
      <div class="row"><label>지금 보이는 글자</label><div class="ctl"><span id="enc-sample" style="font-weight:600">${escapeXml(sample().slice(0, 80)) || '(글자 없음)'}</span></div></div>
      <div class="row"><label>인코딩</label><div class="ctl"><select id="enc-sel">${encodings.filter(e => e.id !== 'auto').map(e => `<option value="${e.id}" ${e.id === current ? 'selected' : ''}>${escapeXml(e.label || e.id)}</option>`).join('')}</select></div></div>`,
    buttons: [{ label: '닫기', value: null }, { label: '다시 열기', primary: true, value: r => r.querySelector('#enc-sel').value }] });
  if (!res || !lastEncoded) return;
  try { if (await loadEncoded(ui, res)) ui.afterOpen(lastEncoded.name); }
  catch (e) { console.error(e); ui.toast(`다시 열지 못했습니다: ${e.message}`, 'error', { timeout: 6000 }); }
}

/** "This file can't be opened directly — here is how" for closed formats. */
export async function foreignGuide(ui, kind) {
  const f = FOREIGN_SCORE_FORMATS[kind]; if (!f) return;
  const res = await showDialog({ title: `${f.name} 파일은 직접 열 수 없어요`, body: `
      <p>${f.why || `${f.name} 파일은 형식이 공개되어 있지 않아 다른 프로그램에서 직접 읽을 수 없습니다.`}</p>
      <h4>이렇게 하면 열 수 있어요</h4>
      <ol style="margin:6px 0 10px 20px;line-height:1.75">
        <li>${f.how}</li>
        <li>저장된 <b>.musicxml</b> 또는 <b>.mxl</b> 파일을 JSE에서 엽니다.</li>
      </ol>
      <p style="color:var(--muted)">음표·가사·코드·셈여림 같은 악보 내용이 그대로 옮겨집니다. 글꼴이나 간격 같은 세부 배치는 조금 달라질 수 있어요.</p>`,
    buttons: [{ label: '닫기', value: null }, { label: 'MusicXML 파일 열기', primary: true, value: 'open' }] });
  if (res === 'open') { const files = await pickFiles({ accept: '.musicxml,.xml,.mxl', multiple: false }); if (files.length) ui.openFiles(files); }
}
