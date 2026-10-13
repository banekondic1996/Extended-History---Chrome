/**
 * eh-sql.js — background-side client for the SQLite history database.
 *
 * Same method names as EhIdb (so the rest of background.js can use either), plus the extra
 * query methods that make a big history cheap: page(), deleteBelow(), topBy(), updateTitle()...
 * Every call is a message to the offscreen document (offscreen.js → db-worker.js), which owns
 * the database. Nothing here caches history: results are small pages/aggregates.
 */
const EhSql = (() => {
  const SLICE = 20000;           // rows per message when streaming the whole table
  const WRITE = 10000;           // rows per message when writing
  let _offPromise = null;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const lim = (v) => (v === Infinity || v === -Infinity || v === undefined ? null : v);

  function ensureOffscreen() {
    if (!_offPromise) {
      _offPromise = (async () => {
        try {
          const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
          if (!ctx.length) {
            await chrome.offscreen.createDocument({
              url: 'html/offscreen.html',
              reasons: ['WORKERS'],
              justification: 'Run the SQLite (WASM) history database in a Worker',
            });
          }
        } catch (e) {
          if (!/single offscreen|already exists/i.test(String(e && e.message))) { _offPromise = null; throw e; }
        }
      })();
    }
    return _offPromise;
  }

  async function rpc(op, args) {
    await ensureOffscreen();
    let lastErr;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const r = await chrome.runtime.sendMessage({ target: 'eh-sql', op, args });
        if (!r) throw new Error('Receiving end does not exist (no response)');
        if (!r.ok) throw new Error(r.error);
        return r.result;
      } catch (e) {
        lastErr = e;
        // The offscreen page may still be starting (listener not registered yet), or was closed.
        if (/Receiving end does not exist|Could not establish connection/i.test(String(e.message))) {
          if (attempt === 6) { _offPromise = null; await ensureOffscreen(); }
          await sleep(150);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('SQLite database is not responding');
  }

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
    reset() { _offPromise = null; },      // forget the offscreen document (it was closed)
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
  };
})();
