/**
 * eh-idb.js — IndexedDB storage backend for Extended History
 *
 * Drop this file next to background.js and add to manifest.json service_worker
 * by importing it at the top of background.js:
 *   importScripts('eh-idb.js');
 *
 * Exposes:  window.EhIdb  (or just EhIdb in SW context)
 *
 * API mirrors chrome.storage.local usage in background.js:
 *   EhIdb.getAll()           → Promise<entry[]>
 *   EhIdb.setAll(entries)    → Promise<void>
 *   EhIdb.clear()            → Promise<void>
 *   EhIdb.count()            → Promise<number>
 */

const EhIdb = (() => {
  const DB_NAME    = 'eh_history_idb';
  const DB_VERSION = 1;
  const STORE      = 'entries';

  let _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          // Index by visitTime for fast date-range queries
          store.createIndex('visitTime', 'visitTime', { unique: false });
          store.createIndex('url', 'url', { unique: false });
          store.createIndex('domain', 'domain', { unique: false });
        }
      };
      req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
      req.onerror    = e => reject(e.target.error);
      req.onblocked  = () => reject(new Error('IDB blocked — close other tabs'));
    });
  }

  async function getAll() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  // Replaces entire store contents — matches the setAll(entries) pattern in background.js
  async function setAll(entries) {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      // Clear first, then bulk-insert
      const clearReq = store.clear();
      clearReq.onsuccess = () => {
        let pending = entries.length;
        if (!pending) { resolve(); return; }
        for (const e of entries) {
          const putReq = store.put(e);
          putReq.onsuccess = () => { pending--; if (pending === 0) resolve(); };
          putReq.onerror   = () => reject(putReq.error);
        }
      };
      clearReq.onerror = () => reject(clearReq.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clear() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async function count() {
    const db = await _open();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  return { getAll, setAll, clear, count };
})();

// Available as EhIdb in service worker scope (importScripts) or window.EhIdb in pages
if (typeof window !== 'undefined') window.EhIdb = EhIdb;