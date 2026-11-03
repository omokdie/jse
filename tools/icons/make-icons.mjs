// Renders tools/icons/app-icon.svg to the PNG sizes used by the PWA, Electron and Android.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const sharp = require('sharp');
const root = new URL('../../', import.meta.url).pathname;
const svg = fs.readFileSync(root + 'tools/icons/app-icon.svg');
const out = async (size, file, { pad = 0, bg = null } = {}) => {
  let img = sharp(svg, { density: 384 }).resize(size - pad * 2, size - pad * 2);
  if (pad) img = sharp({ create: { width: size, height: size, channels: 4, background: bg || { r: 10, g: 132, b: 255, alpha: 1 } } }).composite([{ input: await img.png().toBuffer(), left: pad, top: pad }]);
  await img.png().toFile(file); console.log('wrote', file);
};
await out(192, root + 'app/icons/icon-192.png');
await out(512, root + 'app/icons/icon-512.png');
await out(512, root + 'app/icons/maskable-512.png', { pad: 52 });
await out(1024, root + 'electron/build/icon.png');
const androidSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(androidSizes)) {
  const dir = root + `mobile/android/app/src/main/res/mipmap-${d}/`;
  if (!fs.existsSync(dir)) continue;
  await out(s, dir + 'ic_launcher.png'); await out(s, dir + 'ic_launcher_round.png');
  await out(Math.round(s * 2.25), dir + 'ic_launcher_foreground.png', { pad: Math.round(s * 0.45) });
}
