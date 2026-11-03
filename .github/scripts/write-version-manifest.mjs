#!/usr/bin/env node
/**
 * Writes the published update manifest <site>/version.json (SPEC §7) after the
 * web bundle zip has been created:
 *
 * {
 *   "version": "1.2.0", "build": "…",                       ← from app/version.json
 *   "web":     { "bundle": "web-1.2.0.zip", "sha256": "…", "size": 123 },
 *   "android": { "apk": "JSE-1.2.0.apk", "apkUrl": "https://github.com/<o>/<r>/releases/download/v1.2.0/JSE-1.2.0.apk",
 *                "minNative": "1.0.0" },                     ← minNative from release.json (androidMinNative)
 *   "windows": { "installer": "JSE-Setup-1.2.0.exe", "installerUrl": "…" },
 *   "notes": "…", "publishedAt": "…"
 * }
 *
 * It keeps the {version, build} keys so the web app (which reads its own
 * version.json) is unaffected.
 *
 * usage: node write-version-manifest.mjs --site <dir> --zip <file> [--repo owner/repo]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const site = path.resolve(arg('--site', 'site'));
const zip = path.resolve(arg('--zip', ''));
const repo = arg('--repo', process.env.GITHUB_REPOSITORY || 'REPLACE_GITHUB_OWNER/scoresnap');
const versionFile = path.resolve(arg('--version-file', path.join(repoRoot, 'app', 'version.json')));
const releaseFile = path.resolve(arg('--release-file', path.join(repoRoot, 'release.json')));

if (!zip || !fs.existsSync(zip)) {
  console.error(`[version-manifest] bundle zip not found: ${zip}`);
  process.exit(1);
}

const appVersion = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
const version = String(appVersion.version || '').trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[version-manifest] invalid app/version.json version: "${version}"`);
  process.exit(1);
}

let release = {};
try {
  release = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
} catch {
  /* optional */
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
const size = fs.statSync(zip).size;
const releaseBase = `https://github.com/${repo}/releases/download/v${version}/`;
const apk = `JSE-${version}.apk`;
const installer = `JSE-Setup-${version}.exe`;

const manifest = {
  version,
  build: appVersion.build || new Date().toISOString(),
  web: { bundle: path.basename(zip), sha256, size },
  android: {
    apk,
    apkUrl: releaseBase + apk,
    minNative: String(release.androidMinNative || '1.0.0'),
  },
  windows: {
    installer,
    installerUrl: releaseBase + installer,
  },
  notes: String(release.notes || ''),
  publishedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(site, 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[version-manifest] ${path.join(site, 'version.json')}`);
console.log(JSON.stringify(manifest, null, 2));
