// PNG / JPG / PDF / SVG export with six JSE fonts → tools/out/fonts-export.* ; the SVG is also opened in a fresh page (no document fonts).
// run: INIT=<script that sets localStorage ssnap.welcomed> node tools/e2e/shot.mjs http://localhost:8765/ tools/out/x.png desktop tools/fonts/e2e/export.js
const fs = await import('node:fs');
await page.evaluate(async () => {
  const a = window.JSE.app;
  const ts = await import('./js/model/textstyles.js');
  a.exec('글꼴', s => { ts.applyTextStyles(s, { title: { family: 'Nanum Myeongjo' }, subtitle: { family: 'Gowun Batang' }, lyrics: { family: 'Nanum Pen Script', size: 3.0 }, chord: { family: 'Old Standard TT', italic: true }, composer: { family: 'Libertinus Serif', italic: true }, tempo: { family: 'Gowun Dodum' } }); });
});
await page.waitForTimeout(2500);
const out = await page.evaluate(async () => {
  const a = window.JSE.app;
  const ex = await import('./js/io/export.js');
  const b64 = async blob => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); };
  const faces = [...document.fonts].map(f => `${f.family} ${f.weight} ${f.status}`);
  const t0 = performance.now();
  const png = (await ex.exportImages(a.layout, { format: 'png', dpi: 150, pages: [0] }))[0].blob;
  const t1 = performance.now();
  const jpg = (await ex.exportImages(a.layout, { format: 'jpg', dpi: 100, pages: [0] }))[0].blob;
  const pdf = await ex.exportPdf(a.layout, a.score, { dpi: 150 });
  const t2 = performance.now();
  const svg = ex.exportSvg(a.layout, 0);
  const svgText = await svg.text();
  return { faces, png: await b64(png), jpg: await b64(jpg), pdf: await b64(pdf), svg: svgText, ms: [Math.round(t1 - t0), Math.round(t2 - t1)], pageSvgLen: a.layout.pages[0].svg.length };
});
fs.mkdirSync('tools/out', { recursive: true });
fs.writeFileSync('tools/out/fonts-export.png', Buffer.from(out.png, 'base64'));
fs.writeFileSync('tools/out/fonts-export.jpg', Buffer.from(out.jpg, 'base64'));
fs.writeFileSync('tools/out/fonts-export.pdf', Buffer.from(out.pdf, 'base64'));
fs.writeFileSync('tools/out/fonts-export.svg', out.svg);
console.log('faces', out.faces.join(', '));
console.log('png', out.png.length * 3 / 4 | 0, 'jpg', out.jpg.length * 3 / 4 | 0, 'pdf', out.pdf.length * 3 / 4 | 0, 'svg', out.svg.length, 'page svg', out.pageSvgLen, 'ms png/pdf', out.ms);
console.log('svg @font-face:', (out.svg.match(/@font-face\{font-family:'[^']+';font-weight:\d+/g) || []).join(' | '));
// the exported SVG opened on its own (a fresh page = no document fonts): must still show the fonts
const p2 = await page.context().newPage();
await p2.setViewportSize({ width: 1000, height: 1300 });
await p2.goto('about:blank');
await p2.setContent(`<body style="margin:0;background:#fff"><img id="i" style="width:1000px" src="data:image/svg+xml;base64,${Buffer.from(out.svg).toString('base64')}"></body>`);
await p2.waitForFunction(() => document.getElementById('i').complete);
await p2.waitForTimeout(600);
await p2.screenshot({ path: 'tools/out/fonts-export-svg-standalone.png' });
await p2.close();
