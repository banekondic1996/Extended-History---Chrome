/**
 * eh-sql.js — client + host of the SQLite (WASM) history database, for the Firefox background page.
 *
 * Same method names as EhIdb (so the rest of background.js can use either), plus the extra query
 * methods that make a big history cheap: page(), deleteBelow(), topBy(), updateTitle()...
 *
 * (The Chrome build needs a hidden offscreen document to host the database Worker. Firefox has
 * no such API and needs none: the persistent background page starts the Worker itself.) The worker is the ONLY context that touches the database (the OPFS
 * storage pool is exclusive), so there are never conflicting writers.
 *
 * Extension pages (history.html) can also address the worker through runtime messages
 * {target:'eh-sql', op, args} — those are answered at the bottom of this file.
 * Nothing here caches history: results are small pages/aggregates.
 */
const EhSql = (() => {
  const SLICE = 20000;           // rows per message when streaming the whole table
  const WRITE = 10000;           // rows per message when writing
  const WORKER_PATH = 'js/database/db-worker.js?sqlite3.dir=sqlite&opfs-disable';
  const lim = (v) => (v === Infinity || v === -Infinity || v === undefined ? null : v);

  // ── The Worker ─────────────────────────────────────────────────────────────
  let worker = null, seq = 0, restarts = 0;
  const pending = new Map();

  function startWorker() {
    const w = new Worker(browser.runtime.getURL(WORKER_PATH));
    worker = w;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m && m.recycle) { setTimeout(() => { if (pending.size === 0 && worker === w) resetWorker(); }, 1500); return; }
      const p = m && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) restarts = 0;
      if (m.fatal && worker === w) resetWorker();   // init failed (e.g. storage still locked by a previous instance) — the next call starts a fresh worker
      p.resolve(m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error });
    };
    w.onerror = (e) => {
      const err = 'database worker error: ' + ((e && e.message) || e);
      for (const [, p] of pending) p.resolve({ ok: false, error: err });
      pending.clear();
      if (worker === w) resetWorker();
    };
  }
  function resetWorker() {
    try { if (worker) worker.terminate(); } catch (_) {}
    worker = null;
  }

  // → {ok:true, result} | {ok:false, error}
  async function call(op, args) {
    if (!worker) {
      // a previous instance (before an extension reload) may still be releasing its OPFS handles
      if (restarts > 0) await new Promise(r => setTimeout(r, Math.min(3000, 400 * restarts)));
      restarts++;
      if (!worker) {
        try { startWorker(); }
        catch (e) { return { ok: false, error: 'Could not start the database worker: ' + (e && e.message || e) }; }
      }
    }
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, { resolve });
      try { worker.postMessage({ id, op, args }); }
      catch (e) { pending.delete(id); resolve({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  async function rpc(op, args) {
    const r = await call(op, args);
    if (!r.ok) throw new Error(r.error);
    restarts = 0;
    return r.result;
  }

  // ── Streaming / bulk helpers ───────────────────────────────────────────────
  async function forEachSlice(fn, filter = {}) {
    let after = null;
    for (;;) {
      const rows = await rpc('getSlice', { ...filter, lo: lim(filter.lo), hi: lim(filter.hi), after, limit: SLICE });
      const last = rows[rows.length - 1];
      if (last) after = [last.visitTime, last.seq];
      for (const r of rows) delete r.seq;
      if (rows.length) await fn(rows);
      if (rows.length < SLICE) return;
    }
  }
  async function getAll() { const out = []; await forEachSlice(rows => { for (const r of rows) out.push(r); }); return out; }

  async function writeChunks(op, entries) {
    let n = 0;
    for (let i = 0; i < entries.length; i += WRITE) n += (await rpc(op, { entries: entries.slice(i, i + WRITE) })) || 0;
    return n;
  }

  return {
    isSql: true,
    reset() { resetWorker(); },                 // stop the worker (it is started again on the next call)
    // WebAssembly memory never shrinks: after a heavy job a fresh worker gives it back.
    recycle() { if (pending.size === 0) resetWorker(); return Promise.resolve(true); },
    rpc, forEachSlice, getAll,
    count:  () => rpc('count'),
    size:   () => rpc('size'),
    clear:  () => rpc('clear'),                 // drops the database file and starts a new one → disk space is freed
    status: () => rpc('status'),
    shrink: () => rpc('shrink'),
    async setAll(entries) { await rpc('clear'); await writeChunks('putMany', entries); },
    putMany:      (entries) => writeChunks('putMany', entries),
    insertIgnore: (entries) => writeChunks('insertIgnore', entries),    // → number actually added (duplicates skipped by the DB)
    async removeIds(ids) { let n = 0; for (let i = 0; i < ids.length; i += SLICE) n += await rpc('removeIds', { ids: ids.slice(i, i + SLICE) }); return n; },
    async getRange(lo, hi, hiOpen) {
      const out = [];
      for (let offset = 0; ; offset += SLICE) {
        const { entries } = await rpc('page', { lo: lim(lo), hi: lim(hi), hiOpen: !!hiOpen, offset, limit: SLICE, needTotal: false });
        for (const e of entries) out.push(e);
        if (entries.length < SLICE) return out;
      }
    },
    countRange:  (lo, hi, hiOpen) => (lo > hi ? 0 : rpc('countRange', { lo: lim(lo), hi: lim(hi), hiOpen: !!hiOpen })),
    countRanges: (ranges) => rpc('countRanges', { ranges: ranges.map(([lo, hi, o]) => [lim(lo), lim(hi), !!o]) }),
    oldestVisitTime: () => rpc('oldestVisitTime'),
    visitTimeAtRank: (n) => rpc('visitTimeAtRank', { n }),
    // newest-first page within [lo, hi]; offset/limit in rows
    async newest(lo, hi, hiOpen, offset, limit) {
      return (await rpc('page', { lo: lim(lo), hi: lim(hi), hiOpen: !!hiOpen, offset, limit, needTotal: false })).entries;
    },
    // {lo, hi, hiOpen, loOpen, words[], mode, offset, limit, asc, needTotal} → {total, entries}
    page: (o) => rpc('page', { ...o, lo: lim(o.lo), hi: lim(o.hi) }),
    deleteBelow: (t) => rpc('deleteBelow', { t }),
    deleteRange: (lo, hi) => rpc('deleteRange', { lo, hi }),
    deleteWhere: (o) => rpc('deleteWhere', { ...o, lo: lim(o.lo), hi: lim(o.hi) }),
    findByIdsOrUrls: (ids, urls) => rpc('findByIdsOrUrls', { ids: [...ids], urls: [...urls] }),
    topBy:       (o) => rpc('topBy', o),
    importBatch: (o) => rpc('importBatch', o),
    setCache:    (mb) => rpc('setCache', { mb }),
    bulkBegin:   () => rpc('bulkBegin'),
    bulkEnd:     () => rpc('bulkEnd'),
    updateTitle: (o) => rpc('updateTitle', o),
    // Used by the message listener below: the raw {ok, result|error} answer for a request from a page.
    _call: call,
    _pendingCount: () => pending.size,
    _resetWorker: resetWorker,
  };
})();

// Direct route for extension pages in the same browser (see js/theme-init.js): same answer as the message below, without the message.
globalThis.EH_SQL_DIRECT = (op, args) => {
  if (op === 'recycle') { if (EhSql._pendingCount() === 0) EhSql._resetWorker(); return Promise.resolve({ ok: true, result: true }); }
  return EhSql._call(op, args);
};

// ── Requests from extension pages ────────────────────────────────────────────
// history.html talks to the database directly for repair / rescue / big imports:
//   browser.runtime.sendMessage({ target: 'eh-sql', op, args })  →  { ok: true, result } | { ok: false, error }
// (background.js ignores messages with target 'eh-sql'; this is the only listener that answers them.)
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'eh-sql') return;     // not for us — leave it to the other listeners
  if (msg.op === 'recycle') {                      // see EhSql.recycle()
    if (EhSql._pendingCount() === 0) EhSql._resetWorker();
    sendResponse({ ok: true, result: true });
    return;
  }
  EhSql._call(msg.op, msg.args).then(sendResponse);
  return true;                                      // async response
});
