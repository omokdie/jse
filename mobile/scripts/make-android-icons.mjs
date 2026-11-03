#!/usr/bin/env node
/**
 * Generates the Android launcher icons from ../../app/icons/icon-512.png
 * (placeholder artwork when the file does not exist yet):
 *
 *   res/mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png             48 … 192 px  (legacy, API < 26)
 *   res/mipmap-{…}dpi/ic_launcher_round.png                      circular variant
 *   res/mipmap-{…}dpi/ic_launcher_foreground.png                 108dp adaptive foreground (icon in the 72dp safe zone)
 *   (res/mipmap-anydpi-v26/ic_launcher.xml + values/ic_launcher_background.xml are static files)
 *
 * Only dependency: sharp (CI: `npm i --no-save sharp`; locally also /opt/npm-tools/node_modules/sharp or $SHARP_PATH).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');
const repoRoot = path.resolve(mobileDir, '..');

const SOURCE_PNG = process.env.ICON_SOURCE || path.join(repoRoot, 'app', 'icons', 'icon-512.png');
const RES_DIR = process.env.ANDROID_RES || path.join(mobileDir, 'android', 'app', 'src', 'main', 'res');

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const LEGACY_DP = 48;
const ADAPTIVE_DP = 108;
const SAFE_DP = 72;

function loadSharp() {
  for (const c of [process.env.SHARP_PATH, 'sharp', '/opt/npm-tools/node_modules/sharp'].filter(Boolean)) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  console.error('[make-android-icons] sharp not found. Run: npm i --no-save sharp');
  process.exit(1);
}

function placeholderSvg() {
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

function circleMask(size) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
}

async function main() {
  const sharp = loadSharp();
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

  let source;
  if (fs.existsSync(SOURCE_PNG)) {
    source = await sharp(SOURCE_PNG).resize(512, 512, { fit: 'contain', background: transparent }).png().toBuffer();
    console.log(`[make-android-icons] source: ${SOURCE_PNG}`);
  } else {
    source = await sharp(Buffer.from(placeholderSvg())).png().toBuffer();
    console.log(`[make-android-icons] ${SOURCE_PNG} not found — using placeholder artwork`);
  }
  // Flattened square version for legacy icons (no transparency surprises on old launchers).
  const flat = await sharp(source).flatten({ background: '#1f3a5f' }).png().toBuffer();

  for (const [density, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(RES_DIR, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });

    const legacy = Math.round(LEGACY_DP * scale);
    await sharp(flat).resize(legacy, legacy).png().toFile(path.join(dir, 'ic_launcher.png'));

    const round = await sharp(flat).resize(legacy, legacy).png().toBuffer();
    await sharp(round)
      .composite([{ input: circleMask(legacy), blend: 'dest-in' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_round.png'));

    const canvas = Math.round(ADAPTIVE_DP * scale);
    const inner = Math.round(SAFE_DP * scale);
    const mark = await sharp(source).resize(inner, inner, { fit: 'contain', background: transparent }).png().toBuffer();
    await sharp({ create: { width: canvas, height: canvas, channels: 4, background: transparent } })
      .composite([{ input: mark, left: Math.round((canvas - inner) / 2), top: Math.round((canvas - inner) / 2) }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_foreground.png'));
  }
  console.log(`[make-android-icons] wrote mipmaps into ${RES_DIR}`);
}

main().catch((err) => {
  console.error('[make-android-icons] failed:', err);
  process.exit(1);
});
