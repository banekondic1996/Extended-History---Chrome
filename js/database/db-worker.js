'use strict';
/**
 * db-worker.js — the SQLite (WASM) database for Extended History.
 *
 * Runs as a dedicated Worker spawned by eh-sql.js from the background page (only a worker
 * may use OPFS sync access). The database file lives
 * on disk in the extension's private OPFS storage via SQLite's "opfs-sahpool" VFS, so the
 * history is NEVER held in JavaScript memory: every request is a SQL query that returns
 * only the rows asked for (a day, a page, a count, an aggregate).
 *
 * Message protocol:  {id, op, args}  →  {id, ok:true, result} | {id, ok:false, error, fatal?}
 *
 * ── Schema (v2) ──────────────────────────────────────────────────────────────
 *  The table is CLUSTERED BY TIME (PRIMARY KEY(visit_time, seq), WITHOUT ROWID), so a day, the
 *  newest page and a "search from newest backwards" are all sequential reads, and retention
 *  pruning is a single range delete. The two secondary indexes only hold small integers
 *  (a 53-bit hash of the url / domain + the 5-second bucket) instead of full URLs, which keeps
 *  imports fast and the file small:
 *    entries_dedupe UNIQUE(uh, bucket)  — "same URL within 5 s is one visit", enforced by the DB
 *    entries_dom    (dh, bucket)        — Most-visited domains without scanning URLs
 *  An entry's public id is  "<visit_time>_<seq>"  — i.e. its primary key — so deleting by id
 *  needs no extra index.
 */
let loadError = null;
if (typeof importScripts === 'function') {
  try { importScripts('sqlite/sqlite3.js'); }
  catch (e) { loadError = 'Could not load "sqlite/sqlite3.js" next to db-worker.js (' + (e && e.message || e) + '). Make sure js/database/sqlite/ contains sqlite3.js and sqlite3.wasm.'; }
}

let sqlite3 = null, db = null, pool = null, readyPromise = null;
let progress = { phase: 'init', done: 0, total: 0 };
let _cnt = null;                                   // cached row count (null = unknown)
const READ_ONLY_OPS = new Set(['ping', 'status', 'info', 'count', 'hasRows', 'size', 'getSlice', 'page', 'countRange', 'countRanges', 'oldestVisitTime', 'newestVisitTime', 'rescueChunk', 'visitTimeAtRank', 'findByIdsOrUrls', 'topBy', 'hourBuckets']);
const FILE_V2 = '/eh_v2.sqlite3';
const FILE_V1 = '/eh_history.sqlite3';       // schema used by earlier test builds — upgraded on first start

const lc = (s) => String(s == null ? '' : s).toLowerCase();
// Yield to the event loop (so new requests can be read). MessageChannel instead of setTimeout:
// timers in a hidden page's worker can be throttled to a crawl, a posted message is not.
const _mc = new MessageChannel(), _waiters = [];
_mc.port1.onmessage = () => { const r = _waiters.shift(); if (r) r(); };
const tick = () => new Promise(r => { _waiters.push(r); _mc.port2.postMessage(0); });
// Long background jobs (finishing an import, rebuilding the search index) run in slices with a pause after each one,
// so they use roughly half of one CPU core and the disk is not saturated — the browser stays usable while they run.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function breathe(t0) { await sleep(Math.max(25, Math.min(1500, (performance.now() - t0) * 2.5))); }
const COLS = 'visit_time AS visitTime, seq, url, raw_url AS rawUrl, title, domain';
const ECOLS = 'e.visit_time AS visitTime, e.seq, e.url, e.raw_url AS rawUrl, e.title, e.domain';

// 53-bit string hash (cyrb53) — used for the compact dedupe / domain indexes.
function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const newSeq = () => Math.floor(Math.random() * 2147483647);

const _kwRe = new Map();
function qfKwRe(w, f) {
  const key = f + ':' + w;
  let re = _kwRe.get(key);
  if (!re) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), W = '\\p{L}\\p{N}';
    // a boundary only makes sense next to a letter/digit (a keyword edge that is a symbol, e.g. "/login", needs none)
    const left  = !(f & 1) && new RegExp('^[' + W + ']', 'u').test(w) ? '(?<![' + W + '])' : '';
    const right = !(f & 2) && new RegExp('[' + W + ']$', 'u').test(w) ? '(?![' + W + '])'  : '';
    re = new RegExp(left + esc + right, 'iu');
    _kwRe.set(key, re);
  }
  return re;
}

function createSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS entries(
      visit_time REAL    NOT NULL,
      seq        INTEGER NOT NULL,
      url        TEXT    NOT NULL,
      raw_url    TEXT,
      title      TEXT,
      domain     TEXT,
      uh         INTEGER NOT NULL,
      bucket     INTEGER NOT NULL,
      dh         INTEGER NOT NULL,
      PRIMARY KEY(visit_time, seq)
    ) WITHOUT ROWID;
  `);
  d.createFunction('jslower', (cx, v) => lc(v), { arity: 1, deterministic: true });   // Unicode-aware, like JS toLowerCase()
  // qfkw(text, keyword, flags): whole-word keyword test for quick filters. flags: 1 = "*" before the keyword (no left boundary), 2 = "*" after it
  d.createFunction('qfkw', (cx, v, w, f) => qfKwRe(String(w), f | 0).test(v == null ? '' : String(v)), { arity: 3, deterministic: true });
}

function hasTable(n) { return db.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','virtual table') AND name=?", [n]) > 0; }
function createFtsObjects() {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      url, title, domain,
      visit_time UNINDEXED,
      seq UNINDEXED,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(url,title,domain,visit_time,seq)
      VALUES(new.url, ifnull(new.title,''), ifnull(new.domain,''), new.visit_time, new.seq);
    END;
    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
      DELETE FROM entries_fts WHERE visit_time=old.visit_time AND seq=old.seq;
    END;
    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF url,title,domain ON entries BEGIN
      DELETE FROM entries_fts WHERE visit_time=old.visit_time AND seq=old.seq;
      INSERT INTO entries_fts(url,title,domain,visit_time,seq)
      VALUES(new.url, ifnull(new.title,''), ifnull(new.domain,''), new.visit_time, new.seq);
    END;
  `);
}
function dropFtsObjects() {
  db.exec(`
    DROP TRIGGER IF EXISTS entries_ai;
    DROP TRIGGER IF EXISTS entries_ad;
    DROP TRIGGER IF EXISTS entries_au;
    DROP TABLE IF EXISTS entries_fts;
  `);
}
async function rebuildFts() {
  setFtsFlag(false);
  progress = { phase: 'indexing', done: 0, total: 0 };
  await tick();
  dropFtsObjects();
  createFtsObjects();
  // windowed by visit_time so progress is real and the worker stays responsive
  const lo0 = db.selectValue('SELECT MIN(visit_time) FROM entries');
  const hi0 = db.selectValue('SELECT MAX(visit_time) FROM entries');
  if (lo0 != null) {
    const span = Math.max(1, hi0 - lo0);
    let lo = lo0;
    while (true) {
      const _t0 = performance.now();
      let edge = db.selectValue('SELECT visit_time FROM entries WHERE visit_time >= ? ORDER BY visit_time LIMIT 1 OFFSET 30000', [lo]);
      let cond = edge == null ? 'visit_time >= ?' : 'visit_time >= ? AND visit_time < ?', bind = edge == null ? [lo] : [lo, edge];
      if (edge != null && edge <= lo) {                // 30k+ rows share one timestamp: take that timestamp alone, then move past it
        cond = 'visit_time = ?'; bind = [lo];
        edge = db.selectValue('SELECT MIN(visit_time) FROM entries WHERE visit_time > ?', [lo]);
      }
      db.exec({ sql: `INSERT INTO entries_fts(url,title,domain,visit_time,seq)
           SELECT url, ifnull(title,''), ifnull(domain,''), visit_time, seq FROM entries WHERE ` + cond, bind });
      if (edge == null) break;
      lo = edge;
      progress = { phase: 'indexing', done: Math.min(99, Math.round(100 * (lo - lo0) / span)), total: 100, pctOnly: true, step: 'Building search index…' };
      await breathe(_t0);
    }
  }
  setFtsFlag(true);
  progress = { phase: 'ready', done: 0, total: 0 };
}
// Whether the full-text index is known to be complete. Checking that by counting both tables at every start
// scans the whole database (seconds on 1 GB), so a small flag is kept instead: set after every successful
// (re)build, cleared before any bulk operation and set again when it finishes. A crash in between leaves it
// cleared → the next start verifies / rebuilds as before.
function ftsFlag() {
  try { return db.selectValue("SELECT v FROM eh_meta WHERE k='fts_ok'") === 1; } catch (_) { return false; }
}
function setFtsFlag(ok) {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS eh_meta(k TEXT PRIMARY KEY, v)');
    db.exec({ sql: "INSERT OR REPLACE INTO eh_meta(k, v) VALUES('fts_ok', ?)", bind: [ok ? 1 : 0] });
  } catch (_) {}
}
async function ensureFts() {
  createFtsObjects();
  if (hasTable('entries_fts') && ftsFlag()) return;           // known good: no counting
  let ec = 0, fc = -1;
  try {
    ec = db.selectValue('SELECT COUNT(*) FROM entries') || 0;
    fc = hasTable('entries_fts') ? (db.selectValue('SELECT COUNT(*) FROM entries_fts') || 0) : -1;
  } catch (_) { fc = -1; }
  if (ec !== fc) await rebuildFts(); else setFtsFlag(true);
}

