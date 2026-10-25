// Persistent storage for saved entries.
// Uses IndexedDB (large capacity, so uploaded photos fit). If the browser blocks
// IndexedDB (some private windows), it falls back to an in-memory store and reports it.

const DB_NAME = 'travel-world-map';
const DB_VERSION = 1;
const STORE = 'entries';

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
}

class MemoryStore {
  constructor() { this.map = new Map(); this.persistent = false; this.kind = 'memory'; }
  async all() { return [...this.map.values()].map(e => structuredClone(e)); }
  async put(entry) { this.map.set(entry.id, structuredClone(entry)); }
  async putMany(entries) { entries.forEach(e => this.map.set(e.id, structuredClone(e))); }
  async remove(id) { this.map.delete(id); }
}

class IDBStore {
  constructor(db) { this.db = db; this.persistent = true; this.kind = 'indexeddb'; }
  tx(mode) { return this.db.transaction(STORE, mode).objectStore(STORE); }
  async all() { return promisify(this.tx('readonly').getAll()); }
  async put(entry) { return promisify(this.tx('readwrite').put(entry)); }
  async putMany(entries) {
    const t = this.db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    entries.forEach(e => s.put(e));
    return new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
  }
  async remove(id) { return promisify(this.tx('readwrite').delete(id)); }
}

export async function openStore() {
  try {
    const db = await openDB();
    const store = new IDBStore(db);
    // Ask the browser not to evict this site's data under storage pressure.
    try { if (navigator.storage?.persist) store.durable = await navigator.storage.persist(); } catch { /* ignore */ }
    return store;
  } catch (err) {
    console.warn('IndexedDB unavailable, using memory only:', err);
    return new MemoryStore();
  }
}
