#!/usr/bin/env node
/**
 * Copies the version from ../../app/version.json into electron/package.json
 * (and package-lock.json when present) so electron-builder / electron-updater
 * use the same version as the web app.  Runs before every build (npm scripts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '..');
const versionFile = path.resolve(electronDir, '..', 'app', 'version.json');
const pkgFile = path.join(electronDir, 'package.json');
const lockFile = path.join(electronDir, 'package-lock.json');

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

if (!fs.existsSync(versionFile)) {
  console.error(`[sync-version] ${versionFile} not found — keeping package.json version`);
  process.exit(0);
}

const { version } = readJson(versionFile);
if (!SEMVER.test(String(version || ''))) {
  console.error(`[sync-version] invalid version "${version}" in app/version.json (expected x.y.z)`);
  process.exit(1);
}

const pkg = readJson(pkgFile);
if (pkg.version !== version) {
  pkg.version = version;
  writeJson(pkgFile, pkg);
  console.log(`[sync-version] package.json → ${version}`);
} else {
  console.log(`[sync-version] package.json already at ${version}`);
}

if (fs.existsSync(lockFile)) {
  try {
    const lock = readJson(lockFile);
    let changed = false;
    if (lock.version !== version) {
      lock.version = version;
      changed = true;
    }
    if (lock.packages && lock.packages[''] && lock.packages[''].version !== version) {
      lock.packages[''].version = version;
      changed = true;
    }
    if (changed) {
      writeJson(lockFile, lock);
      console.log(`[sync-version] package-lock.json → ${version}`);
    }
  } catch (err) {
    console.warn('[sync-version] could not update package-lock.json:', err.message);
  }
}
