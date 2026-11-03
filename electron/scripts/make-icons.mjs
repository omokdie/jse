#!/usr/bin/env node
/**
 * Generates the Windows icons electron-builder needs:
 *   build/icon.ico   — application / installer icon (16,24,32,48 BMP + 64,128,256 PNG entries)
 *   build/ssnap.ico  — .ssnap document icon (same sizes; page with the app mark)
 *   build/icon.png   — 256px PNG (window icon in development)
 *
 * Source: ../../app/icons/icon-512.png.  When it does not exist yet, a neutral
 * placeholder (navy square + note) is rendered so builds never fail.
 *
 * Only dependency: sharp (CI: `npm i --no-save sharp`; locally also found at
 * /opt/npm-tools/node_modules/sharp or $SHARP_PATH).  The .ico container is
 * written by hand below — Windows (Vista+) accepts PNG-compressed entries, and
 * the small sizes are classic 32-bit BMP entries for maximum compatibility.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '..');
const repoRoot = path.resolve(electronDir, '..');

const SOURCE_PNG = process.env.ICON_SOURCE || path.join(repoRoot, 'app', 'icons', 'icon-512.png');
const OUT_DIR = process.env.ICON_OUT || path.join(electronDir, 'build');

const BMP_SIZES = [16, 24, 32, 48];
const PNG_SIZES = [64, 128, 256];

function loadSharp() {
  const candidates = [process.env.SHARP_PATH, 'sharp', '/opt/npm-tools/node_modules/sharp'].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  console.error('[make-icons] sharp not found. Run: npm i --no-save sharp');
  process.exit(1);
}

/* ------------------------------------------------------------------ placeholder art */

export function placeholderAppSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="96" fill="#1f3a5f"/>
  <g stroke="#9fb3c8" stroke-width="10" opacity="0.55">
    <line x1="88" y1="300" x2="424" y2="300"/>
    <line x1="88" y1="336" x2="424" y2="336"/>
    <line x1="88" y1="372" x2="424" y2="372"/>
  </g>
  <g fill="#ffffff">
    <ellipse cx="206" cy="356" rx="58" ry="40" transform="rotate(-22 206 356)"/>
    <rect x="250" y="118" width="22" height="238" rx="6"/>
    <path d="M272 118 c70 40 92 92 60 164 c20 -64 -4 -100 -60 -124 z"/>
  </g>
</svg>`;
}

/** Document icon: a page with a folded corner and the app mark in the middle. */
export function documentSvg(markPngBase64) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <path d="M112 24 h208 l120 120 v344 a24 24 0 0 1 -24 24 h-304 a24 24 0 0 1 -24 -24 v-440 a24 24 0 0 1 24 -24 z" fill="#ffffff" stroke="#b8c0cc" stroke-width="10"/>
  <path d="M320 24 v96 a24 24 0 0 0 24 24 h96 z" fill="#dfe5ee" stroke="#b8c0cc" stroke-width="10" stroke-linejoin="round"/>
  <image x="146" y="196" width="220" height="220" href="data:image/png;base64,${markPngBase64}"/>
</svg>`;
}

/* ------------------------------------------------------------------ ICO encoder */

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}
function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}
function i32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
}

/** RGBA (top-down) → 32bpp BMP icon image (BITMAPINFOHEADER + BGRA bottom-up + AND mask). */
export function rgbaToBmpIconImage(rgba, width, height) {
  const xorStride = width * 4;
  const andStride = ((width + 31) >> 5) << 2;
  const xor = Buffer.alloc(xorStride * height);
  const and = Buffer.alloc(andStride * height); // 0 = opaque; set 1 where fully transparent
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 4;
    const dstRow = (height - 1 - y) * xorStride;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      const a = rgba[s + 3];
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = a; // A
      if (a === 0) and[(height - 1 - y) * andStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const header = Buffer.concat([
    u32(40), // biSize
    i32(width), // biWidth
    i32(height * 2), // biHeight (XOR + AND)
    u16(1), // biPlanes
    u16(32), // biBitCount
    u32(0), // biCompression = BI_RGB
    u32(xor.length + and.length), // biSizeImage
    i32(0), // biXPelsPerMeter
    i32(0), // biYPelsPerMeter
    u32(0), // biClrUsed
    u32(0), // biClrImportant
  ]);
  return Buffer.concat([header, xor, and]);
}

/**
 * @param {{width:number,height:number,data:Buffer}[]} images  image data = BMP icon image or PNG file
 */
export function encodeIco(images) {
  const count = images.length;
  const headerSize = 6 + 16 * count;
  const dir = [u16(0), u16(1), u16(count)];
  const blobs = [];
  let offset = headerSize;
  for (const img of images) {
    dir.push(
      Buffer.from([img.width >= 256 ? 0 : img.width, img.height >= 256 ? 0 : img.height, 0, 0]),
      u16(1),
      u16(32),
      u32(img.data.length),
      u32(offset),
    );
    blobs.push(img.data);
    offset += img.data.length;
  }
  return Buffer.concat([...dir, ...blobs]);
}

/** Minimal parser used for self-checks. */
export function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o] || 256;
    const h = buf[o + 1] || 256;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const png = buf.slice(off, off + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (off + size > buf.length) throw new Error('entry out of range');
    entries.push({ w, h, size, png });
  }
  return entries;
}

/* ------------------------------------------------------------------ main */

export async function buildIcoFromPng(sharp, sourceBuffer) {
  const images = [];
  for (const size of BMP_SIZES) {
    const { data, info } = await sharp(sourceBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    images.push({ width: info.width, height: info.height, data: rgbaToBmpIconImage(data, info.width, info.height) });
  }
  for (const size of PNG_SIZES) {
    const data = await sharp(sourceBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    images.push({ width: size, height: size, data });
  }
  return encodeIco(images);
}

async function main() {
  const sharp = loadSharp();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let appPng;
  if (fs.existsSync(SOURCE_PNG)) {
    appPng = await sharp(SOURCE_PNG).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    console.log(`[make-icons] source: ${SOURCE_PNG}`);
  } else {
    appPng = await sharp(Buffer.from(placeholderAppSvg())).png().toBuffer();
    console.log(`[make-icons] ${SOURCE_PNG} not found — using placeholder artwork`);
  }

  const docPng = await sharp(Buffer.from(documentSvg(appPng.toString('base64')))).png().toBuffer();

  const appIco = await buildIcoFromPng(sharp, appPng);
  const docIco = await buildIcoFromPng(sharp, docPng);

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), appIco);
  fs.writeFileSync(path.join(OUT_DIR, 'ssnap.ico'), docIco);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), await sharp(appPng).resize(256, 256).png().toBuffer());

  for (const name of ['icon.ico', 'ssnap.ico']) {
    const entries = parseIco(fs.readFileSync(path.join(OUT_DIR, name)));
    console.log(`[make-icons] ${name}: ${entries.map((e) => `${e.w}${e.png ? 'p' : 'b'}`).join(' ')}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[make-icons] failed:', err);
    process.exit(1);
  });
}