// ── Deferred search-index updates during a big direct import ─────────────────
// Updating the full-text index for every inserted row is a third of the import cost. During an import a tiny trigger only notes
// WHICH rows were added (append-only, cheap); afterwards the search index is brought up to date in small throttled windows.
// Everything is persisted, so an interrupted import is simply continued on the next start.
function ftsDeferBegin() {
  if (hasTable('fts_pending')) return true;
  db.exec(`
    CREATE TABLE fts_pending(visit_time REAL, seq INTEGER);
    DROP TRIGGER IF EXISTS entries_ai;
    CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO fts_pending(visit_time, seq) VALUES(new.visit_time, new.seq); END;
  `);
  setFtsFlag(false);
  return true;
}
async function ftsDeferEnd() {
  if (!hasTable('fts_pending')) return 0;
  createFtsObjects();                                 // entries_fts (if missing); entries_ai is recreated below
  const hi = db.selectValue('SELECT MAX(rowid) FROM fts_pending') || 0;
  const W = 20000;
  let done = 0;
  progress = { phase: 'indexing', done: 0, total: 100, pctOnly: true, step: 'Building search index…'};
  await tick();
  for (let lo = 0; lo < hi; lo += W) {
    const t0 = performance.now();
    inTx(() => {
      db.exec({ sql: `INSERT INTO entries_fts(url,title,domain,visit_time,seq)
        SELECT e.url, ifnull(e.title,''), ifnull(e.domain,''), e.visit_time, e.seq FROM fts_pending p JOIN entries e ON e.visit_time=p.visit_time AND e.seq=p.seq
        WHERE p.rowid>? AND p.rowid<=?`, bind: [lo, lo + W] });
      db.exec({ sql: 'DELETE FROM fts_pending WHERE rowid>? AND rowid<=?', bind: [lo, lo + W] });
    });
    done = Math.min(99, Math.round(100 * (lo + W) / hi));
    progress = { phase: 'indexing', done, total: 100, pctOnly: true, step: 'Building search index…' };
    await breathe(t0);
  }
  db.exec('DROP TABLE fts_pending');
  db.exec('DROP TRIGGER IF EXISTS entries_ai');
  createFtsObjects();                                 // the normal per-row trigger again
  setFtsFlag(true);
  progress = { phase: 'ready', done: 0, total: 0 };
  return hi;
}

