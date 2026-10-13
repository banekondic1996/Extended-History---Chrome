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

  // Reads the store in slices instead of one giant getAll(): with millions of entries a
  // single call makes Chrome serialize and then V8 deserialize everything at once, which
  // roughly doubles peak memory. Keys are the string `id`, so each slice continues after
  // the last key of the previous one.
  async function getAll() {
    const db = await _open();
    const out = [];
    const SLICE = 20000;
    let last = null;
    for (;;) {
      const rows = await new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readonly');
        const range = last === null ? null : IDBKeyRange.lowerBound(last, true);
        const req   = tx.objectStore(STORE).getAll(range, SLICE);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });
      for (let i = 0; i < rows.length; i++) out.push(rows[i]);
      if (rows.length < SLICE) break;
      last = rows[rows.length - 1].id;
    }
    return out;
  }

  // Runs `count` requests in one transaction, issuing them CHUNK at a time: the next chunk
  // is queued from the last success callback of the previous one, which keeps the
  // transaction alive but never has more than CHUNK requests (and structured-clone copies
  // of entries) in flight. Queueing millions at once was a multi-GB memory spike.
  // Resolves off request callbacks, not tx.oncomplete (unreliable in this MV3 service worker).
  function _bulk(count, issue, beforeStart) {
    return _open().then(db => new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      const CHUNK = 2000;
      let i = 0;
      function next() {
        if (i >= count) { resolve(); return; }
        const end = Math.min(i + CHUNK, count);
        let pending = end - i;
        for (; i < end; i++) {
          const req = issue(store, i);
          req.onsuccess = () => { if (--pending === 0) next(); };
          req.onerror   = () => reject(req.error);
        }
      }
      if (beforeStart) {
        const r = beforeStart(store);
        r.onsuccess = () => next();
        r.onerror   = () => reject(r.error);
      } else next();
    }));
  }

  // Replaces entire store contents — matches the setAll(entries) pattern in background.js
  async function setAll(entries) {
    return _bulk(entries.length, (store, i) => store.put(entries[i]), store => store.clear());
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

  // Deletes the whole IndexedDB database (not just its rows) so the disk space is really released.
  async function destroy() {
    try { if (_db) { _db.close(); _db = null; } } catch (_) {}
    return new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
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

  // Remove specific entries by id — MUCH faster than setAll() for deletes,
  // since it only touches the rows being removed instead of clearing and
  // reinserting the entire store.
  async function removeIds(ids) {
    if (!ids || !ids.length) return;
    return _bulk(ids.length, (store, i) => store.delete(ids[i]));
  }

  // Add/update specific entries without touching the rest of the store —
  // used for incoming visits and imports so we never need a full read+rewrite.
  async function putMany(entries) {
    if (!entries || !entries.length) return;
    return _bulk(entries.length, (store, i) => store.put(entries[i]));
  }

  // ── Index queries ──────────────────────────────────────────────────────────
  // The store has an index on visitTime, so a day, a count, the oldest entry or "the newest
  // N" are answered by the database itself — no need to hold the whole history in memory.
  function _index(mode) {
    return _open().then(db => db.transaction(STORE, mode || 'readonly').objectStore(STORE).index('visitTime'));
  }
  const _req = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const _range = (lo, hi, hiOpen) => IDBKeyRange.bound(lo, hi, false, !!hiOpen);

  // Entries with lo <= visitTime <= hi (hi exclusive when hiOpen).
  async function getRange(lo, hi, hiOpen) {
    if (lo > hi) return [];
    return _req((await _index()).getAll(_range(lo, hi, hiOpen)));
  }
  async function countRange(lo, hi, hiOpen) {
    if (lo > hi) return 0;
    return _req((await _index()).count(_range(lo, hi, hiOpen)));
  }
  async function oldestVisitTime() {
    const idx = await _index();
    return new Promise((resolve, reject) => {
      const req = idx.openKeyCursor(null, 'next');
      req.onsuccess = () => resolve(req.result ? req.result.key : null);
      req.onerror   = () => reject(req.error);
    });
  }
  async function newestVisitTime(maxT) {
    const idx = await _index();
    return new Promise((resolve, reject) => {
      const req = idx.openKeyCursor(maxT ? IDBKeyRange.upperBound(maxT) : null, 'prev');
      req.onsuccess = () => resolve(req.result ? req.result.key : null);
      req.onerror   = () => reject(req.error);
    });
  }
  // Primary keys (ids) of every entry older than t — values are not loaded.
  async function keysBelow(t) {
    return _req((await _index()).getAllKeys(IDBKeyRange.upperBound(t, true)));
  }
  // visitTime of the entry at position n when sorted oldest → newest (0 = oldest).
  async function visitTimeAtRank(n) {
    const idx = await _index();
    return new Promise((resolve, reject) => {
      const req = idx.openKeyCursor(null, 'next');
      let skipped = n <= 0;
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(null); return; }
        if (!skipped) { skipped = true; c.advance(n); return; }
        resolve(c.key);
      };
      req.onerror = () => reject(req.error);
    });
  }
  // One page, newest first, from the index: skip `offset`, return `limit` entries within [lo, hi].
  async function newest(lo, hi, hiOpen, offset, limit) {
    if (lo > hi || limit <= 0) return [];
    const idx = await _index();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = idx.openCursor(_range(lo, hi, hiOpen), 'prev');
      let skipped = !(offset > 0);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(out); return; }
        if (!skipped) { skipped = true; c.advance(offset); return; }
        out.push(c.value);
        if (out.length >= limit) { resolve(out); return; }
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
  // Streams the whole store in slices and keeps only entries where pred(e) is true —
  // memory stays flat no matter how big the history is (used for text search).
  async function filterAll(pred) {
    const db = await _open();
    const out = [];
    const SLICE = 20000;
    let last = null;
    for (;;) {
      const rows = await new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readonly');
        const range = last === null ? null : IDBKeyRange.lowerBound(last, true);
        const req   = tx.objectStore(STORE).getAll(range, SLICE);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });
      for (let i = 0; i < rows.length; i++) if (pred(rows[i])) out.push(rows[i]);
      if (rows.length < SLICE) break;
      last = rows[rows.length - 1].id;
    }
    return out;
  }

  // Streams the store in slices to fn(rows) — nothing accumulates in memory.
  async function forEachSlice(fn) {
    const db = await _open();
    const SLICE = 20000;
    let last = null;
    for (;;) {
      const rows = await new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE, 'readonly');
        const range = last === null ? null : IDBKeyRange.lowerBound(last, true);
        const req   = tx.objectStore(STORE).getAll(range, SLICE);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });
      if (rows.length) await fn(rows);
      if (rows.length < SLICE) return;
      last = rows[rows.length - 1].id;
    }
  }

  return { forEachSlice, getAll, setAll, clear, destroy, count, removeIds, putMany, getRange, countRange, oldestVisitTime, newestVisitTime, keysBelow, visitTimeAtRank, newest, filterAll };
})();

// Available as EhIdb in service worker scope (importScripts) or window.EhIdb in pages
if (typeof window !== 'undefined') window.EhIdb = EhIdb;