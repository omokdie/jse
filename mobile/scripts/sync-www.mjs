#!/usr/bin/env node
/**
 * Builds the distributable web tree used by Android (Capacitor `www/`), the
 * OTA bundle zip and GitHub Pages:
 *
 *   1. copies <src> (default ../app) → <out> (default www), fresh
 *   2. adds www-shim/native-android.js as <out>/js/native-android.js
 *   3. injects  <script src="js/native-android.js"></script>  into <out>/index.html
 *      right before the first <script type="module"> (fallback: before </head>)
 *      — a classic script runs before module scripts, so window.ScoreSnapNative
 *      exists when app/js/main.js starts.  In a normal browser (no Capacitor)
 *      the shim is a no-op, so the same tree can be served as the PWA.
 *   4. --pages additionally writes .nojekyll (GitHub Pages)
 *
 * Usage: node scripts/sync-www.mjs [--src ../app] [--out www] [--shim path] [--pages]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');

export const SHIM_TAG = '<script src="js/native-android.js"></script><!-- scoresnap-native-shim -->';

function parseArgs(argv) {
  const opts = { src: path.resolve(mobileDir, '..', 'app'), out: path.resolve(mobileDir, 'www'), shim: path.resolve(mobileDir, 'www-shim', 'native-android.js'), pages: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') opts.src = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--shim') opts.shim = path.resolve(argv[++i]);
    else if (a === '--pages') opts.pages = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: sync-www.mjs [--src dir] [--out dir] [--shim file] [--pages]');
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

/** Insert the shim script tag into an index.html string (idempotent). */
export function injectShim(html) {
  if (html.includes('js/native-android.js')) return html;
  const moduleScript = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/i.exec(html);
  if (moduleScript) {
    // keep the original line's indentation for a tidy diff
    const idx = moduleScript.index;
    const lineStart = html.lastIndexOf('\n', idx - 1) + 1;
    const prefix = html.slice(lineStart, idx);
    if (/^[ \t]*$/.test(prefix)) return html.slice(0, lineStart) + prefix + SHIM_TAG + '\n' + html.slice(lineStart);
    return html.slice(0, idx) + SHIM_TAG + '\n' + html.slice(idx);
  }
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) return html.slice(0, headClose.index) + SHIM_TAG + '\n' + html.slice(headClose.index);
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + '\n' + SHIM_TAG + html.slice(at);
  }
  return SHIM_TAG + '\n' + html;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

export function syncWww(opts) {
  const { src, out, shim, pages } = opts;
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`source folder not found: ${src}`);
  if (!fs.existsSync(shim)) throw new Error(`shim not found: ${shim}`);

  const rel = path.relative(out, src);
  if (out === src || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`refusing to delete ${out}: it contains the source folder`);
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(src, out, {
    recursive: true,
    filter: (p) => !SKIP.has(path.basename(p)),
  });

  fs.mkdirSync(path.join(out, 'js'), { recursive: true });
  fs.copyFileSync(shim, path.join(out, 'js', 'native-android.js'));

  const indexFile = path.join(out, 'index.html');
  let injected = false;
  if (fs.existsSync(indexFile)) {
    const html = fs.readFileSync(indexFile, 'utf8');
    const patched = injectShim(html);
    if (patched !== html) fs.writeFileSync(indexFile, patched);
    injected = patched.includes('js/native-android.js');
  } else {
    console.warn(`[sync-www] WARNING: ${indexFile} does not exist (web app not built yet?)`);
  }

  if (pages) fs.writeFileSync(path.join(out, '.nojekyll'), '');
  finalizeWebTree(out);

  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(out, 'version.json'), 'utf8')).version || null;
  } catch {
    /* no version.json yet */
  }
  return { files: countFiles(out), injected, version };
}

/**
 * Stamps the version into sw.js (its cache name) and writes asset-list.json, the precache list the
 * service worker downloads on install — so a new deploy always gets a fresh cache and old ones are
 * deleted on activate (that is what makes "update when online" work for the PWA).
 */
export function finalizeWebTree(out) {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(out, 'version.json'), 'utf8')).version || version; } catch { /* keep default */ }
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(path.relative(out, full).split(path.sep).join('/'));
    }
  };
  walk(out);
  const skip = new Set(['sw.js', 'asset-list.json', 'version.json', '.nojekyll']);
  const list = files.filter((f) => !skip.has(f) && !/^web-.*\.zip$/.test(f) && !/\.(map|md)$/.test(f) && !f.startsWith('vendor/pdfjs/LICENSE'));
  fs.writeFileSync(path.join(out, 'asset-list.json'), JSON.stringify(list));
  const swFile = path.join(out, 'sw.js');
  if (fs.existsSync(swFile)) {
    const stamp = `${version}-${Date.now().toString(36)}`;
    fs.writeFileSync(swFile, fs.readFileSync(swFile, 'utf8').replace(/__VERSION__/g, stamp));
  }
  return { version, assets: list.length };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = syncWww(opts);
    console.log(`[sync-www] ${opts.src} → ${opts.out}: ${r.files} files, shim ${r.injected ? 'injected' : 'NOT injected'}, version ${r.version || '?'}`);
  } catch (err) {
    console.error('[sync-www] failed:', err.message);
    process.exit(1);
  }
}
