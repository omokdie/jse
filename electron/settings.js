'use strict';
/**
 * Tiny persistent key/value store: <userData>/settings.json
 *   { "update": { "auto": true, "pendingVersion": "1.0.1" }, "lastDir": "C:\\..." }
 * Synchronous on purpose (small file, rare writes).
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let cache = null;
let file = null;

function load() {
  if (cache) return cache;
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function get(key, defaultValue) {
  const v = load()[key];
  return v === undefined ? defaultValue : v;
}

function set(key, value) {
  const data = load();
  if (value === undefined) delete data[key];
  else data[key] = value;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    // Not fatal: settings simply won't persist this time.
    console.error('settings: write failed', err);
  }
}

/** Read a nested object key, e.g. getIn('update', 'auto', true). */
function getIn(section, key, defaultValue) {
  const sec = get(section, {});
  const v = sec && typeof sec === 'object' ? sec[key] : undefined;
  return v === undefined ? defaultValue : v;
}

function setIn(section, key, value) {
  const sec = { ...(get(section, {}) || {}) };
  if (value === undefined) delete sec[key];
  else sec[key] = value;
  set(section, sec);
}

function filePath() {
  load();
  return file;
}

module.exports = { get, set, getIn, setIn, filePath };
