/* JSE service worker: offline cache + auto update. The cache name embeds the app version
   (kept in sync with version.json by tools/build.mjs). */
const VERSION = '__VERSION__';
const CACHE = 'scoresnap-' + VERSION;
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'version.json', 'css/app.css',
  'vendor/jszip.min.js', 'vendor/pdf-lib.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'js/main.js',
];
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE.map(u => new Request(u, { cache: 'reload' }))).catch(() => {});
    // module graph: fetch the list produced at build time if present
    try { const r = await fetch('asset-list.json', { cache: 'reload' }); if (r.ok) { const list = await r.json(); await c.addAll(list.map(u => new Request(u, { cache: 'reload' }))); } } catch { /* dev mode */ }
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('scoresnap-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'ACTIVATED', version: VERSION }));
  })());
});
self.addEventListener('message', e => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // version.json: network first (update checks)
  if (url.pathname.endsWith('version.json')) { e.respondWith(fetch(req).catch(() => caches.match(req))); return; }
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    const fetchPromise = fetch(req).then(res => { if (res && res.ok && (res.type === 'basic' || res.type === 'default')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }).catch(() => null);
    if (cached) { fetchPromise.catch(() => {}); return cached; }   // cache first, refresh in background
    const net = await fetchPromise;
    if (net) return net;
    if (req.mode === 'navigate') return caches.match('index.html');
    return new Response('offline', { status: 503 });
  })());
});
