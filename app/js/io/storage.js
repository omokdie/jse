// IndexedDB persistence: autosave of the current document, recent files, settings blobs.
const DB = 'scoresnap', VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('no idb'));
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('recent')) db.createObjectStore('recent', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store);
    const r = fn(s); t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  }));
}
export const storage = {
  async saveDraft(score, meta = {}) {
    const sources = (score.sources || []).map(s => ({ ...s }));   // blobs are structured-cloneable
    try { await tx('docs', 'readwrite', s => s.put({ key: 'current', score: { ...score, sources }, meta, savedAt: Date.now() })); return true; } catch (e) { console.warn('autosave failed', e); return false; }
  },
  async loadDraft() { try { return await tx('docs', 'readonly', s => s.get('current')); } catch { return null; } },
  async clearDraft() { try { await tx('docs', 'readwrite', s => s.delete('current')); } catch { /* ignore */ } },
  async addRecent(entry) {
    try {
      const list = (await this.recent()).filter(r => r.id !== entry.id);
      list.unshift({ ...entry, openedAt: Date.now() });
      await tx('recent', 'readwrite', s => { s.clear(); list.slice(0, 20).forEach(r => s.put(r)); });
    } catch { /* ignore */ }
  },
  async recent() { try { const all = await tx('recent', 'readonly', s => s.getAll()); return (all || []).sort((a, b) => b.openedAt - a.openedAt); } catch { return []; } },
  async removeRecent(id) { try { await tx('recent', 'readwrite', s => s.delete(id)); } catch { /* ignore */ } },
  async get(key) { try { const r = await tx('kv', 'readonly', s => s.get(key)); return r?.value; } catch { return undefined; } },
  async set(key, value) { try { await tx('kv', 'readwrite', s => s.put({ key, value })); } catch { /* ignore */ } },
};
