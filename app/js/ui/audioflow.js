// Audio flow: pick an MP3/WAV/M4A/… → options → analyse in workers (progress, cancel) → review (original audio vs.
// transcription playback, re-quantise without re-running the network) → "편집기로 가져오기" / "현재 악보 뒤에 붙이기".
import { showDialog } from './dialogs.js';
import { icon } from './icons.js';
import { pickFiles, isMobileLayout } from '../native.js';
import { engrave } from '../engrave/render.js';
import { totalStaffCount, effectiveTimeSig, effectiveKeySig, KEY_NAMES, KEY_NAMES_MINOR, durTicks, makeRest } from '../model/score.js';
import { alignedDurations } from '../model/commands.js';
import { escapeXml } from '../engrave/text.js';
import { AudioTranscriber, isAudioFile } from '../audio/engine.js';
import { Player } from '../playback/synth.js';

const ACCEPT = 'audio/*,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm,.aif,.aiff';
const MAX_SECONDS = 15 * 60;
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export { isAudioFile };

function drawWave(canvas, samples) {
  const w = canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1) || 600, h = canvas.height = 64 * (window.devicePixelRatio || 1);
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).color || '#0a84ff';
  const step = Math.max(1, Math.floor(samples.length / w));
  let peak = 1e-6; for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
  for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0; const a = x * step, b = Math.min(samples.length, a + step);
    for (let i = a; i < b; i += 4) { const v = samples[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const y0 = h / 2 - (hi / peak) * h * 0.46, y1 = h / 2 - (lo / peak) * h * 0.46;
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

export async function audioDialog(app, ui, { files = null } = {}) {
  let root = null, eng = null, file = null, decoded = null, audioUrl = null, result = null, player = null, busy = false;
  const body = `
    <div id="au-step1">
      <div class="drop-zone" id="au-drop"><div class="big">${icon('audio')}<br>음원 파일을 여기에 끌어다 놓으세요</div><div>MP3 · M4A · WAV · OGG · FLAC 등 — 노래나 연주를 듣고 악보로 받아 적습니다</div>
        <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-a="pick">${icon('open')} 음원 파일 선택</button></div></div>
      <div class="photo-tips au-tips">
        <div><b>한 악기·한 목소리</b>독주, 노래 한 줄, 피아노 독주가 가장 정확합니다</div>
        <div><b>반주가 큰 곡은 대략</b>밴드·팝 음원은 두드러진 멜로디만 대략 받아 적습니다</div>
        <div><b>또렷한 녹음</b>잡음·울림이 적을수록 좋아요</div>
        <div><b>기기 안에서 처리</b>음원은 어디에도 올라가지 않습니다</div>
      </div>
    </div>
    <div id="au-step2" hidden>
      <div class="au-file"><b data-name></b><span data-info></span></div>
      <canvas class="au-wave" height="64"></canvas>
      <div class="grid-2" style="margin-top:8px">
        <div class="row"><label>음원 종류</label><div class="ctl"><select id="au-mode"><option value="auto">자동 판단</option><option value="melody">멜로디 (노래·단선율)</option><option value="piano">피아노·다성 (큰보표)</option></select></div></div>
        <div class="row"><label>박자</label><div class="ctl"><select id="au-ts"><option value="auto">자동 (4/4·3/4·6/8)</option><option>4/4</option><option>3/4</option><option>2/4</option><option>6/8</option></select></div></div>
        <div class="row"><label>빠르기 (BPM)</label><div class="ctl"><input type="number" id="au-bpm" min="30" max="260" step="1" placeholder="자동"></div></div>
        <div class="row"><label>제목</label><div class="ctl"><input type="text" id="au-title" placeholder="(파일 이름)"></div></div>
      </div>
      <div class="au-checks"><label class="checkbox"><input type="checkbox" id="au-trip"> 셋잇단음표 허용</label><label class="checkbox"><input type="checkbox" id="au-chords" checked> 코드 기호 붙이기</label></div>
      <p class="au-help">반주가 있는 곡(밴드·팝 믹스)은 가장 두드러진 선율만 대략적으로 받아 적습니다. 드럼 같은 음높이 없는 소리는 무시합니다. 결과는 편집기에서 고칠 수 있어요.</p>
    </div>
    <div id="au-step3" hidden>
      <p id="au-msg">준비 중…</p><div class="progress"><div id="au-bar"></div></div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-a="cancel">${icon('close')} 취소</button></div>
    </div>
    <div id="au-step4" hidden>
      <div class="omr-summary" data-chips></div>
      <ul class="omr-warn" data-warn hidden></ul>
      <div class="au-players">
        <audio controls preload="metadata" data-orig></audio>
        <button class="btn" data-a="playScore">${icon('play')} 악보 재생</button>
      </div>
      <div class="au-requant">
        <label>빠르기 <input type="number" id="au-r-bpm" min="30" max="260" step="1"></label>
        <button class="btn sm" data-a="half" title="빠르기 절반">÷2</button><button class="btn sm" data-a="double" title="빠르기 두 배">×2</button>
        <label>박자 <select id="au-r-ts"><option value="auto">자동</option><option>4/4</option><option>3/4</option><option>2/4</option><option>6/8</option></select></label>
        <label>가장 짧은 음표 <select id="au-r-grid"><option value="16">16분음표</option><option value="8">8분음표</option></select></label>
        <label>종류 <select id="au-r-mode"><option value="melody">멜로디</option><option value="piano">피아노·다성</option></select></label>
        <label class="checkbox"><input type="checkbox" id="au-r-trip"> 셋잇단</label>
        <label class="checkbox"><input type="checkbox" id="au-r-chords"> 코드</label>
        <button class="btn primary sm" data-a="requant">${icon('refresh')} 다시 정리</button>
      </div>
      <div class="au-preview" data-preview></div>
      <p class="au-help">재생기로 원음을, "악보 재생"으로 받아 적은 결과를 들어 보며 비교하세요. <b>음표가 지나치게 짧거나(16분음표투성이) 길게 적혔다면 ÷2 / ×2</b>를 눌러 보세요 — 빠르기를 두 배·절반으로 잘못 듣는 것이 가장 흔한 실수입니다. 빠르기·박자·음표 단위를 바꾸면 소리 분석을 다시 하지 않고 악보만 곧바로 새로 정리합니다.</p>
    </div>`;
  const $ = s => root.querySelector(s);
  const show = step => { ['#au-step1', '#au-step2', '#au-step3', '#au-step4'].forEach((s, i) => { $(s).hidden = i + 1 !== step; }); };
  const btn = k => root.querySelector(`[data-b=${k}]`);
  const buttons = (vis) => ['more', 'append', 'run', 'apply'].forEach(k => { btn(k).hidden = !vis.includes(k); });
  const stopPlayers = () => { try { player?.stop(); } catch { /* ignore */ } const a = $('[data-orig]'); if (a && !a.paused) a.pause(); };

  const setFile = async f => {
    if (!f) return;
    if (!isAudioFile(f.name, f.blob.type)) { ui.toast(`${f.name}: 음원 파일이 아닌 것 같습니다 (MP3·M4A·WAV·OGG·FLAC)`, 'warn', { timeout: 5000 }); }
    file = f; result = null; stopPlayers();
    show(3); buttons([]); $('#au-msg').textContent = '음원을 읽는 중…'; $('#au-bar').style.width = '3%';
    try {
      eng?.dispose(); eng = new AudioTranscriber();
      decoded = await eng.decode(f.blob);
      if (decoded.duration < 0.5) throw new Error('소리가 너무 짧습니다');
      if (decoded.duration > MAX_SECONDS) throw new Error(`음원이 너무 깁니다 (${fmtTime(decoded.duration)}). ${MAX_SECONDS / 60}분 이하로 잘라서 사용하세요.`);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(f.blob);
      $('[data-name]').textContent = f.name;
      $('[data-info]').textContent = ` · ${fmtTime(decoded.duration)} · ${decoded.original.channels > 1 ? '스테레오' : '모노'} ${Math.round(decoded.original.sampleRate / 100) / 10} kHz`;
      $('#au-title').placeholder = f.name.replace(/\.[^.]+$/, '');
      show(2); buttons(['more', 'run']);
      requestAnimationFrame(() => drawWave($('.au-wave'), decoded.samples));
    } catch (e) {
      console.error(e); ui.toast(e.message, 'error', { timeout: 6000 }); show(1); buttons([]);
    }
  };
  const pick = async () => { const fs = await pickFiles({ accept: ACCEPT, multiple: false }); if (fs.length) setFile(fs[0]); };
  const currentOpts = (fromReview = false) => {
    if (fromReview) return {
      mode: $('#au-r-mode').value, timeSig: $('#au-r-ts').value, bpm: +$('#au-r-bpm').value || null, grid: +$('#au-r-grid').value,
      triplets: $('#au-r-trip').checked, chords: $('#au-r-chords').checked, title: result?.score.meta.title,
    };
    return {
      mode: $('#au-mode').value, timeSig: $('#au-ts').value, bpm: +$('#au-bpm').value || null, grid: 16,
      triplets: $('#au-trip').checked, chords: $('#au-chords').checked, title: $('#au-title').value.trim() || file.name.replace(/\.[^.]+$/, ''),
    };
  };
  const run = async () => {
    if (busy || !eng) return;
    busy = true; stopPlayers();
    const opts = currentOpts(false);
    show(3); buttons([]);
    const bar = $('#au-bar'), msg = $('#au-msg');
    const t0 = performance.now();
    try {
      if (!eng.post) {
        msg.textContent = '모델을 불러오는 중…'; bar.style.width = '5%';
        eng.cancelled = false;
        await eng.analyze(p => { bar.style.width = (5 + 0.9 * p.percent).toFixed(1) + '%'; msg.textContent = p.message; });
      }
      msg.textContent = '악보로 정리하는 중…'; bar.style.width = '97%';
      result = await eng.transcribe(opts);
      result.totalMs = Math.round(performance.now() - t0);
      showReview(opts);
    } catch (e) {
      if (eng?.cancelled) { show(2); buttons(['more', 'run']); eng = new AudioTranscriber(); eng.samples = decoded.samples; ui.toast('분석을 취소했습니다', 'info'); }
      else { console.error(e); msg.textContent = '분석 중 오류: ' + e.message; buttons(['more', 'run']); }
    } finally { busy = false; }
  };
  const requant = async () => {
    if (busy || !eng?.post) return;
    busy = true; stopPlayers();
    const opts = currentOpts(true);
    $('[data-a=requant]').disabled = true;
    try { result = await eng.transcribe(opts); showReview(opts); }
    catch (e) { console.error(e); ui.toast('다시 정리하지 못했습니다: ' + e.message, 'error'); }
    finally { busy = false; $('[data-a=requant]').disabled = false; }
  };
  const showReview = opts => {
    show(4);
    const s = result.score, ts = effectiveTimeSig(s, 0), ks = effectiveKeySig(s, 0);
    const keyName = ks.mode === 'minor' ? KEY_NAMES_MINOR[ks.fifths] : KEY_NAMES[ks.fifths] + ' 장조';
    const nNotes = result.stats.notes, eStats = eng.stats;
    $('[data-chips]').innerHTML = [
      `<span class="chip">${result.mode === 'melody' ? '멜로디' : '피아노·다성'}</span>`,
      `<span class="chip">♩ = ${Math.round(result.bpm)}</span>`, `<span class="chip">${ts.num}/${ts.den}</span>`, `<span class="chip">${escapeXml(keyName)}</span>`,
      `<span class="chip">${s.measures.length}마디 · 음표 ${nNotes}개</span>`,
      eStats ? `<span class="chip" title="${eStats.windows}구간 · 작업자 ${eStats.workers}개 · ${eStats.backend}">분석 ${(eStats.ms / 1000).toFixed(1)}초</span>` : '',
      result.pickupBeats ? `<span class="chip">못갖춘마디 ${result.pickupBeats}박</span>` : '',
    ].join('');
    const warn = $('[data-warn]'); warn.hidden = !result.warnings.length; warn.innerHTML = result.warnings.map(w => `<li>${escapeXml(w)}</li>`).join('');
    $('[data-orig]').src = audioUrl;
    $('#au-r-bpm').value = Math.round(result.bpm); $('#au-r-ts').value = opts.timeSig || 'auto'; $('#au-r-grid').value = String(opts.grid || 16);
    $('#au-r-mode').value = result.mode; $('#au-r-trip').checked = !!opts.triplets; $('#au-r-chords').checked = !!opts.chords;
    const layout = engrave(s);
    $('[data-preview]').innerHTML = layout.pages.slice(0, 3).map(p => `<div class="au-page">${p.svg}</div>`).join('') + (layout.pages.length > 3 ? `<p class="au-more">… 모두 ${layout.pages.length}쪽 (편집기에서 전체를 볼 수 있습니다)</p>` : '');
    const canAppend = app.score?.measures.some(m => m.staves.some(sm => sm.voices.some(v => v.some(e => e.kind === 'note')))) && totalStaffCount(app.score) === totalStaffCount(s);
    buttons(['more', 'apply', ...(canAppend ? ['append'] : [])]);
    root._score = s;
  };
  const togglePlayScore = () => {
    if (!result) return;
    if (player?.playing) { player.stop(); return; }
    const a = $('[data-orig]'); if (!a.paused) a.pause();
    player = new Player({ score: result.score });
    const b = $('[data-a=playScore]');
    player.addEventListener('state', () => { b.innerHTML = `${icon(player.playing ? 'stop' : 'play')} ${player.playing ? '정지' : '악보 재생'}`; });
    player.play(0);
  };

  const res = await showDialog({
    title: '음원으로 악보 만들기', wide: true, body,
    buttons: [
      { label: '닫기', value: null },
      { label: '다른 파일', value: () => { pick(); return undefined; } },
      { label: '현재 악보 뒤에 붙이기', value: () => ({ mode: 'append' }) },
      { label: '악보 만들기', primary: true, value: () => { run(); return undefined; } },
      { label: '편집기로 가져오기', primary: true, value: () => ({ mode: 'new' }) },
    ],
    onOpen: (r) => {
      root = r;
      root.querySelector('.dialog')?.classList.add('audio-dialog');
      const fb = root.querySelectorAll('footer button');
      ['close', 'more', 'append', 'run', 'apply'].forEach((k, i) => { fb[i].dataset.b = k; });
      buttons([]);
      $('[data-a=pick]').addEventListener('click', pick);
      $('[data-a=cancel]').addEventListener('click', () => eng?.cancel());
      $('[data-a=playScore]').addEventListener('click', togglePlayScore);
      $('[data-a=requant]').addEventListener('click', requant);
      $('[data-a=half]').addEventListener('click', () => { const i = $('#au-r-bpm'); i.value = Math.max(30, Math.round(+i.value / 2)); requant(); });
      $('[data-a=double]').addEventListener('click', () => { const i = $('#au-r-bpm'); i.value = Math.min(260, Math.round(+i.value * 2)); requant(); });
      $('[data-orig]').addEventListener('play', () => { if (player?.playing) player.stop(); });
      const dz = $('#au-drop');
      dz.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('over'); const f = [...e.dataTransfer.files][0]; if (f) setFile({ name: f.name, blob: f }); });
      if (isMobileLayout()) root.querySelector('.au-tips').style.display = 'none';
      if (files?.length) setFile(files[0]);
    },
  });
  stopPlayers();
  eng?.dispose();
  if (audioUrl) setTimeout(() => URL.revokeObjectURL(audioUrl), 1000);
  if (!res) return;
  const score = root._score; if (!score) return;
  if (res.mode === 'append') {
    app.exec('음원 악보 붙이기', s => {
      const first = score.measures[0]; const pts = effectiveTimeSig(s, s.measures.length - 1), pks = effectiveKeySig(s, s.measures.length - 1);
      if (first.timeSig && first.timeSig.num === pts.num && first.timeSig.den === pts.den) delete first.timeSig;
      if (first.keySig && first.keySig.fifths === pks.fifths) delete first.keySig;
      if (first.pickup) {   // mid-score a pickup becomes a full bar: rests before the pickup notes
        const cap = effectiveTimeSig(score, 0).num * 3840 / effectiveTimeSig(score, 0).den;
        first.staves.forEach(sm => { const have = sm.voices[0].reduce((t, e) => t + durTicks(e), 0); if (have < cap) sm.voices[0].unshift(...alignedDurations(0, cap - have).map(d => makeRest(d.base, d.dots))); });
        delete first.pickup;
      }
      s.measures.push(...score.measures); s.spanners.push(...score.spanners);
    });
    ui.toast(`음원 악보 ${score.measures.length}마디를 뒤에 붙였습니다`, 'ok');
  } else {
    if (!(await ui.confirmDiscard())) return;
    app.setScore(score, { fileName: null, dirty: true });
    ui.view.fit('width');
    ui.toast('음원에서 악보를 만들었습니다 — 재생해 보며 고쳐 보세요', 'ok', { timeout: 4500 });
  }
}
