// Rasterize SVG files with headless Chromium: node tools/svg2png.mjs file.svg [width]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium } = require('playwright');
const files = process.argv.slice(2).filter(f => f.endsWith('.svg'));
const width = parseInt(process.argv.find(a => /^\d+$/.test(a)) || '1400', 10);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 100 }, deviceScaleFactor: 1 });
for (const f of files) {
  const svg = fs.readFileSync(f, 'utf8');
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const h = Math.round(width * parseFloat(m[2]) / parseFloat(m[1]));
  await page.setViewportSize({ width, height: h });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#888">${svg.replace('<svg ', `<svg width="${width}" height="${h}" `)}</body></html>`);
  await page.screenshot({ path: f.replace(/\.svg$/, '.png'), fullPage: true });
  console.log('wrote', f.replace(/\.svg$/, '.png'), width, 'x', h);
}
await browser.close();
