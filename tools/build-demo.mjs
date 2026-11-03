// Builds dist/demo: the web app for the claude.ai preview page (no service worker, third-party
// libraries from cdnjs instead of re-hosting them, downloads reported as unavailable).
import fs from 'node:fs';
import path from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const out = path.join(root, 'dist/demo');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'app'), out, { recursive: true, filter: p => !p.includes(`${path.sep}vendor`) && !p.endsWith('sw.js') && !p.endsWith('LICENSE-FreeFont.txt') });
const CDN = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  pdfLib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs',
  pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs',
};
let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
html = html.replace('<script src="vendor/jszip.min.js" defer></script>', `<script src="${CDN.jszip}" defer></script>\n<script>window.JSE_PREVIEW = true; window.JSE_VENDOR = ${JSON.stringify({ pdfLib: CDN.pdfLib, pdfjs: CDN.pdfjs, pdfjsWorker: CDN.pdfjsWorker })};</script>`);
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', '');
fs.writeFileSync(path.join(out, 'index.html'), html);
const files = [];
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(path.relative(out, f)); } };
walk(out);
fs.writeFileSync(path.join(root, 'dist/demo-files.json'), JSON.stringify(files.map(f => ({ as: f.split(path.sep).join('/'), path: path.join(out, f) })), null, 1));
console.log(files.length, 'files →', out);
