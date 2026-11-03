// usage: node tools/e2e/shot.mjs <url> <out.png> [desktop|mobile] [script.js]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium, devices } = require('playwright');
const [,, url, out, kind = 'desktop', script] = process.argv;
const browser = await chromium.launch();
const ctx = kind === 'mobile' ? await browser.newContext({ ...devices['Pixel 7'] })
  : kind === 'tablet' ? await browser.newContext({ ...devices['iPad Pro 11 landscape'], deviceScaleFactor: 1 })
  : kind === 'tablet-portrait' ? await browser.newContext({ ...devices['iPad Pro 11'], deviceScaleFactor: 1 })
  : kind === 'android-tablet' ? await browser.newContext({ ...devices['Galaxy Tab S4'], deviceScaleFactor: 1 })
  : await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
if (process.env.INIT) await page.addInitScript({ path: process.env.INIT });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
if (script) { const fn = fs.readFileSync(script, 'utf8'); await new Function('page', `return (async () => { ${fn} })()`)(page); }
await page.screenshot({ path: out });
console.log(logs.join('\n') || 'no console errors');
await browser.close();
