// .ssnap container: ZIP with mimetype, manifest.json, score.json, sources/*, thumbnail.png
import { validateScore } from '../model/score.js';

export const SSNAP_MIME = 'application/x-scoresnap';
export const SSNAP_EXT = '.ssnap';

function getJSZip(inj) { const Z = inj || globalThis.JSZip; if (!Z) throw new Error('JSZip이 로드되지 않았습니다'); return Z; }

export async function writeSsnap(score, { thumbnailBlob = null, appVersion = '1.0.0', JSZip = null } = {}) {
  const Z = getJSZip(JSZip);
  const zip = new Z();
  zip.file('mimetype', SSNAP_MIME, { compression: 'STORE' });
  zip.file('manifest.json', JSON.stringify({ format: 'scoresnap', version: 1, app: 'JSE', appVersion, modified: new Date().toISOString() }, null, 2));
  const sources = [];
  for (const src of (score.sources || [])) {
    const ext = (src.mime || 'image/png').split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const file = `sources/${src.id}.${ext}`;
    const { blob, ...rest } = src;
    sources.push({ ...rest, file });
    if (blob) zip.file(file, blob);
  }
  const doc = { ...score, sources };
  zip.file('score.json', JSON.stringify(doc));
  if (thumbnailBlob) zip.file('thumbnail.png', thumbnailBlob);
  return zip.generateAsync({ type: 'blob', mimeType: SSNAP_MIME, compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function readSsnap(data, { JSZip = null } = {}) {
  const Z = getJSZip(JSZip);
  const zip = await Z.loadAsync(data);
  const entry = zip.file('score.json');
  if (!entry) throw new Error('score.json이 없는 파일입니다 (.ssnap 형식이 아닙니다)');
  const score = JSON.parse(await entry.async('string'));
  const v = validateScore(score, { repair: true });
  if (!v.ok) console.warn('ssnap repair:', v.errors);
  for (const src of (score.sources || [])) {
    if (src.file && zip.file(src.file)) {
      try { src.blob = await zip.file(src.file).async('blob'); if (src.mime) src.blob = src.blob.slice(0, src.blob.size, src.mime); } catch { /* ignore */ }
    }
  }
  let thumbnail = null;
  if (zip.file('thumbnail.png')) thumbnail = await zip.file('thumbnail.png').async('blob');
  return { score, thumbnail };
}

/**
 * Score files of other programs that cannot be read directly (closed or undocumented formats).
 * sniffFile() returns the key; the UI explains the MusicXML route (ui/importflow.js).
 */
export const FOREIGN_SCORE_FORMATS = {
  sibelius: { name: 'Sibelius', ext: ['.sib'], how: 'Sibelius에서 <b>파일 → 내보내기 → MusicXML</b>로 저장하세요. (Sibelius 6 이하는 MusicXML 내보내기 플러그인 Dolet이 필요합니다.)', why: 'Sibelius 파일(.sib)은 형식이 공개되지 않은 암호화된 파일이라 Sibelius 말고는 어떤 프로그램도 직접 열 수 없습니다.' },
  'finale-old': { name: 'Finale 2012 이전', ext: ['.mus', '.ftm'], how: 'Finale에서 <b>파일 → 내보내기 → MusicXML</b>로 저장하세요. Finale 2014 이상에서 열어 .musx로 다시 저장해도 됩니다(.musx는 JSE가 바로 엽니다).' },
  encore: { name: 'Encore', ext: ['.enc'], how: 'Encore에서 MusicXML로 내보내세요(보통 <b>파일 → 내보내기 → MusicXML</b>).' },
  dorico: { name: 'Dorico', ext: ['.dorico'], how: 'Dorico에서 <b>파일 → 내보내기 → MusicXML</b>로 저장하세요.' },
  capella: { name: 'capella', ext: ['.cap', '.capx'], how: 'capella에서 MusicXML로 내보내세요(보통 <b>파일 → 내보내기 → MusicXML</b>).' },
  guitarpro: { name: 'Guitar Pro', ext: ['.gp', '.gpx', '.gp5', '.gp4', '.gp3'], how: 'Guitar Pro에서 <b>파일 → 내보내기 → MusicXML</b>로 저장하세요.' },
  overture: { name: 'Overture', ext: ['.ove'], how: 'Overture에서 MusicXML로 내보내세요(보통 <b>파일 → 내보내기 → MusicXML</b>).' },
};

/** Detect what kind of file this is from name + first bytes. */
export function sniffFile(name, bytes) {
  const lower = (name || '').toLowerCase();
  const head = bytes ? new Uint8Array(bytes.slice(0, 4096)) : null;
  const isZip = head && head[0] === 0x50 && head[1] === 0x4b;
  const latin = head ? new TextDecoder('latin1').decode(head) : '';
  if (lower.endsWith('.ssnap')) return 'ssnap';
  if (/\.(musx|ftmx)$/.test(lower)) return 'musx';
  if (/\.(mscz|mscx)$/.test(lower)) return 'musescore';
  if (/\.(nwc|nwctxt)$/.test(lower)) return 'nwc';
  for (const [kind, f] of Object.entries(FOREIGN_SCORE_FORMATS)) if (f.ext.some(e => lower.endsWith(e))) return kind;
  if (lower.endsWith('.mxl')) return 'mxl';
  if (lower.endsWith('.musicxml') || lower.endsWith('.xml')) return latin.includes('<museScore') ? 'musescore' : 'musicxml';
  if (lower.endsWith('.mid') || lower.endsWith('.midi') || lower.endsWith('.kar')) return 'midi';
  if (/\.(png|jpe?g|webp|bmp|gif|heic|tiff?)$/.test(lower)) return 'image';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.json')) return 'json';
  if (isZip) {
    if (latin.includes('application/x-scoresnap') || latin.includes('score.json')) return 'ssnap';
    if (latin.includes('score.dat') || latin.includes('NotationMetadata') || latin.includes('makemusic')) return 'musx';
    if (latin.includes('.mscx') || latin.includes('.mss') || latin.includes('audiosettings.json')) return 'musescore';
    if (latin.includes('META-INF') || latin.includes('.xml')) return 'mxl';
    return 'ssnap';
  }
  if (head) {
    const text = new TextDecoder().decode(head);
    if (/<score-partwise|<score-timewise/.test(text)) return 'musicxml';
    if (text.includes('<museScore')) return 'musescore';
    if (latin.startsWith('[NWZ]') || latin.startsWith('[NoteWorthy ArtWare]') || /^﻿?\s*!NoteWorthyComposer/.test(text)) return 'nwc';
    if (latin.slice(0, 16).includes('SIBELIUS')) return 'sibelius';
    if (latin.startsWith('MThd')) return 'midi';
    if (text.trim().startsWith('{') && text.includes('"scoresnap"')) return 'json';
    if (head[0] === 0x89 && head[1] === 0x50) return 'image';
    if (head[0] === 0xff && head[1] === 0xd8) return 'image';
    if (text.startsWith('%PDF')) return 'pdf';
  }
  return 'unknown';
}
