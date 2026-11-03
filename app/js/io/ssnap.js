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

/** Detect what kind of file this is from name + first bytes. */
export function sniffFile(name, bytes) {
  const lower = (name || '').toLowerCase();
  const head = bytes ? new Uint8Array(bytes.slice(0, 4096)) : null;
  const isZip = head && head[0] === 0x50 && head[1] === 0x4b;
  if (lower.endsWith('.ssnap')) return 'ssnap';
  if (/\.(musx|ftmx)$/.test(lower)) return 'musx';
  if (/\.(mus|ftm)$/.test(lower)) return 'finale-old';
  if (lower.endsWith('.mxl')) return 'mxl';
  if (lower.endsWith('.musicxml') || lower.endsWith('.xml')) return 'musicxml';
  if (lower.endsWith('.mid') || lower.endsWith('.midi')) return 'midi';
  if (/\.(png|jpe?g|webp|bmp|gif|heic|tiff?)$/.test(lower)) return 'image';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.json')) return 'json';
  if (isZip) {
    const text = new TextDecoder('latin1').decode(head);
    if (text.includes('application/x-scoresnap') || text.includes('score.json')) return 'ssnap';
    if (text.includes('score.dat') || text.includes('NotationMetadata') || text.includes('makemusic')) return 'musx';
    if (text.includes('META-INF') || text.includes('.xml')) return 'mxl';
    return 'ssnap';
  }
  if (head) {
    const text = new TextDecoder().decode(head);
    if (/<score-partwise|<score-timewise/.test(text)) return 'musicxml';
    if (text.trim().startsWith('{') && text.includes('"scoresnap"')) return 'json';
    if (head[0] === 0x89 && head[1] === 0x50) return 'image';
    if (head[0] === 0xff && head[1] === 0xd8) return 'image';
    if (text.startsWith('%PDF')) return 'pdf';
  }
  return 'unknown';
}
