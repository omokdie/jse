// Writes Windows .ico files (PNG-compressed entries, Vista+) without extra dependencies.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const sharp = require('sharp');
const root = new URL('../../', import.meta.url).pathname;
async function ico(svgFile, outFile, sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const svg = fs.readFileSync(svgFile);
  const pngs = await Promise.all(sizes.map(s => sharp(svg, { density: Math.max(72, s * 1.5) }).resize(s, s).png().toBuffer()));
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length); let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e); dir.writeUInt8(s >= 256 ? 0 : s, e + 1); dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6); dir.writeUInt32LE(pngs[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(outFile, Buffer.concat([header, dir, ...pngs]));
  console.log('wrote', outFile, fs.statSync(outFile).size, 'bytes');
}
await ico(root + 'tools/icons/app-icon.svg', root + 'electron/build/icon.ico');
await ico(root + 'tools/icons/doc-icon.svg', root + 'electron/build/ssnap.ico');
await sharp(fs.readFileSync(root + 'tools/icons/doc-icon.svg'), { density: 200 }).resize(256, 256).png().toFile(root + 'tools/out/doc-icon.png');
