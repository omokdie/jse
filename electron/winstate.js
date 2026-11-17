'use strict';
/**
 * Window geometry + the desktop options of the settings window (설정 › Windows 앱).
 * Pure functions only — no Electron imports — so they are unit-tested in plain Node
 * (tools/tests/electron-shell.test.js).  main.js does the I/O.
 *
 *   settings.json → "app":    { rememberBounds, startMaximized, disableGpu, defaultDir }
 *                   "window": { bounds: {x, y, width, height}, maximized }
 */
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1360;
const DEFAULT_HEIGHT = 860;

const APP_DEFAULTS = Object.freeze({ rememberBounds: true, startMaximized: false, disableGpu: false, defaultDir: '' });

function isRect(b) {
  return !!b && typeof b === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0;
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Stored bounds → { width, height, x?, y? } for `new BrowserWindow`.
 * The size is clamped to the largest display; the position is only restored while a usable part of
 * the title bar (120 × 20 px of the top strip) is on one of the displays — a monitor may be gone.
 */
function restoreBounds(stored, workAreas, opts) {
  const o = opts || {};
  const minW = o.minWidth || MIN_WIDTH;
  const minH = o.minHeight || MIN_HEIGHT;
  const out = { width: o.defaultWidth || DEFAULT_WIDTH, height: o.defaultHeight || DEFAULT_HEIGHT };
  if (!isRect(stored)) return out;
  const areas = (Array.isArray(workAreas) ? workAreas : []).filter(isRect);
  const maxW = areas.length ? Math.max(...areas.map((a) => a.width)) : 16000;
  const maxH = areas.length ? Math.max(...areas.map((a) => a.height)) : 16000;
  out.width = Math.round(Math.max(minW, Math.min(stored.width, Math.max(minW, maxW))));
  out.height = Math.round(Math.max(minH, Math.min(stored.height, Math.max(minH, maxH))));
  const strip = { x: stored.x, y: stored.y, width: out.width, height: 40 };
  const visible = areas.some((a) => {
    const ov = overlap(strip, a);
    return ov.w >= 120 && ov.h >= 20;
  });
  if (visible) {
    out.x = Math.round(stored.x);
    out.y = Math.round(stored.y);
  }
  return out;
}

/** What is worth writing to settings.json for a window (null when the numbers are unusable). */
function boundsToStore(bounds, maximized) {
  if (!isRect(bounds)) return null;
  return {
    bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) },
    maximized: !!maximized,
  };
}

/** Stored "app" section (anything) → complete, typed options. */
function readAppSettings(stored) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  return {
    rememberBounds: s.rememberBounds !== false,
    startMaximized: s.startMaximized === true,
    disableGpu: s.disableGpu === true,
    defaultDir: typeof s.defaultDir === 'string' ? s.defaultDir : '',
  };
}

/** Partial update from the renderer → only the known keys with the right types. */
function cleanAppSettings(partial) {
  const p = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  const out = {};
  for (const k of ['rememberBounds', 'startMaximized', 'disableGpu']) if (typeof p[k] === 'boolean') out[k] = p[k];
  if (typeof p.defaultDir === 'string' && p.defaultDir.length <= 1024) out.defaultDir = p.defaultDir;
  return out;
}

/** Zoom factor for webContents.setZoomFactor (설정 › 화면 › 화면 요소 크기): 0.5 … 2, default 1. */
function cleanZoomFactor(value) {
  const f = Number(value);
  if (!Number.isFinite(f) || f <= 0) return 1;
  return Math.round(Math.max(0.5, Math.min(2, f)) * 100) / 100;
}

module.exports = {
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  APP_DEFAULTS,
  isRect,
  restoreBounds,
  boundsToStore,
  readAppSettings,
  cleanAppSettings,
  cleanZoomFactor,
};