// ── Indexes ──────────────────────────────────────────────────────────────────
// Normally always present. During a BIG import they are dropped (inserting millions of rows
// into two extra B-trees in random order is what makes imports slow) and rebuilt once at the end
// — a sorted bulk build is many times faster. The rebuild also removes the duplicates that the
// UNIQUE index would otherwise have rejected one by one.
let bulkActive = false, bulkLast = 0, bulkTimer = null, ftsWasOk = false;
const hasIndex = (n) => db.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", [n]) > 0;
function finalizeIndexes(skipDedupe) {
  let removed = 0;
  const dedupe = () => {
    db.exec(`DELETE FROM entries WHERE (visit_time, seq) IN (
               SELECT visit_time, seq FROM (SELECT visit_time, seq, row_number() OVER (PARTITION BY uh, bucket ORDER BY visit_time, seq) AS rn FROM entries) WHERE rn > 1)`);
    removed += db.changes();
  };
  if (!hasIndex('entries_dedupe')) {
    if (!skipDedupe) dedupe();
    try { db.exec('CREATE UNIQUE INDEX entries_dedupe ON entries(uh, bucket)'); }
    catch (e) {                                       // duplicates were left after all: remove them, then retry
      if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
      db.exec('DROP INDEX IF EXISTS entries_dedupe'); dedupe();
      db.exec('CREATE UNIQUE INDEX entries_dedupe ON entries(uh, bucket)');
    }
  }
  if (!hasIndex('entries_dom')) db.exec('CREATE INDEX entries_dom ON entries(dh, bucket)');
  return removed;
}
// Big imports land in an append-only staging table first (dense, no index work), then are copied into
// `entries` in time order — a sorted insert fills every page, so the file ends up ~40% smaller than
// random-order inserts would make it (and day/range reads become sequential).
function hasStage() { return db.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='stage'") > 0; }
async function mergeStage() {
  if (!hasStage()) return 0;
  // 1. duplicates inside the staged rows themselves (keep the first)
  db.exec('DELETE FROM stage WHERE rowid IN (SELECT rowid FROM (SELECT rowid, row_number() OVER (PARTITION BY uh, bucket ORDER BY rowid) AS rn FROM stage) WHERE rn > 1)');
  let removed = db.changes();
  const hadRows = db.selectValue('SELECT EXISTS(SELECT 1 FROM entries)') === 1;
  // 2. rows that are already stored (uses the existing UNIQUE index)
  if (hadRows && hasIndex('entries_dedupe')) {
    db.exec('DELETE FROM stage WHERE EXISTS (SELECT 1 FROM entries e WHERE e.uh = stage.uh AND e.bucket = stage.bucket)');
    removed += db.changes();
  }
  // 3. copy in time order. Into an empty table the indexes are built afterwards (much faster).
  if (!hadRows) { db.exec('DROP INDEX IF EXISTS entries_dedupe'); db.exec('DROP INDEX IF EXISTS entries_dom'); }
  // Copy in windows of ~100k rows, each its own small transaction, deleting the staged rows as they move:
  //  - memory stays flat (no single transaction holding millions of dirty pages),
  //  - the file does not grow by a whole second copy of the data (freed stage pages are reused by `entries`),
  //  - progress is real, and an interruption loses almost nothing (copied rows are already gone from `stage`).
  // The index on the sort key lets SQLite read rows in order instead of sorting whole rows (urls, titles…) in RAM.
  db.exec('CREATE INDEX IF NOT EXISTS stage_vt ON stage(visit_time, seq)');
  const lo0 = db.selectValue('SELECT MIN(visit_time) FROM stage'), hi0 = db.selectValue('SELECT MAX(visit_time) FROM stage');
  const span = Math.max(1, (hi0 || 0) - (lo0 || 0));
  for (;;) {
    const _t0 = performance.now();
    const lo = db.selectValue('SELECT MIN(visit_time) FROM stage');
    if (lo == null) break;
    let edge = db.selectValue('SELECT visit_time FROM stage INDEXED BY stage_vt WHERE visit_time >= ? ORDER BY visit_time LIMIT 1 OFFSET 30000', [lo]);
    let cond = 'visit_time >= ?', bind = [lo];
    if (edge != null && edge > lo) { cond += ' AND visit_time < ?'; bind = [lo, edge]; }
    else if (edge != null) { cond = 'visit_time = ?'; edge = null; }            // 100k+ rows with one identical time: take that time alone
    inTx(() => {
      db.exec({ sql: 'INSERT OR IGNORE INTO entries(visit_time,seq,url,raw_url,title,domain,uh,bucket,dh) SELECT visit_time,seq,url,raw_url,title,domain,uh,bucket,dh FROM stage INDEXED BY stage_vt WHERE ' + cond + ' ORDER BY visit_time, seq', bind });
      db.exec({ sql: 'DELETE FROM stage WHERE ' + cond, bind });
    });
    const next = db.selectValue('SELECT MIN(visit_time) FROM stage');
    progress = { phase: 'indexing', done: next == null ? 100 : Math.min(99, Math.round(100 * (next - lo0) / span)), total: 100, pctOnly: true, step: 'Merging imported history…' };
    if (next == null) break;
    await breathe(_t0);
  }
  db.exec('DROP TABLE stage');
  return removed;
}
async function bulkEnd() {
  clearInterval(bulkTimer); bulkTimer = null; _cnt = null;
  let removed = 0;
  if (hasTable('fts_pending')) await ftsDeferEnd();
  if (bulkActive || hasStage() || !hasIndex('entries_dedupe') || !hasIndex('entries_dom')) {
    progress = { phase: 'indexing', done: 0, total: 0 };
    await tick();
    const hadStage = hasStage();
    // The search index is only completed for the NEW rows (recorded while merging) instead of being rebuilt from scratch for the
    // whole history. That needs the index to have been complete when the import began; otherwise it is rebuilt as before.
    const incFts = hadStage && ftsWasOk && hasTable('entries_fts');
    if (incFts) ftsDeferBegin();
    removed += await mergeStage();
    progress = { phase: 'indexing', done: 0, total: 0, step: 'Building search index…' };
    await tick();
    removed += finalizeIndexes(hadStage);       // staged rows were already de-duplicated by mergeStage()
    if (incFts) await ftsDeferEnd(); else await rebuildFts();
    ftsWasOk = false;
    db.exec('PRAGMA cache_size=-32768');
    progress = { phase: 'ready', done: 0, total: 0 };
    await shrink();                              // the staging table's pages go back to the disk
  }
  bulkActive = false;
  return { removed };
}

function openFresh() {
  db = new pool.OpfsSAHPoolDb(FILE_V2);
  db.exec('PRAGMA auto_vacuum=INCREMENTAL');   // only takes effect on a brand-new file: lets deletes give disk space back
  db.exec('PRAGMA cache_size=-32768');         // 32 MB page cache
  db.exec('PRAGMA synchronous=OFF');
  db.exec('PRAGMA temp_store=MEMORY');
  createSchema(db);
  // An interrupted import is NOT completed here any more: that is minutes of heavy work and used to run at every
  // browser start. It is resumed in the background after a delay (resumeInterruptedImport), with a retry limit.
  try { pendingFinish = hasStage() || hasTable('fts_pending') || !hasIndex('entries_dedupe') || !hasIndex('entries_dom'); }
  catch (e) { if (isCorrupt(e && e.message)) needsRepair = true; else throw e; }   // damaged file: repaired right after opening
}
let pendingFinish = false;
function metaGet(k) { try { return db.selectValue('SELECT v FROM eh_meta WHERE k=?', [k]); } catch (_) { return null; } }
function metaSet(k, v) { try { db.exec('CREATE TABLE IF NOT EXISTS eh_meta(k TEXT PRIMARY KEY, v)'); db.exec({ sql: 'INSERT OR REPLACE INTO eh_meta(k, v) VALUES(?, ?)', bind: [k, v] }); } catch (_) {} }
// Finishes an import that never completed (browser closed / crashed in the middle). Delayed so it never competes with
// browser start-up; every attempt is counted BEFORE it starts, so a job that crashes the browser cannot loop forever.
function resumeInterruptedImport() {
  setTimeout(() => {
    runExclusive(async () => {
      const tries = (Number(metaGet('finish_tries')) || 0) + 1;
      metaSet('finish_tries', tries);
      if (tries > 3) {                                  // keeps failing: give up on the unmerged rows instead of crashing again
        console.warn('[EH-db] interrupted import could not be completed 3 times — discarding the unmerged rows');
        try { db.exec('DROP TABLE IF EXISTS stage'); db.exec('DROP TABLE IF EXISTS fts_pending'); db.exec('DROP TRIGGER IF EXISTS entries_ai'); } catch (_) {}
        metaSet('finish_tries', 0);
        pendingFinish = false;
        await ensureFts();
        return;
      }
      await Ops.bulkEnd();
      metaSet('finish_tries', 0);
      pendingFinish = false;
      Ops.flush();
      postMessage({ recycle: true });                   // let the page restart this worker: WebAssembly memory never shrinks by itself
    }).catch((e) => {
      console.error('[EH-db] resuming the import failed', e);
      if (isCorrupt(e && e.message)) handleCorrupt().catch(() => {});   // otherwise the progress stays on "Building search index…" forever
    });
  }, 20000);
}
let needsRepair = false;

async function openDb() {
  if (loadError) throw new Error(loadError);
  if (typeof self.sqlite3InitModule !== 'function') throw new Error('sqlite3.js loaded but sqlite3InitModule is missing — the file is damaged or the wrong version.');
  try { sqlite3 = await self.sqlite3InitModule(); }
  catch (e) { throw new Error('Could not start SQLite (is js/database/sqlite/sqlite3.wasm present? ' + (e && e.message || e) + ')'); }
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'eh-sahpool', directory: '.eh-sqlite', initialCapacity: 12 });
  openFresh();
  if (pool.getFileNames().includes(FILE_V1)) await upgradeFromV1();
  if (needsRepair) { needsRepair = false; await repairDb(); }
  if (pendingFinish) { progress = { phase: 'ready', done: 0, total: 0 }; resumeInterruptedImport(); return; }   // full-text index is rebuilt by that job
  try { await ensureFts(); }
  catch (e) {
    // "database disk image is malformed" while building the search index used to reject openDb() (→ fatal, retried
    // forever, stuck on "Building search index…"). Repair automatically, or — for a BIG file — ask the user first.
    if (!isCorrupt(e && e.message)) throw e;
    await handleCorrupt();
    return;
  }
  progress = { phase: 'ready', done: 0, total: 0 };
}
// Damaged database: small → repair right away; big → flag it so the page offers "Try to repair" / "Export" / "Start empty".
async function handleCorrupt() {
  let big = false;
  try { big = db.selectValue('PRAGMA page_count') * db.selectValue('PRAGMA page_size') > 250 * 1048576; } catch (_) {}
  if (!big) await startRepair();
  else if (progress.phase !== 'repair') progress = { phase: 'corrupt', done: 0, total: 0 };
}

