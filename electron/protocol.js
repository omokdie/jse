'use strict';
/**
 * app:// protocol — serves the web app (app/ folder) to the renderer.
 *
 * Why a custom scheme instead of file:// or a local HTTP server?
 *  - file://  : ES modules are blocked by CORS ("null" origin), service workers
 *               are not allowed, fetch() of relative files fails.
 *  - http://127.0.0.1:<random port> : works, but the origin changes with the
 *               port, so IndexedDB / localStorage (autosave, recent files,
 *               ssnap.installedVersion) would be lost between launches unless
 *               a fixed port is used — which can collide with other software.
 *  - app://scoresnap (standard + secure scheme, protocol.handle) : a stable
 *               origin, ES modules, fetch(), service workers, IndexedDB and
 *               localStorage all work, nothing listens on the network.
 *
 * Packaged location of the web app:  <install dir>/resources/web/index.html
 *   (electron-builder `extraResources: [{from: "../app", to: "web"}]`)
 * Development (electron .):          ../app/index.html
 */
const { app, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SCHEME = 'app';
const HOST = 'scoresnap';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
const INDEX_URL = `${APP_ORIGIN}/index.html`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.ssnap': 'application/x-scoresnap',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.mxl': 'application/vnd.recordare.musicxml',
};

/** Absolute path of the folder that contains index.html. */
function getAppRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  return path.resolve(__dirname, '..', 'app');
}

/** Must be called before app 'ready'. */
function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,          // URL parsing like http:, relative imports work
        secure: true,            // treated as a secure context (service worker, crypto.subtle …)
        supportFetchAPI: true,   // fetch('version.json') from the page
        corsEnabled: true,
        allowServiceWorkers: true,
        stream: true,
      },
    },
  ]);
}

/** Resolve a URL path inside root; returns null when it escapes the root. */
function resolveSafe(root, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '' || p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const abs = path.normalize(path.join(root, p));
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function textResponse(status, text) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Must be called after app 'ready'. */
function registerAppProtocol(log) {
  const root = getAppRoot();
  protocol.handle(SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, 'Bad request');
    }
    if (url.hostname !== HOST) return textResponse(404, 'Not found');

    let file;
    try {
      file = resolveSafe(root, url.pathname);
    } catch {
      return textResponse(400, 'Bad path');
    }
    if (!file) return textResponse(403, 'Forbidden');

    let data;
    try {
      data = await fs.promises.readFile(file);
    } catch (err) {
      if (err && err.code === 'EISDIR') {
        try {
          file = path.join(file, 'index.html');
          data = await fs.promises.readFile(file);
        } catch {
          return textResponse(404, 'Not found');
        }
      } else if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return textResponse(404, 'Not found');
      } else {
        if (log) log.warn('app:// read error', file, err);
        return textResponse(500, 'Internal error');
      }
    }

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(data.byteLength),
        // Files are local; the web app's service worker decides what to cache.
        'Cache-Control': 'no-cache',
      },
    });
  });
}

module.exports = {
  SCHEME,
  HOST,
  APP_ORIGIN,
  INDEX_URL,
  MIME,
  getAppRoot,
  registerSchemes,
  registerAppProtocol,
  resolveSafe,
};
