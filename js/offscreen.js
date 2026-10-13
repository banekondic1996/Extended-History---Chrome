'use strict';
/**
 * offscreen.js — hosts the SQLite worker (db-worker.js) and relays requests from the
 * extension's service worker. The service worker can't spawn Workers, so this hidden
 * document does it. It is the ONLY context that touches the database (the OPFS pool is
 * exclusive), so there are never conflicting writers.
 *
 * Request  (from background.js):  {target:'eh-sql', op, args}
 * Response (sendResponse):        {ok:true, result} | {ok:false, error}
 */
let worker = null, seq = 0;
const pending = new Map();
let restarts = 0;

function startWorker() {
  worker = new Worker('../js/database/db-worker.js?sqlite3.dir=sqlite&opfs-disable');
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m && m.recycle) { setTimeout(() => { if (pending.size === 0) resetWorker(); }, 1500); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.fatal) { resetWorker(); }              // init failed (e.g. storage still locked by a previous instance) — next call starts a fresh worker
    p.resolve(m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error });
  };
  worker.onerror = (e) => {
    const err = 'database worker error: ' + (e.message || e);
    for (const [, p] of pending) p.resolve({ ok: false, error: err });
    pending.clear();
    resetWorker();
  };
}
function resetWorker() { try { if (worker) worker.terminate(); } catch (_) {} worker = null; }

function call(op, args) {
  return new Promise(async (resolve) => {
    if (!worker) {
      // a previous instance (before an extension reload) may still be releasing its OPFS handles
      if (restarts > 0) await new Promise(r => setTimeout(r, Math.min(3000, 400 * restarts)));
      restarts++;
      startWorker();
    }
    const id = ++seq;
    pending.set(id, { resolve });
    worker.postMessage({ id, op, args });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'eh-sql') return;     // not for us — leave it to other listeners
  if (msg.op === 'recycle') {                      // WebAssembly memory never shrinks: after a heavy job a fresh worker gives it back
    if (pending.size === 0) resetWorker();
    sendResponse({ ok: true, result: true }); return;
  }
  call(msg.op, msg.args).then(r => { if (r.ok) restarts = 0; sendResponse(r); });
  return true;                                      // async response
});