// Copies an earlier-format database into the v2 file (in slices, so the worker stays responsive
// to status requests), then deletes the old file — which also gives its disk space back.
async function upgradeFromV1() {
  progress = { phase: 'upgrade', done: 0, total: 0 };
  Ops.bulkBegin();                                  // rows go straight into `entries` (already in time order) without indexes; rebuilt once at the end
  db.exec('DROP INDEX IF EXISTS entries_dedupe'); db.exec('DROP INDEX IF EXISTS entries_dom');
  dropFtsObjects();
  db.exec(`ATTACH DATABASE '${FILE_V1}' AS old`);
  try {
    const has = db.selectValue("SELECT COUNT(*) FROM old.sqlite_master WHERE type='table' AND name='entries'");
    if (has) {
      progress.total = db.selectValue('SELECT COUNT(*) FROM old.entries');
      let last = [-1e300, ''];
      for (;;) {
        const rows = db.selectArrays('SELECT visit_time, id, url, raw_url, title, domain FROM old.entries WHERE (visit_time, id) > (?, ?) ORDER BY visit_time, id LIMIT 30000', last);
        if (!rows.length) break;
        inTx(() => {
          const st = db.prepare('INSERT OR IGNORE INTO entries(visit_time,seq,url,raw_url,title,domain,uh,bucket,dh) VALUES(?,?,?,?,?,?,?,?,?)');
          try {
            for (const r of rows) {
              const vt = r[0], url = r[2], dom = r[5] || '';
              st.bind([vt, newSeq(), url, r[3], r[4] || '', dom, hash53(url), Math.floor(vt / 5000), hash53(dom)]).stepReset();
            }
          } finally { st.finalize(); }
        });
        last = [rows[rows.length - 1][0], rows[rows.length - 1][1]];
        progress.done += rows.length; bulkLast = Date.now();
        await tick();
      }
    }
  } finally { try { db.exec('DETACH DATABASE old'); } catch (_) {} }
  progress = { phase: 'upgrade', done: progress.total, total: progress.total, indexing: true };
  await bulkEnd();
  for (const n of pool.getFileNames()) if (n === FILE_V1 || n.startsWith(FILE_V1 + '-')) pool.unlink(n);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// oo1 throws if handed an empty bind array for a statement with no parameters
const bnd = (b) => (b && b.length ? b : undefined);

function rowOut(r, keepSeq) {
  r.id = r.visitTime + '_' + r.seq;
  if (!keepSeq) delete r.seq;
  if (r.rawUrl == null) delete r.rawUrl;
  if (r.title == null) r.title = '';
  if (r.domain == null) r.domain = '';
  return r;
}
function parseId(id) {
  const m = /^(.+)_(\d+)$/.exec(String(id));
  if (!m) return null;
  const vt = Number(m[1]);
  return isFinite(vt) ? [vt, Number(m[2])] : null;
}
function rangeWhere(a) {
  const c = [], b = [];
  if (a.lo != null) { c.push(a.loOpen ? 'visit_time > ?' : 'visit_time >= ?'); b.push(a.lo); }
  if (a.hi != null) { c.push(a.hiOpen ? 'visit_time < ?' : 'visit_time <= ?'); b.push(a.hi); }
  return { c, b };
}
function wordWhere(a) {
  const c = [], b = [];
  // ASCII words use LIKE (case-insensitive for ASCII, no per-row string copy → several times faster than
  // lower()+instr()). Words with non-ASCII letters use the Unicode-aware jslower(), like JS toLowerCase().
  const L = (w) => '%' + w.replace(/[\\%_]/g, '\\$&') + '%';
  for (const w of (a.words || [])) {
    if (/^[\x00-\x7f]*$/.test(w)) {
      if (a.mode === 'title')       { c.push("title LIKE ? ESCAPE '\\'"); b.push(L(w)); }
      else if (a.mode === 'url')    { c.push("url LIKE ? ESCAPE '\\'"); b.push(L(w)); }
      else if (a.mode === 'domain') { c.push("domain LIKE ? ESCAPE '\\'"); b.push(L(w)); }
      else { c.push("(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')"); b.push(L(w), L(w)); }
    } else {
      if (a.mode === 'title')       { c.push("instr(jslower(ifnull(title,'')), ?) > 0"); b.push(w); }
      else if (a.mode === 'url')    { c.push('instr(jslower(url), ?) > 0'); b.push(w); }
      else if (a.mode === 'domain') { c.push("instr(jslower(ifnull(domain,'')), ?) > 0"); b.push(w); }
      else { c.push("(instr(jslower(url), ?) > 0 OR instr(jslower(ifnull(title,'')), ?) > 0)"); b.push(w, w); }
    }
  }
  const q = qfWhere(a.qf);
  c.push(...q.c); b.push(...q.b);
  return { c, b };
}

// Quick-filter patterns → SQL (same rules as the JS matcher in background.js / quick-filters.js):
// a pattern with a dot and no space/slash is a domain (matches the domain, its subdomains, or the URL);
// anything else is a keyword / URL fragment matched against URL or title. Patterns are OR-ed.
function qfWhere(patterns, pre = '') {
  const c = [], b = [];
  const L = (w) => '%' + w.replace(/[\\%_]/g, '\\$&') + '%';
  const E = " ESCAPE '\\'";
  const col = (n) => pre + n;
  const ors = [];
  for (const raw of (patterns || [])) {
    const p = lc(raw).trim();
    if (!p) continue;
    const ascii = /^[\x00-\x7f]*$/.test(p);
    const has = (n, v) => ascii ? { s: `${col(n)} LIKE ?${E}`, b: [L(v)] } : { s: `instr(jslower(ifnull(${col(n)},'')), ?) > 0`, b: [v] };
    if (p.includes('.') && !p.includes(' ') && !p.includes('/') && !p.includes('*')) {
      const esc = p.replace(/[\\%_]/g, '\\$&');
      ors.push(ascii ? `(${col('domain')} = ? OR ${col('domain')} LIKE ?${E})` : `(jslower(ifnull(${col('domain')},'')) = ? OR jslower(ifnull(${col('domain')},'')) LIKE ?${E})`);
      b.push(p, '%.' + esc);
    } else {
      // Keyword: whole word unless "*" opens a side ("ana*" starts with, "*ana" ends with, "*ana*" contains).
      // LIKE is only a cheap pre-filter; qfkw() does the exact word-boundary test.
      const lead = p.startsWith('*'), trail = p.endsWith('*');
      const core = p.replace(/^\*+|\*+$/g, '');
      if (!core) continue;
      const flags = (lead ? 1 : 0) | (trail ? 2 : 0);
      const part = (n) => {
        const pre = /^[\x00-\x7f]*$/.test(core) ? `${col(n)} LIKE ?${E} AND ` : '';
        const pb = pre ? [L(core)] : [];
        if (flags === 3) {                                  // *ana* → plain substring, as before
          return /^[\x00-\x7f]*$/.test(core) ? { s: `${col(n)} LIKE ?${E}`, b: [L(core)] } : { s: `instr(jslower(ifnull(${col(n)},'')), ?) > 0`, b: [core] };
        }
        return { s: `(${pre}qfkw(${col(n)}, ?, ?))`, b: [...pb, core, flags] };
      };
      const u = part('url'), t = part('title');
      ors.push(`(${u.s} OR ${t.s})`); b.push(...u.b, ...t.b);
    }
  }
  if (ors.length) c.push('(' + ors.join(' OR ') + ')');
  return { c, b };
}
const whereOf = (c) => (c.length ? ' WHERE ' + c.join(' AND ') : '');

function ftsQuery(words, mode) {
  const terms = [];
  for (const w of (words || [])) {
    const parts = String(w || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    for (const p of parts) terms.push(p.replace(/"/g, ''));
  }
  if (!terms.length) return '';
  const body = terms.map(t => t + '*').join(' ');
  if (mode === 'title') return 'title:(' + body + ')';
  if (mode === 'url') return 'url:(' + body + ')';
  if (mode === 'domain') return 'domain:(' + body + ')';
  return body;
}

function inTx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
const INS_SQL = ' INTO entries(visit_time,seq,url,raw_url,title,domain,uh,bucket,dh) VALUES(?,?,?,?,?,?,?,?,?)';
function insertRows(entries, verb) {
  let n = 0;
  const stmt = db.prepare(verb + INS_SQL);
  try {
    inTx(() => {
      for (const e of entries) {
        if (!e || !e.url) continue;
        const vt = Number(e.visitTime);
        if (!isFinite(vt)) continue;
        const dom = e.domain || '';
        stmt.bind([vt, newSeq(), e.url, (e.rawUrl && e.rawUrl !== e.url) ? e.rawUrl : null, e.title || '', dom,
                   hash53(e.url), Math.floor(vt / 5000), hash53(dom)]).stepReset();
        n += db.changes();
      }
    });
  } finally { stmt.finalize(); }
  return n;
}

// Same normalisation the extension has always applied to stored URLs (hash removed, trailing "/" dropped).
function isTrackable(url) {
  return !['chrome://', 'chrome-extension://', 'resource:', 'view-source:', 'about:', 'data:', 'javascript:', 'moz-extension://', 'edge://', 'brave://'].some(p => url.startsWith(p));
}
// One import batch, done entirely here: validate → normalise → insert (the DB drops duplicates).
// The rows are handed to SQLite as ONE JSON text and unpacked by json_each() in C — binding 9 values
// per row from JS is the slow part of WASM SQLite (each bind is a call across the JS/WASM boundary).
const bulkSql = (t) => `INSERT OR IGNORE INTO ${t}(visit_time,seq,url,raw_url,title,domain,uh,bucket,dh)
  SELECT value->>0, value->>1, value->>2, value->>3, value->>4, value->>5, value->>6, value->>7, value->>8 FROM json_each(?)`;
function importBatch({ entries, cutoff }) {
  const st = { imported: 0, dup: 0, old: 0, invalid: 0, oldestOld: 0 };
  const rows = [];
  for (const e of entries) {
    if (!e || !e.url || !isTrackable(e.url)) { st.invalid++; continue; }
    let vt = Number(e.visitTime);
    if (!vt) vt = Date.now();
    if (vt < cutoff) { st.old++; if (!st.oldestOld || vt < st.oldestOld) st.oldestOld = vt; continue; }
    const raw = e.rawUrl || e.url;
    let norm = raw, dom = '';
    try { const u = new URL(raw); dom = u.hostname.replace(/^www\./, ''); u.hash = ''; norm = u.toString().replace(/\/$/, ''); } catch (_) {}
    rows.push([vt, newSeq(), norm, raw !== norm ? raw : null, e.title || '', dom, hash53(norm), Math.floor(vt / 5000), hash53(dom)]);
  }
  if (bulkActive) bulkLast = Date.now();
  if (rows.length) {
    let added = 0;
    inTx(() => { db.exec({ sql: bulkSql(bulkActive ? 'stage' : 'entries'), bind: [JSON.stringify(rows)] }); added = db.changes(); });   // read before COMMIT: the full-text triggers' own statements can disturb changes() afterwards
    st.imported = added; st.dup = rows.length - added;
  }
  return st;
}

// ── Repair ───────────────────────────────────────────────────────────────────
// "database disk image is malformed" (SQLITE_CORRUPT*, e.g. 11 / 779) after an interrupted write.
// 1) drop + rebuild the indexes from the table (fixes a damaged index — the usual case);
// 2) if the table itself is damaged, copy every readable row into a new file and swap it in.
const isCorrupt = (m) => /SQLITE_CORRUPT|malformed|result code (11|267|779|522|10)\b/i.test(String(m));
let gate = null;
function startRepair() {
  if (!gate) gate = repairDb().catch((e) => { progress = { phase: 'ready', done: 0, total: 0 }; console.error('repair failed', e); }).finally(() => { gate = null; });
  return gate;
}
async function repairDb() {
  progress = { phase: 'repair', done: 0, total: 100, pctOnly: true, step: 'Repairing the history database…' };
  await tick();
  try { db.exec('DROP TABLE IF EXISTS stage'); } catch (_) {}
  // Always rebuild by copying (never one giant CREATE INDEX / full-table statement: those cannot be interrupted, cannot report
  // progress and keep the worker busy for minutes). Everything below runs in small time windows with a pause after each.
  await copyRepair();
  progress = { phase: 'ready', done: 0, total: 0 };
  bulkActive = false;
}
async function copyRepair() {
  const R = '/eh_repair.sqlite3';
  for (const n of pool.getFileNames()) if (n === R || n.startsWith(R + '-')) pool.unlink(n);
  const rdb = new pool.OpfsSAHPoolDb(R);
  rdb.exec('PRAGMA auto_vacuum=INCREMENTAL'); rdb.exec('PRAGMA synchronous=OFF'); rdb.exec('PRAGMA cache_size=-8192');
  createSchema(rdb);
  const cols = 'visit_time,seq,url,raw_url,title,domain,uh,bucket,dh';
  let lo0 = Date.UTC(2000, 0, 1), hi0 = Date.now() + 86400000;
  try {
    const mn = db.selectValue('SELECT MIN(visit_time) FROM entries'), mx = db.selectValue('SELECT MAX(visit_time) FROM entries');
    if (mn != null && mx != null) { lo0 = mn; hi0 = mx; }
  } catch (_) {}
  const total = Math.max(1, hi0 - lo0);
  const STEP = 7 * 86400000;
  // 1. rescue every readable row into a plain, index-free file (first half of the progress bar)
  let found = 0;
  // A damaged page makes every query touching it fail. Narrowing down to find the readable parts must stay cheap:
  // slivers under 30 min are given up, and after a fixed number of failed reads the rest of a failing window is skipped.
  let failed = 0;
  const MAX_FAILED = 400;
  async function span(lo, hi) {
    const t0 = performance.now();
    let rows;
    try { rows = db.selectArrays(`SELECT ${cols} FROM entries WHERE visit_time>=? AND visit_time<?`, [lo, hi]); }
    catch (e) {
      failed++;
      await sleep(5);                                    // never a tight loop of failing queries
      if (hi - lo <= 30 * 60000 || failed > MAX_FAILED) return;   // unreadable sliver: skip it
      const mid = Math.floor((lo + hi) / 2); await span(lo, mid); await span(mid, hi); return;
    }
    if (rows.length) {
      rdb.exec('BEGIN'); rdb.exec({ sql: bulkSql('entries'), bind: [JSON.stringify(rows)] }); rdb.exec('COMMIT');
      found += rows.length;
    }
    await breathe(t0);
  }
  for (let lo = Math.floor(lo0); lo <= hi0; lo += STEP) {
    failed = Math.max(0, failed - 300);
    await span(lo, Math.min(lo + STEP, hi0 + 1));
    progress = { phase: 'repair', done: Math.min(49, Math.round(50 * (lo - lo0) / total)), total: 100, pctOnly: true, step: 'Rescuing readable history…' };
  }
  rdb.close();
  // 2. fresh database file with indexes + search index in place, filled window by window in time order
  try { db.close(); } catch (_) {}
  for (const n of pool.getFileNames()) if (n === FILE_V2 || n.startsWith(FILE_V2 + '-')) pool.unlink(n);
  openFresh();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS entries_dedupe ON entries(uh, bucket)');
  db.exec('CREATE INDEX IF NOT EXISTS entries_dom ON entries(dh, bucket)');
  createFtsObjects();
  pendingFinish = false;
  db.exec(`ATTACH DATABASE '${R}' AS rep`);
  try {
    for (let lo = Math.floor(lo0); lo <= hi0; lo += STEP) {
      const t0 = performance.now();
      db.exec('BEGIN');
      try { db.exec({ sql: `INSERT OR IGNORE INTO entries(${cols}) SELECT ${cols} FROM rep.entries WHERE visit_time>=? AND visit_time<? ORDER BY visit_time, seq`, bind: [lo, Math.min(lo + STEP, hi0 + 1)] }); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
      progress = { phase: 'repair', done: 50 + Math.min(49, Math.round(50 * (lo - lo0) / total)), total: 100, pctOnly: true, step: 'Rebuilding the database…' };
      await breathe(t0);
    }
  } finally { try { db.exec('DETACH DATABASE rep'); } catch (_) {} }
  setFtsFlag(true);
  for (const n of pool.getFileNames()) if (n === R || n.startsWith(R + '-')) pool.unlink(n);
  progress = { phase: 'repair', done: 99, total: 100, pctOnly: true, step: 'Freeing disk space…' };
  await shrink();
}

// Hands freed pages back to the disk (the file only shrinks through incremental vacuum).
async function shrink() {
  if (db.selectValue('PRAGMA freelist_count') < 256) return;
  // incremental_vacuum releases ONE page per step, so it has to be stepped to completion
  let prevFree = Infinity;
  for (let guard = 0; guard < 100000; guard++) {
    const _t0 = performance.now();
    const st = db.prepare('PRAGMA incremental_vacuum(2000)');
    try { while (st.step()) { /* each step frees a page */ } } finally { st.finalize(); }
    const free = db.selectValue('PRAGMA freelist_count');
    if (free === 0 || free >= prevFree) break;       // done, or the file cannot be shrunk this way (no progress)
    prevFree = free;
    await breathe(_t0);
  }
}

// ── Search: scans newest → oldest in windows, stops as soon as the page is full, and can be
//    cancelled by a newer keystroke (the worker yields between windows to read new messages).
const latestToken = new Map();     // client id → newest search token seen
async function searchPage(a) {
  const cid = a.cid, tok = a.token || 0;
  if (cid) latestToken.set(cid, Math.max(latestToken.get(cid) || 0, tok));
  const stale = () => cid && tok && latestToken.get(cid) > tok;
  // A burst of keystrokes queues several searches. Yield once so the NEWER ones are read (and register their
  // token) before this one starts — otherwise every superseded search still runs to the end, one after another,
  // and the list gets slower and slower while typing.
  if (cid && tok) { await tick(); if (stale()) return { cancelled: true, total: null, entries: [] }; }
  const limit = a.limit || 0;
  const offset = a.offset || 0;
  const fq = ftsQuery(a.words, a.mode);
  if (fq) {
    if (stale()) return { cancelled: true, total: null, entries: [] };
    const rw = rangeWhere(a);
    const qq = qfWhere(a.qf, 'e.');
    const c = ['entries_fts MATCH ?', ...rw.c.map(x => 'e.' + x), ...qq.c];
    const b = [fq, ...rw.b, ...qq.b];
    const rows = limit > 0
      ? db.selectObjects(`SELECT ${ECOLS}
          FROM entries_fts
          INNER JOIN entries e ON e.visit_time=entries_fts.visit_time AND e.seq=entries_fts.seq
          ${whereOf(c)}
          ORDER BY e.visit_time DESC, e.seq DESC
          LIMIT ? OFFSET ?`, [...b, limit + 1, offset]).map(r => rowOut(r))
      : [];
    const hasMore = rows.length > limit;
    if (hasMore) rows.length = limit;
    return { total: hasMore ? null : offset + rows.length, entries: rows };
  }
  const need = offset + limit;
  const ww = wordWhere(a);
  const W = 30000;
  // Windows are plain time ranges [edge, previousEdge) on the primary key's first column — the only
  // shape SQLite reliably turns into a narrow range scan (combining several range constraints makes it
  // rescan from the top for every window).
  const lowC = a.lo != null ? [a.loOpen ? 'visit_time > ?' : 'visit_time >= ?'] : [], lowB = a.lo != null ? [a.lo] : [];
  let upC = a.hi != null ? [a.hiOpen ? 'visit_time < ?' : 'visit_time <= ?'] : [], upB = a.hi != null ? [a.hi] : [];
  const out = [];
  let exhausted = false;
  while (out.length < need) {
    if (stale()) return { cancelled: true, total: null, entries: [] };
    const base = [...lowC, ...upC], baseB = [...lowB, ...upB];
    const edge = db.selectValue(`SELECT visit_time FROM entries${whereOf(base)} ORDER BY visit_time DESC LIMIT 1 OFFSET ?`, [...baseB, W - 1]);
    const c2 = [...base], b2 = [...baseB];
    if (edge != null) { c2.push('visit_time >= ?'); b2.push(edge); }
    c2.push(...ww.c); b2.push(...ww.b);
    for (const r of db.selectObjects(`SELECT ${COLS} FROM entries${whereOf(c2)} ORDER BY visit_time DESC, seq DESC`, bnd(b2))) out.push(rowOut(r));
    if (edge == null) { exhausted = true; break; }
    upC = ['visit_time < ?']; upB = [edge];
    await tick();
  }
  return { total: exhausted ? out.length : null, entries: out.slice(a.offset || 0, need) };
}

// ── Bulk deletes ─────────────────────────────────────────────────────────────
// Deleting a row fires a trigger that removes it from the full-text index with
// "DELETE FROM entries_fts WHERE visit_time=? AND seq=?" — those columns are not indexed, so EVERY
// deleted row scans the whole index (quadratic: a big delete never finishes). Large deletes therefore
// drop the triggers, delete in chunks (yielding, with progress), and rebuild the index once at the end.
const BULK_DELETE_MIN = 40;
function dropFtsTriggers() { db.exec('DROP TRIGGER IF EXISTS entries_ai; DROP TRIGGER IF EXISTS entries_ad; DROP TRIGGER IF EXISTS entries_au;'); }
function runExclusive(fn) {
  gate = (async () => { try { return await fn(); } finally { gate = null; } })();   // other requests wait for `gate`; status requests still answer
  return gate;
}
// where: SQL condition (without WHERE) on `entries`; ids: optional array of [visit_time, seq] pairs instead.
function deleteBulk({ where = '', binds = [], ids = null }) {
  const count = ids ? ids.length : db.selectValue('SELECT COUNT(*) FROM entries' + (where ? ' WHERE ' + where : ''), bnd(binds));
  if (!count) return 0;
  if (!ids) {
    const total = db.selectValue('SELECT COUNT(*) FROM entries');
    if (count === total) return Ops.clear().then(() => count);          // everything: drop the file — instant, frees the disk
  }
  if (count < BULK_DELETE_MIN) {
    let n = 0;
    if (ids) { const st = db.prepare('DELETE FROM entries WHERE visit_time=? AND seq=?'); try { inTx(() => { for (const p of ids) { st.bind(p).stepReset(); n += db.changes(); } }); } finally { st.finalize(); } }
    else { db.exec({ sql: 'DELETE FROM entries WHERE ' + where, bind: bnd(binds) }); n = db.changes(); }
    return n;
  }
  return runExclusive(async () => {
    const t0 = Date.now();
    let removed = 0;
    progress = { phase: 'deleting', done: 0, total: count };
    await tick();
    // 1. Collect the keys of the rows to delete in a temp table (also what the search index needs).
    db.exec('DROP TABLE IF EXISTS temp.del');
    db.exec('CREATE TEMP TABLE del(vt REAL, sq INTEGER)');
    if (ids) {
      const st = db.prepare('INSERT INTO temp.del(vt,sq) VALUES(?,?)');
      try { inTx(() => { for (const p of ids) st.bind(p).stepReset(); }); } finally { st.finalize(); }
    } else {
      db.exec({ sql: `INSERT INTO temp.del(vt,sq) SELECT visit_time, seq FROM entries WHERE ${where}`, bind: bnd(binds) });
    }
    db.exec('CREATE INDEX temp.del_i ON del(vt,sq)');
    const total = db.selectValue('SELECT COUNT(*) FROM temp.del');
    progress.total = total;
    setFtsFlag(false);
    dropFtsTriggers();
    let ok = false;
    try {
      // 2. Remove just those rows from the full-text index (one pass) — NOT a rebuild of the whole index.
      progress.phase = 'indexing';
      await tick();
      db.exec('DELETE FROM entries_fts WHERE EXISTS (SELECT 1 FROM temp.del d WHERE d.vt = entries_fts.visit_time AND d.sq = entries_fts.seq)');
      // 3. Delete the entries themselves in chunks (progress + the worker stays responsive).
      progress = { phase: 'deleting', done: 0, total };
      const STEP = 20000;
      for (let lo = 0; lo < total; lo += STEP) {
        db.exec({ sql: 'DELETE FROM entries WHERE (visit_time, seq) IN (SELECT vt, sq FROM temp.del WHERE rowid > ? AND rowid <= ?)', bind: [lo, lo + STEP] });
        removed += db.changes();
        progress.done = Math.min(total, lo + STEP);
        await tick();
      }
      ok = true;
    } finally {
      db.exec('DROP TABLE IF EXISTS temp.del');
      try { createFtsObjects(); } catch (e) { await rebuildFts(); }   // restores the triggers (the index table itself still exists)
      progress = { phase: 'ready', done: 0, total: 0 };
    }
    if (ok) setFtsFlag(true); else await rebuildFts();          // a failed delete leaves the index uncertain → rebuild
    if (removed > 5000) shrink().catch(() => {});        // give the disk space back in the background
    console.log('[EH-db] bulk delete', removed, 'rows in', Date.now() - t0, 'ms');
    return removed;
  });
}

// ── Operations ───────────────────────────────────────────────────────────────
const Ops = {
  ping()   { return 'pong'; },
  // Force everything written so far onto disk (the database runs with synchronous=OFF for speed,
  // so a normal commit is not guaranteed durable until the file is synced).
  flush() {
    db.exec('PRAGMA synchronous=FULL');
    try { db.exec('PRAGMA user_version=' + (((Number(db.selectValue('PRAGMA user_version')) | 0) + 1) % 1000000)); }   // a tiny committed write → the file is synced
    finally { db.exec('PRAGMA synchronous=OFF'); }
    return true;
  },
  // Reads whatever is readable in [lo, hi) from a DAMAGED database (used by "export before deleting"). Failing ranges are narrowed
  // down to find the readable parts, with a hard limit so a broken region cannot keep the worker busy.
  rescueChunk({ lo, hi }) {
    const out = []; let fails = 0;
    const rd = (a, b) => {
      try { for (const r of db.selectObjects(`SELECT ${COLS} FROM entries WHERE visit_time>=? AND visit_time<?`, [a, b])) out.push(r); }
      catch (e) {
        fails++;
        if (b - a <= 30 * 60000 || fails > 400) return;
        const m = Math.floor((a + b) / 2); rd(a, m); rd(m, b);
      }
    };
    rd(lo, hi);
    return { rows: out, failed: fails };
  },
  repair() { return startRepair().then(() => true); },
  bulkBegin() {
    if (!bulkActive) {
      ftsWasOk = hasTable('entries_fts') && ftsFlag();
      setFtsFlag(false);
      db.exec('CREATE TABLE IF NOT EXISTS stage(visit_time REAL, seq INTEGER, url TEXT, raw_url TEXT, title TEXT, domain TEXT, uh INTEGER, bucket INTEGER, dh INTEGER)');
      db.exec('PRAGMA cache_size=-98304');
      bulkActive = true;
    }
    bulkLast = Date.now();
    clearInterval(bulkTimer);
    bulkTimer = setInterval(() => { if (bulkActive && Date.now() - bulkLast > 90000) bulkEnd().catch(() => {}); }, 30000);   // abandoned import: rebuild the indexes anyway
    return true;
  },
  bulkEnd,
  ftsDeferBegin,
  setCache({ mb }) { db.exec('PRAGMA cache_size=-' + Math.max(8, Math.min(512, mb | 0)) * 1024); return true; },   // bigger page cache while importing
  status() { return progress; },
  info()   { return { autoVacuum: db.selectValue('PRAGMA auto_vacuum'), pages: db.selectValue('PRAGMA page_count'), free: db.selectValue('PRAGMA freelist_count'), pageSize: db.selectValue('PRAGMA page_size'), journal: db.selectValue('PRAGMA journal_mode') }; },
  // COUNT(*) walks the whole table/index (seconds on a 1 GB history) — remembered until something writes
  count()  { if (_cnt === null) _cnt = db.selectValue('SELECT COUNT(*) FROM entries'); return _cnt; },
  hasRows() { return db.selectValue('SELECT EXISTS(SELECT 1 FROM entries)') === 1; },   // instant, unlike COUNT(*) on a huge table
  size()   { const ps = db.selectValue('PRAGMA page_size'); return (db.selectValue('PRAGMA page_count') - db.selectValue('PRAGMA freelist_count')) * ps; },

  // Delete everything AND give the disk space back: drop the database file and start a new one.
  async clear() {
    try { db.close(); } catch (_) {}
    db = null;
    for (const n of pool.getFileNames()) if (n === FILE_V2 || n.startsWith(FILE_V2 + '-')) pool.unlink(n);
    openFresh();
    await ensureFts();
    return true;
  },

  putMany({ entries })      { return insertRows(entries, 'INSERT OR REPLACE'); },
  insertIgnore({ entries }) { return insertRows(entries, 'INSERT OR IGNORE'); },
  importBatch,

  // Keyset-paged read of the whole table (oldest first), optionally filtered — for exports/scans.
  // `after` = [visit_time, seq] of the last row of the previous slice.
  getSlice(a) {
    const rw = rangeWhere(a), ww = wordWhere(a);
    const c = [...rw.c, ...ww.c], b = [...rw.b, ...ww.b];
    if (a.after) { c.push('(visit_time, seq) > (?, ?)'); b.push(a.after[0], a.after[1]); }
    return db.selectObjects(`SELECT ${COLS} FROM entries${whereOf(c)} ORDER BY visit_time, seq LIMIT ?`, [...b, a.limit || 20000]).map(r => rowOut(r, true));
  },
  // One page of results (newest first by default) + the total matching count.
  page(a) {
    if ((a.words && a.words.length) || (a.qf && a.qf.length)) return searchPage(a);
    const rw = rangeWhere(a), w = whereOf(rw.c);
    const total = a.needTotal === false ? null : db.selectValue('SELECT COUNT(*) FROM entries' + w, bnd(rw.b));
    const dir = a.asc ? 'ASC' : 'DESC';
    const rows = (a.limit > 0)
      ? db.selectObjects(`SELECT ${COLS} FROM entries${w} ORDER BY visit_time ${dir}, seq ${dir} LIMIT ? OFFSET ?`, [...rw.b, a.limit, a.offset || 0]).map(r => rowOut(r))
      : [];
    return { total, entries: rows };
  },
  countRange(a) { const rw = rangeWhere(a); return db.selectValue('SELECT COUNT(*) FROM entries' + whereOf(rw.c), bnd(rw.b)); },
  countRanges({ ranges }) {
    return ranges.map(([lo, hi, hiOpen]) => { const rw = rangeWhere({ lo, hi, hiOpen }); return db.selectValue('SELECT COUNT(*) FROM entries' + whereOf(rw.c), bnd(rw.b)); });
  },
  newestVisitTime(a) { return db.selectValue('SELECT MAX(visit_time) FROM entries' + (a && a.maxT ? ' WHERE visit_time <= ?' : ''), a && a.maxT ? [a.maxT] : undefined); },
  oldestVisitTime() { return db.selectValue('SELECT MIN(visit_time) FROM entries'); },
  // Visits per 15-minute bucket since the epoch (optionally only before `hi`): [[bucket, count], ...] — a few thousand small
  // rows instead of millions of entries. The caller maps buckets to local hours (time zone / DST aware).
  hourBuckets({ hi }) {
    return db.selectArrays('SELECT CAST(visit_time / 900000 AS INTEGER) AS b, COUNT(*) FROM entries' + (hi != null ? ' WHERE visit_time < ?' : '') + ' GROUP BY b', bnd(hi != null ? [hi] : []));
  },
  visitTimeAtRank({ n }) { return db.selectValue('SELECT visit_time FROM entries ORDER BY visit_time LIMIT 1 OFFSET ?', [Math.max(0, n)]); },

  async removeIds({ ids }) {
    const pairs = [];
    for (const id of ids) { const p = parseId(id); if (p) pairs.push(p); }
    return deleteBulk({ ids: pairs });
  },
  async deleteBelow({ t })      { return deleteBulk({ where: 'visit_time < ?', binds: [t] }); },
  async deleteRange({ lo, hi }) { return deleteBulk({ where: 'visit_time >= ? AND visit_time <= ?', binds: [lo, hi] }); },
  async deleteWhere(a) {
    const rw = rangeWhere(a), ww = wordWhere(a);
    const c = [...rw.c, ...ww.c], b = [...rw.b, ...ww.b];
    return deleteBulk({ where: c.join(' AND '), binds: b });
  },
  shrink,

  // Rows whose id is in `ids` OR whose (normalized) url is in `urls`.
  findByIdsOrUrls({ ids = [], urls = [] }) {
    const found = new Map();
    let st = db.prepare(`SELECT ${COLS} FROM entries WHERE visit_time=? AND seq=?`);
    try { for (const id of ids) { const p = parseId(id); if (!p) continue; st.bind(p); while (st.step()) { const r = rowOut(st.get({})); found.set(r.id, r); } st.reset(); } }
    finally { st.finalize(); }
    st = db.prepare(`SELECT ${COLS} FROM entries WHERE uh=? AND url=?`);
    try { for (const u of urls) { st.bind([hash53(u), u]); while (st.step()) { const r = rowOut(st.get({})); found.set(r.id, r); } st.reset(); } }
    finally { st.finalize(); }
    return [...found.values()];
  },

  // Most-visited urls / domains — grouped on the small hash indexes only (no URL text is read
  // for the millions of rows, just for the 50 winners).
  topBy({ column, since = 0, limit = 50 }) {
    const b0 = Math.floor(since / 5000);
    if (column === 'domain') {
      const rows = db.selectObjects('SELECT dh, COUNT(*) AS count FROM entries INDEXED BY entries_dom WHERE bucket >= ? AND dh <> ? GROUP BY dh ORDER BY count DESC LIMIT ?', [b0, hash53(''), limit]);
      return rows.map(r => {
        const d = db.selectValue('SELECT domain FROM entries INDEXED BY entries_dom WHERE dh=? LIMIT 1', [r.dh]) || '';
        return { identifier: d, count: r.count, title: d };
      });
    }
    const rows = db.selectObjects('SELECT uh, COUNT(*) AS count FROM entries INDEXED BY entries_dedupe WHERE bucket >= ? GROUP BY uh ORDER BY count DESC LIMIT ?', [b0, limit]);
    return rows.map(r => {
      const x = db.selectObject("SELECT url, title FROM entries INDEXED BY entries_dedupe WHERE uh=? ORDER BY (title <> '') DESC, visit_time DESC LIMIT 1", [r.uh]) || {};
      return { identifier: x.url || '', count: r.count, title: x.title || x.url || '' };
    });
  },

  // Sets the title of the newest visit of `url` since `sinceMs` (if onlyIfEmpty: only when it has none).
  updateTitle({ url, title, sinceMs, onlyIfEmpty }) {
    const r = db.selectObject('SELECT visit_time AS vt, seq, title FROM entries WHERE uh=? AND url=? AND visit_time>=? ORDER BY visit_time DESC LIMIT 1', [hash53(url), url, sinceMs]);
    if (!r) return false;
    if (onlyIfEmpty && r.title) return true;
    db.exec({ sql: 'UPDATE entries SET title=? WHERE visit_time=? AND seq=?', bind: [title, r.vt, r.seq] });
    return true;
  },
};

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data || {};
  try {
    if (!readyPromise) readyPromise = openDb();
    readyPromise.catch(() => {});
    if (op === 'status' && progress.phase !== 'ready') {      // answer even while the database is still starting / upgrading
      postMessage({ id, ok: true, result: progress }); return;
    }
    try { await readyPromise; }
    catch (e) { postMessage({ id, ok: false, fatal: true, error: 'SQLite init failed: ' + (e && e.message || e) }); return; }
    if (gate && op !== 'repair') {
      if (op === 'status') { postMessage({ id, ok: true, result: progress }); return; }
      await gate;
    }
    const fn = Ops[op];
    if (!fn) throw new Error('Unknown op: ' + op);
    if (!READ_ONLY_OPS.has(op)) _cnt = null;           // any write invalidates the cached count
    const result = await fn(args || {});
    if (!READ_ONLY_OPS.has(op)) _cnt = null;
    postMessage({ id, ok: true, result });
  } catch (e) {
    const m = String(e && e.message || e);
    if (op !== 'repair' && isCorrupt(m)) {               // damaged file: callers are told to wait
      // Small database: repair it automatically. A BIG one is not touched without the user's say-so (a repair of a
      // multi-hundred-MB file took gigabytes of memory and froze the browser): the page offers "Repair" or "Start empty".
      let big = false;
      try { big = db.selectValue('PRAGMA page_count') * db.selectValue('PRAGMA page_size') > 250 * 1048576; } catch (_) {}
      if (!big) startRepair();
      else if (progress.phase !== 'repair') progress = { phase: 'corrupt', done: 0, total: 0 };
      postMessage({ id, ok: false, error: 'The history database is being repaired (' + m + ')' });
      return;
    }
    postMessage({ id, ok: false, error: m });
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = { Ops, createSchema, hash53, _setDb(d) { db = d; } };