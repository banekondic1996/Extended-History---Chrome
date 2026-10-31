/**
 * Extended History — history.js v3
 * Virtual scroll, click-to-open / checkbox-to-select, sessions, bookmarks,
 * dark/light mode, local fonts only.
 */
const WP_STORAGE_KEY = 'eh_wallpaper';
const WP_NEXT_KEY    = 'eh_wallpaper_next';

// ── Messaging ──────────────────────────────────────────────────────────────
function send(type, extra = {}) {
  return new Promise((res, rej) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rej(new Error(`Timed out waiting for a response to "${type}" — the extension's background page may need to be reloaded.`));
    }, 15000);
    chrome.runtime.sendMessage({ type, ...extra }, r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) { rej(new Error(chrome.runtime.lastError.message)); return; }
      if (r && r.migrating) ehShowMigration();
      if (r && r.error) { rej(new Error(r.error)); return; }
      res(r);
    });
  });
}

// While the history is being moved to SQLite (automatic for big histories) the background
// answers every data request with {migrating:true}. Cover the page with a progress overlay,
// poll until it is done, then reload.
let _ehMigOverlay = null;
function ehShowMigration() {
  if (_ehMigOverlay) return;
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(8,8,12,.88);color:#f0eee8;font-family:system-ui,sans-serif;text-align:center;padding:24px';
  o.innerHTML = '<div style="max-width:420px"><div style="font-size:18px;font-weight:600;margin-bottom:8px" id="ehMigTitle" data-i18n-key="moving_to_sqlite">Moving your history to SQLite…</div>' +
    '<div id="ehMigNote" style="opacity:.75;font-size:13px;line-height:1.5;margin-bottom:14px;display:none"></div>' +
    '<style>#ehMigBar{height:100%;width:3%;background:#3b9eff;transition:width .4s}#ehMigBar.indet{width:35%!important;animation:ehMigSlide 1.2s ease-in-out infinite;transition:none}@keyframes ehMigSlide{0%{margin-left:-35%}100%{margin-left:100%}}</style>' +
    '<div style="height:8px;border-radius:4px;background:rgba(255,255,255,.15);overflow:hidden"><div id="ehMigBar"></div></div>' +
    '<div id="ehMigTxt" style="margin-top:8px;font-size:12px;opacity:.7"></div></div>';
  document.body.appendChild(o);
  _ehMigOverlay = o;
  const t00 = Date.now();
  const tick = async () => {
    try {
      const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'GET_MIGRATION_STATUS' }, x => res(x || {})));
      if (!r.migrating) { location.reload(); return; }
      const bar = document.getElementById('ehMigBar'), txt = document.getElementById('ehMigTxt'), ttl = document.getElementById('ehMigTitle');
      const pct = r.total ? Math.min(99, Math.round(100 * r.done / r.total)) : 0;
      const hasTotal = !!r.total;
      const secs = Math.max(r.busySecs || 0, r.since ? Math.round((Date.now() - r.since) / 1000) : 0, Math.round((Date.now() - t00) / 1000));
      // No denominator yet (database starting, indexes building…): animated bar instead of a bar stuck at 3 %.
      bar.classList.toggle('indet', !r.total);
      if (r.total) bar.style.width = Math.max(3, pct) + '%'; else bar.style.width = '';
      const isCorrupt = r.upgrade && r.phase === 'corrupt';
      if (!isCorrupt) delete txt.dataset.corrupt;
      if (!isCorrupt) txt.textContent = r.total ? (r.pctOnly ? `${pct}% · ${secs} s` : `${pct}% · ${Number(r.done).toLocaleString()} / ${Number(r.total).toLocaleString()}`) : (secs ? secs + ' s' : '');
      const note = document.getElementById('ehMigNote');
      if (note) { note.style.display = r.upgrade ? 'none' : ''; if (!r.upgrade) note.textContent = tr('history_too_big','Your history is big, so it is being moved to a faster database. This happens once; the page reloads when it is done.'); }
      if (!r.upgrade) {
        const mig = { preparing: tr('preparing','Preparing…'), reading: tr('reading_history','Reading your history…'), starting: tr('starting_database','Starting the database…'), copying: tr('moving_to_sqlite','Moving your history to SQLite…'), verifying: tr('checking_copy','Checking the copy…'), finishing: tr('finishing_up','Finishing up…') };
        ttl.textContent = mig[r.phase] || tr('moving_to_sqlite','Moving your history to SQLite…');
      }
      if (r.upgrade && r.phase === 'corrupt') {
        ttl.textContent = tr('history_damaged','The history database is damaged');
        if (!txt.dataset.corrupt) { txt.dataset.corrupt = '1'; txt.textContent = tr('explain_damage','This can happen when the browser was closed or ran out of memory in the middle of a big write. Repair can take a few minutes. You can also export what is readable to a .json file first, delete the database and import that file again.'); }
        bar.style.display = 'none';
        if (!document.getElementById('ehMigFix')) {
          const box = document.createElement('div'); box.id = 'ehMigFix'; box.style.cssText = 'margin-top:16px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap';
          const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:inherit;cursor:pointer'; b.onclick = fn; box.appendChild(b); return b; };
          mk(tr('try_repair','Try to repair'), () => { box.remove(); bar.style.display = ''; chrome.runtime.sendMessage({ target: 'eh-sql', op: 'repair' }, () => { void chrome.runtime.lastError; }); });
          mk(tr('export_then_delete','Export what can be read (.json), then delete'), async (ev) => {
            const btn = ev.currentTarget; btn.disabled = true;
            try {
              const rs = (a) => new Promise((res, rej) => chrome.runtime.sendMessage({ target: 'eh-sql', op: 'rescueChunk', args: a }, x => { if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else if (!x || !x.ok) rej(new Error((x && x.error) || 'no answer')); else res(x.result); }));
              const lo0 = Date.UTC(2000, 0, 1), hi0 = Date.now() + 86400000, STEP = 14 * 86400000;
              let parts = ['{"exportedAt":"' + new Date().toISOString() + '","entries":['], n = 0, pending = 0, first = true;
              for (let lo = lo0; lo < hi0; lo += STEP) {
                const r = await rs({ lo, hi: Math.min(lo + STEP, hi0) });
                if (r.rows.length) {
                  const s = r.rows.map(e => JSON.stringify(e)).join(',');
                  parts.push((first ? '' : ',') + s); first = false; n += r.rows.length; pending += s.length;
                  if (pending > 16e6) { parts = [new Blob(parts)]; pending = 0; }   // let the browser keep it on disk, not in memory
                }
                txt.textContent = tr('exporting','Exporting...')+` ${Math.round(100 * (lo - lo0) / (hi0 - lo0))}% · ${n.toLocaleString()}`+ tr('entries','entries');
                await new Promise(r2 => setTimeout(r2, 0));
              }
              parts.push('],"totalEntries":' + n + '}');
              if (!n) { alert(tr('no_readable_entries','No readable entries were found.')); btn.disabled = false; return; }
              const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
              const a = Object.assign(document.createElement('a'), { href: url, download: 'extended-history_rescued_' + new Date().toISOString().slice(0, 10) + '.json' });
              document.body.appendChild(a); a.click();
              setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 600000);
              txt.textContent = tr('saved','Saved ')+`${n.toLocaleString()}`+ tr('entries','entries');
              await new Promise(r2 => setTimeout(r2, 1500));
              if (!confirm(`${n.toLocaleString()}`+ tr('entries_were_saved','entries were saved to your downloads. Check that the file was saved, then delete the damaged database now? You can import the file afterwards.'))) { btn.disabled = false; return; }
              const x = await new Promise(res => chrome.runtime.sendMessage({ type: 'RESET_SQLITE_HARD' }, y => res(y || {})));
              if (x.error) alert(x.error); else location.reload();
            } catch (e) { alert('Export failed: ' + (e.message || e)); btn.disabled = false; }
          });
          mk(tr('delete_start_empty','Delete it and start empty'), async () => {
            if (!confirm(tr('this_deletes_history','This permanently deletes the stored history database (your browser\'s own history is not touched). Continue?'))) return;
            const x = await new Promise(res => chrome.runtime.sendMessage({ type: 'RESET_SQLITE_HARD' }, y => res(y || {})));
            if (x.error) alert(x.error); else location.reload();
          });
          txt.parentNode.appendChild(box);
        }
        setTimeout(tick, 1500); return;
      }
      if (r.upgrade) {
        const names = { init: tr('starting_database','Starting the database…'), upgrade: tr('upgrading_database','Upgrading the history database…'), indexing: tr('building_indexes','Building indexes…'), repair: tr('repairing_database','Repairing the history database…') };
        ttl.textContent = names[r.phase] || tr('preparing_database','Preparing the history database…');
        if (r.pctOnly && r.step) ttl.textContent = r.step;
        if (!r.total) txt.textContent = secs + ' s';
        if (secs > (r.phase === 'indexing' ? 420 : 180) && !r.pctOnly && !document.getElementById('ehMigReset')) {
          const b = document.createElement('button');
          b.id = 'ehMigReset';
          b.textContent = tr('stuck_delete','Stuck? Delete the database and start empty');
          b.style.cssText = 'margin-top:16px;padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:inherit;cursor:pointer';
          b.onclick = async () => {
            if (!confirm(tr('confirm_history_drop','This permanently deletes the stored history database (your browser\'s own history is not touched). Continue?'))) return;
            b.disabled = true; b.textContent = tr('deleting','Deleting…');
            const x = await new Promise(res => chrome.runtime.sendMessage({ type: 'RESET_SQLITE_HARD' }, y => res(y || {})));
            if (x.error) { b.textContent = x.error; b.disabled = false; } else location.reload();
          };
          document.getElementById('ehMigTxt').parentNode.appendChild(b);
        }
      }
    } catch (_) {}
    setTimeout(tick, 500);
  };
  tick();
}
// Check once at page load, before anything asks for data.
try { chrome.runtime.sendMessage({ type: 'GET_MIGRATION_STATUS' }, r => { void chrome.runtime.lastError; if (r && r.migrating) ehShowMigration(); }); } catch (_) {}

// Same as send() but without the 15 s timeout — for operations that legitimately
// take long on a big history (building/pulling an export).
function sendLong(type, extra = {}) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type, ...extra }, r => {
      if (chrome.runtime.lastError) { rej(new Error(chrome.runtime.lastError.message)); return; }
      if (r && r.migrating && type !== 'MIGRATE_TO_SQLITE' && type !== 'MIGRATE_TO_IDB' && type !== 'MIGRATE_TO_LOCAL') ehShowMigration();
      if (r && r.error) { rej(new Error(r.error)); return; }
      res(r);
    });
  });
}
// Pulls an export that background.js prepared as chunks (see EXPORT_BEGIN / EXPORT_PULL there),
// handing each text part to onPart(str) as it arrives. Nothing is accumulated here.
async function ehPullEach(id, count, onPart) {
  if (count == null) {
    for (let i = 0; ; i++) {
      const r = await sendLong('EXPORT_PULL', { id, i });
      await onPart(r.part);
      if (r.last) break;
    }
    return;
  }
  for (let i = 0; i < count; i++) await onPart((await sendLong('EXPORT_PULL', { id, i })).part);
}
// Same, but collects the text into Blob batches: Blob storage lives outside the JS heap, so a 1 GB+ history
// never sits in memory as strings (that crashed the tab). Returns an array of Blobs — usable as `new Blob(result)`.
async function ehPullParts(id, count, onProgress) {
  const blobs = [];
  let batch = [], len = 0, bytes = 0;
  await ehPullEach(id, count, (part) => {
    batch.push(part); len += part.length; bytes += part.length;
    if (len > 32e6) { blobs.push(new Blob(batch)); batch = []; len = 0; }
    if (onProgress) onProgress(bytes);
  });
  if (batch.length) blobs.push(new Blob(batch));
  return blobs;
}

// ── Crypto helpers (AES-GCM + PBKDF2) ─────────────────────────────────────
function _u8toB64(buf) {
  // Cannot spread large Uint8Arrays — chunk to avoid "maximum call stack" error
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
function _b64toU8(s) {
  // plain loop: Uint8Array.from(…, callback) was many times slower on the 20 MB pieces of a big encrypted export
  const bin = atob(s), n = bin.length, u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function ehEncrypt(plaintext, password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return { salt: _u8toB64(salt), iv: _u8toB64(iv), ct: _u8toB64(ct) };
}

async function ehDecrypt({ salt, iv, ct }, password) {
  const enc = new TextEncoder();
  const km  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: _b64toU8(salt), iterations: 100000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _b64toU8(iv) }, key, _b64toU8(ct));
  return new TextDecoder().decode(plain);
}

// Chunked encryption (format v2) for big exports: the plain text is encrypted in ~16 MB pieces, each with its own IV
// under one PBKDF2 key, written one chunk per line:
//   {"__eh_encrypted":true,"v":2,"salt":"…",
//   "chunks":[
//   {"iv":"…","ct":"…"},
//   …
//   ]}
// Neither side ever needs the whole history as a single string (the old format could not reach 1 GB).
async function ehDeriveKey(password, salt, usage) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
// "Double hash" key (encrypted auto exports): key = SHA-256( PBKDF2-SHA256(password, salt) ). background.js stores that key
// (never the password) so scheduled exports can be encrypted unattended; importing re-derives it from the typed password.
const EH_DH_ITER = 200000;
async function ehDoubleHashBytes(password, salt) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const h1 = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: EH_DH_ITER, hash: 'SHA-256' }, km, 256);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
}
async function ehDoubleHashKey(password, salt, usage) {
  return crypto.subtle.importKey('raw', await ehDoubleHashBytes(password, salt), 'AES-GCM', false, [usage]);
}
async function ehEncryptChunk(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return JSON.stringify({ iv: _u8toB64(iv), ct: _u8toB64(ct) });
}

// Pulls the export and returns the finished file as a Blob (plain JSON, or encrypted when pw is given).
// Encrypted format v3 (binary, no base64): one ASCII header line, then for every ~64 MB piece of the plain text
//   [4 bytes: length of ciphertext][12 bytes: IV][ciphertext]
// AES-GCM under one PBKDF2 key. Decoding needs no text parsing at all — see the v3 branch of ehReadEntries().
const EH_ENC_CHUNK = 64e6;
async function ehExportToBlob(begin, pw, onProgress) {
  if (!pw) return new Blob(await ehPullParts(begin.id, begin.count, onProgress), { type: 'application/json' });
  const blobs = [];
  let bytes = 0, acc = '';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await ehDeriveKey(pw, salt, 'encrypt');
  blobs.push(new Blob(['{"__eh_encrypted":true,"v":3,"salt":"' + _u8toB64(salt) + '"}\n']));
  const flush = async () => {
    if (!acc) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(acc));
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, ct.byteLength, true);
    blobs.push(new Blob([len, iv, ct]));             // Blob storage keeps it off the JS heap
    acc = '';
  };
  await ehPullEach(begin.id, begin.count, async (part) => {
    acc += part; bytes += part.length;
    if (acc.length >= EH_ENC_CHUNK) await flush();
    if (onProgress) onProgress(bytes);
  });
  await flush();
  return new Blob(blobs, { type: 'application/json' });
}

// ── "Always encrypt exports" (Settings → Data) ─────────────────────────────
// Same file format as encrypted auto exports (v2, kdf "dh"): the AES-256-GCM key is SHA-256(PBKDF2(password, salt)).
// Only that key + salt are kept in settings (alwaysEncryptExports / exportEncKey / exportEncSalt) — never the password —
// so every export path can encrypt without asking. Importing (or the "Decrypt file" button) asks for the password.
function ehAlwaysEnc() {
  const s = _curSettings || {};
  return s.alwaysEncryptExports === true && !!s.exportEncKey && !!s.exportEncSalt;
}
const EH_DH_CHUNK = 8e6;                           // characters of plain text per encrypted piece
// Encrypts a Blob of text (streamed: nothing is held as one big string). ext = extension of the plain file, so the
// "Decrypt file" button can name the result correctly (json for history, csv for time spent).
async function ehEncryptBlobDH(blob, ext) {
  const s = _curSettings;
  const key = await crypto.subtle.importKey('raw', _b64toU8(s.exportEncKey), 'AES-GCM', false, ['encrypt']);
  const out = [new Blob(['{"__eh_encrypted":true,"v":2,"kdf":"dh","ext":"' + (ext || 'json') + '","salt":"' + s.exportEncSalt + '",\n"chunks":[\n'])];
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  let acc = '', pending = null;
  const seal = async (text) => {
    const line = await ehEncryptChunk(key, text);
    if (pending !== null) out.push(new Blob([pending + ',\n']));
    pending = line;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += value;
    while (acc.length >= EH_DH_CHUNK) { await seal(acc.slice(0, EH_DH_CHUNK)); acc = acc.slice(EH_DH_CHUNK); }
  }
  if (acc || pending === null) await seal(acc);
  out.push(new Blob([pending + '\n]}\n']));
  return new Blob(out, { type: 'application/json' });
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtNum(n)  { return Number(n).toLocaleString(); }
function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  
  // Compare calendar dates, not timestamps
  // Strip time component to get midnight of each day
  const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const diff = Math.round((nDate - dDate) / 86400000);
  
  if (diff === 0) return _ehMsg("today") || 'Today';
  if (diff === 1) return _ehMsg("yesterday") || 'Yesterday';
  if (diff < 7)   return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
function tryDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60)  return `${m}m`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}
function favUrl(domain) {
  if (_curSettings && _curSettings.faviconResolver === 'browser') {
    return chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent('https://' + domain)}`);
  }
  return `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(domain)}`;
}
// setFavicon: sets img.src, using local cache when faviconResolver === 'cached'
function setFavicon(img, domain) {
  if (!domain) return;
  if (_curSettings && _curSettings.faviconResolver === 'cached') {
        chrome.runtime.sendMessage({ type: 'GET_FAVICON_CACHED', domain }, (resp) => {
      if (resp && resp.dataUrl && !img.dataset.favLoaded) {
        img.dataset.favLoaded = '1';
        img.src = resp.dataUrl;
      }
    });
  } else {
    img.src = favUrl(domain);
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastTimer;
// Same as toast() but stays up for `ms` — for results the user must not miss (e.g. "import finished").
function toastLong(msg, type = '', ms = 12000) {
  toast(msg, type);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { document.getElementById('toast').className = 'toast'; }, ms);
}

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

let _progTimer;
function toastProgress(msg, pct = 0, type = 'ok') {
  // Own element: ordinary toasts (e.g. "Settings saved") can never overwrite or hide it.
  let el = document.getElementById('toastProgress');
  if (!el) { el = document.createElement('div'); el.id = 'toastProgress'; el.className = 'toast'; document.body.appendChild(el); }
  const indet = pct === null || pct === undefined;
  const p = indet ? 0 : Math.max(0, Math.min(100, Number(pct) || 0));
  const title = msg + (indet ? '' : ' · ' + Math.round(p) + '%');
  let t = el.querySelector(':scope > .toast-title'), line = el.querySelector(':scope > .toast-line');
  if (!t || !line) {
    el.textContent = '';
    t = document.createElement('div'); t.className = 'toast-title';
    line = document.createElement('div'); line.className = 'toast-line';
    line.appendChild(document.createElement('span'));
    el.append(t, line);
  }
  if (t.textContent !== title) t.textContent = title;
  line.classList.toggle('indet', indet);
  line.firstChild.style.width = p + '%';
  const cls = `toast show progress progress-slot ${type}`;
  if (el.className !== cls) el.className = cls;
  clearTimeout(_progTimer);
  if (!indet && p >= 100) _progTimer = setTimeout(toastProgressHide, 1800);
  else _progTimer = setTimeout(toastProgressHide, 120000);   // safety: never stay forever if the worker dies
}
function toastProgressHide() {
  clearTimeout(_progTimer);
  const el = document.getElementById('toastProgress');
  if (el) { el.className = 'toast'; el.textContent = ''; }
}

// Progress of an auto-export / WebDAV upload, sent by the background
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.type !== 'AUTO_EXPORT_PROGRESS') return;
  if (m.error) { toastProgressHide(); toastLong(m.label || 'Export failed', 'err'); }
  else toastProgress(m.label || 'Exporting…', m.pct == null ? null : m.pct, 'ok');
});

// ── Theme ──────────────────────────────────────────────────────────────────
// theme-init.js (loaded in <head>) already applied the last-known theme before first paint.
// applyTheme() only syncs the rest of the UI to the effective theme; it never saves anything.
function applyTheme() {
  const t = window.EhTheme ? EhTheme.effective() : (document.documentElement.getAttribute('data-theme') || 'dark');
  document.documentElement.setAttribute('data-theme', t);
  // One button: it offers the other mode (dark now → "☀ Light", light now → "🌙 Dark")
  const tt = document.getElementById('themeToggle');
  if (tt) {
    const next = t === 'dark' ? 'light' : 'dark';
    const ic = document.getElementById('themeToggleIcon'), lb = document.getElementById('themeToggleLbl');
    if (ic) ic.textContent = next === 'light' ? '☀' : '🌙';
    if (lb) { lb.setAttribute('data-i18n-key', next); lb.textContent = tr(next, next === 'light' ? 'Light' : 'Dark'); }
  }
  // Re-apply wallpaper so overlay color adapts to new theme
  chrome.storage.local.get(WP_STORAGE_KEY, r => { if (r[WP_STORAGE_KEY]?.enabled) applyWallpaper(r[WP_STORAGE_KEY]); });
}
// Manual Light / Dark buttons (hidden while "Follow system theme" is on).
function setTheme(t) {
  if (window.EhTheme) EhTheme.set(false, t, true); else document.documentElement.setAttribute('data-theme', t);
  _curSettings.theme = t;
  applyTheme();
  send('SAVE_SETTINGS', { settings: { theme: t } }).catch(() => {});
}
// Applies saved settings: stored manual choice + follow-system flag. persist=true mirrors them
// to localStorage (what theme-init.js reads before the next paint).
function applyThemeSettings(s, persist = true) {
  const follow = s.followSystemTheme === true, theme = s.theme === 'light' ? 'light' : 'dark';
  if (window.EhTheme) EhTheme.set(follow, theme, persist);
  applyTheme();
}
// OS switched light/dark while following it (or the toggle was previewed in Settings)
window.addEventListener('eh-theme-changed', applyTheme);

// ── State ──────────────────────────────────────────────────────────────────
let allResults   = [];   // all matching entries from backend
let selected     = new Set();
let selMode      = false;
let filterDate   = null; // 'YYYY-MM-DD'
let filterHour   = null; // 0-23
let searchTimer  = null;
let _curSettings = {};

// ── Calendar Mode state ───────────────────────────────────────────────────
let calViewYear   = new Date().getFullYear();
let calViewMonth  = new Date().getMonth(); // 0-indexed
let calActiveDate = null; // date highlighted in the widget; tracks filterDate when set,
                           // or the scroll position while browsing "All time"
let _extSidebarOpen = false; // cached eh_sidebar_open flag (Chrome side panel state)

const PIE_COLORS = ['#3b9eff','#2dd4a0','#f97316','#a855f7','#ec4899','#eab308','#ef4444','#60a5fa','#34d399','#f472b6'];

// ── Infinite scroll (no spacers — append-only, reset on new search) ──────────
const PAGE_SIZE = 60;   // entries per page load

let vsOffset   = 0;
let vsRendered = [];
let _vsLoading = false;

const listArea = () => document.getElementById('listArea');

function buildVirtualList() {
  const area = listArea();
  vsOffset   = 0;
  vsRendered = [];
  _vsLoading = false;

  if (_fadeInListEnabled) {
    // Force a reflow between removing and re-adding the class so the animation
    // reliably replays even if the list was already mid- or post-animation from
    // the previous date switch.
    area.classList.remove('eh-list-fadein');
    void area.offsetWidth;
    area.classList.add('eh-list-fadein');
  }

  if (!allResults.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span><span>`+tr('no_history_found','No history found<')+`</span></div>`;
    // No day-label elements exist, so dayLabelStickyCheck can't update the bar: set it from the selected date
    // (otherwise it keeps showing the previous day).
    const _bar = document.getElementById('dayLabelBar');
    if (_bar) {
      let t = '';
      if (filterDate) {
        const [y, m, d] = filterDate.split('-').map(Number);
        if (y && m && d) t = dayLabel(new Date(y, m - 1, d).getTime());
      }
      _bar.textContent = t;
    }
    area._dlN = 0; area._dlLen = 0;
    return;
  }

  area.innerHTML = '';
  appendPage();          // render first page immediately
  setupScrollObserver(area);
  calScrollSpyCheck(area);
  dayLabelStickyCheck(area);
}

function appendPage() {
  if (_vsLoading) return;
  if (vsOffset >= allResults.length) return;
  _vsLoading = true;

  const area  = listArea();
  const slice = allResults.slice(vsOffset, vsOffset + PAGE_SIZE);
  if (!slice.length) { _vsLoading = false; return; }

  // Group consecutive entries by day
  let prevDay = vsOffset > 0 ? dayLabel(allResults[vsOffset - 1].visitTime) : null;

  for (const e of slice) {
    const dl  = dayLabel(e.visitTime);
    const dom = e.domain || tryDomain(e.url);

    // Insert day header when day changes
    if (dl !== prevDay) {
      const hdr = document.createElement('div');
      hdr.className = 'day-label';
      hdr.dataset.date = new Date(e.visitTime).toLocaleDateString('en-CA');
      hdr.innerHTML = esc(dl);
      area.appendChild(hdr);
      prevDay = dl;
    }

    const sel = selected.has(e.id);
    const row = document.createElement('div');
    row.className = `entry${sel ? ' sel' : ''}${selMode ? ' sel-mode-entry' : ''}`;
    row.dataset.id   = e.id;
    row.dataset.url  = e.url;
    row.dataset.date = new Date(e.visitTime).toLocaleDateString('en-CA');
    row.dataset.vt   = e.visitTime;
    row.innerHTML = `
    <div class="entry-check" data-id="${esc(e.id)}" title="Select">✓</div>
    <img class="e-fav" src="${favUrl(dom)}" loading="lazy"/>
    <div class="e-body">
    <div class="e-title">${esc(e.title || e.url)}</div>
    <div class="e-url">${esc(e.url)}</div>
    </div>
    <div class="e-time">${fmtTime(e.visitTime)}</div>
    <button class="e-del-btn" data-id="${esc(e.id)}" title="Delete">✕</button>`;
    row.querySelector('.e-fav').addEventListener('error', function(){ this.style.opacity='0'; });

    // Context menu
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const entry = allResults.find(x => x.id === e.id) || { id: e.id, url: e.url, title: e.title };
      showCtxMenu(ev.clientX, ev.clientY, entry);
    });
    // Click to open
    row.addEventListener('click', ev => {
      if (ev.target.classList.contains('entry-check') || ev.target.classList.contains('e-del-btn')) return;
      if (selMode) { handleCheckClick(e.id); return; }
      window.open(e.url, '_blank');
    });
    // Checkbox
    row.querySelector('.entry-check').addEventListener('click', ev => {
      ev.stopPropagation(); handleCheckClick(e.id);
    });
    // Delete
    row.querySelector('.e-del-btn').addEventListener('click', ev => {
      ev.stopPropagation(); deleteSingle(e.id);
    });

    area.appendChild(row);
    vsRendered.push(e);
  }

  vsOffset += slice.length;
  _vsLoading = false;
}

// Re-render all currently displayed entries (after select/deselect)
function rerenderVisible() {
  const area = listArea();
  area.querySelectorAll('.entry').forEach(el => {
    const id  = el.dataset.id;
    const sel = selected.has(id);
    el.classList.toggle('sel', sel);
    el.classList.toggle('sel-mode-entry', selMode);
  });
}

let _scrollObserver = null;
function setupScrollObserver(area) {
  if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
  area.onscroll = null;
  area.onscroll = () => {
    const { scrollTop, scrollHeight, clientHeight } = area;
    if (scrollTop + clientHeight >= scrollHeight - 400) {
      appendPage();
    }
    calScrollSpyCheck(area);
    dayLabelStickyCheck(area);
  };
}

// ── Selection bar ──────────────────────────────────────────────────────────
function updateSelBar() {
  const bar = document.getElementById('selBar');
  bar.classList.toggle('on', selected.size > 0);
  document.getElementById('selCount').textContent = `${fmtNum(selected.size)} selected`;
}

// ── Search / filter ────────────────────────────────────────────────────────
function getFilters() {
  const q    = document.getElementById('searchInput').value.trim();
  const mode = document.getElementById('searchMode').value;
  let fromTs = null, toTs = null;

  if (filterDate && filterHour !== null) {
    const base = new Date(filterDate + 'T00:00:00').getTime();
    fromTs = base + filterHour * 3600000;
    toTs   = fromTs + 3600000 - 1;
  } else if (filterDate) {
    fromTs = new Date(filterDate + 'T00:00:00').getTime();
    toTs   = fromTs + 86400000 - 1;
  } else {
    const fv = document.getElementById('dateFrom').value;
    const tv = document.getElementById('dateTo').value;
    if (fv) fromTs = new Date(fv).getTime();
    if (tv) toTs   = new Date(tv + 'T23:59:59').getTime();
  }
  return { query: q, mode, startDate: fromTs, endDate: toTs, expr: !!(window.EhExpr && window.EhExpr.on()) };
}

// NOTE: date/search switching is fast because background.js now keeps history
// in memory between calls (see getAll()/setAll() there) instead of re-reading
// and re-parsing the whole storage blob on every SEARCH message. We deliberately
// do NOT duplicate the entire history into this page's memory (that was tried
// and caused growing RAM usage across reloads) — only the current filtered
// result set is held here, same as before.
const EH_CID = Math.random().toString(36).slice(2);
let _searchGen = 0;
async function doSearch() {
  const { query, mode, startDate, endDate, expr } = getFilters();
  const gen = ++_searchGen;
  selected.clear(); selMode = false; updateSelBar();

  listArea().innerHTML = `<div class="state-msg" style="color:var(--text3);font-size:0.85rem">Loading…</div>`;

  try {
    // Two steps: the first screenful comes back (and renders) almost immediately — the database stops
    // scanning as soon as it has that many matches — then the rest of the list is appended behind it.
    const FIRST = 600, MAX = 20000, STEP = 4000;
    const qf = (window.QuickFilters && window.QuickFilters.activePatterns && window.QuickFilters.activePatterns()) || null;   // applied by the database over the whole history
    const r = await sendLong('SEARCH', { query, mode, startDate, endDate, limit: FIRST, qf, expr, noTotal: true, cid: EH_CID, token: gen });
    if (gen !== _searchGen || r.cancelled) return;      // a newer search (next keystroke) replaced this one
    allResults = applyQuickFilterEntries(r.entries);
    buildVirtualList();
    if (!startDate && !endDate) mergeLiveTodayIntoAll(gen, query, mode).catch(() => {});
    if (r.entries.length >= FIRST) {
      // The rest arrives in modest steps (not one 19 000-row query): the database can notice a newer keystroke
      // between steps instead of finishing a huge superseded query first — that is what made typing slow down.
      let offset = FIRST;
      while (offset < MAX) {
        const r2 = await sendLong('SEARCH', { query, mode, startDate, endDate, offset, limit: Math.min(STEP, MAX - offset), qf, expr, noTotal: true, cid: EH_CID, token: gen });
        if (gen !== _searchGen || r2.cancelled) return;
        const had = allResults.length;
        allResults = allResults.concat(applyQuickFilterEntries(r2.entries));
        if (vsOffset >= had && allResults.length > had) appendPage();
        offset += r2.entries.length;
        if (r2.entries.length < Math.min(STEP, MAX - (offset - r2.entries.length))) break;
      }
      if (!startDate && !endDate) mergeLiveTodayIntoAll(gen, query, mode).catch(() => {});
    }
  } catch (err) {
    if (gen !== _searchGen) return;
    listArea().innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

function historyEntryMatches(e, query, mode) {
  if (query && window.EhExpr && window.EhExpr.on()) {
    return window.EhExpr.test(query, mode === 'title' ? (e.title || '') : mode === 'url' ? String(e.url || '') : mode === 'domain' ? (e.domain || '') : ((e.url || '') + ' ' + (e.title || '') + ' ' + (e.domain || '')));
  }
  const words = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  if (!words.length) return true;
  const hay = (mode === 'title')  ? (e.title || '').toLowerCase()
            : (mode === 'url')    ? String(e.url || '').toLowerCase()
            : (mode === 'domain') ? (e.domain || '').toLowerCase()
            : ((e.url || '') + ' ' + (e.title || '') + ' ' + (e.domain || '')).toLowerCase();
  return words.every(w => hay.includes(w));
}

function historyDupKey(e) {
  return `${e.url || ''}|${Math.floor((Number(e.visitTime) || 0) / 5000)}`;
}

async function mergeLiveTodayIntoAll(gen, query, mode) {
  const r = await sendLong('GET_TODAY_HISTORY');
  if (gen !== _searchGen || !r || !Array.isArray(r.entries) || !r.entries.length) return;
  const seen = new Set(allResults.map(historyDupKey));
  const live = r.entries
    .filter(e => historyEntryMatches(e, query, mode))
    .filter(e => {
      const k = historyDupKey(e);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.visitTime - a.visitTime);
  const merged = applyQuickFilterEntries(live);
  if (!merged.length || gen !== _searchGen) return;
  allResults = merged.concat(allResults).sort((a, b) => b.visitTime - a.visitTime);
  buildVirtualList();
}

// Back-compat no-ops — earlier revision kept a full-history page-side cache that
// needed patching after deletes. Kept as harmless stubs in case anything still
// calls them; SEARCH always reflects live storage now, so there's nothing to patch.
function invalidateHistCache() {}
function patchHistCacheRemoveIds() {}

// High contrast mode — rather than hunting down every rule that uses the
// dimmer --text2/--text3 secondary/tertiary text colors, just override those
// two CSS custom properties themselves at :root to resolve to --text instead.
// Every existing rule using var(--text2)/var(--text3) picks this up
// automatically, in both themes, with nothing else to touch.
function applyHighContrastMode(enabled) {
  const root = document.documentElement;
  if (enabled) {
    root.style.setProperty('--text2', 'var(--text)');
    root.style.setProperty('--text3', 'var(--text)');
  } else {
    root.style.removeProperty('--text2');
    root.style.removeProperty('--text3');
  }
}

// UI rounded corners toggle — .sidebar/.main read both their margin and
// border-radius from CSS variables (falling back to the original 8px/20px
// when unset), so disabling zeroes both for a flush, edge-to-edge layout.
// Settings > Navigation icons: off => <html class="hide-nav-icons"> (CSS: display:none on the icons)
function applyNavIcons(enabled) {
  document.documentElement.classList.toggle('hide-nav-icons', enabled === false);
}
// Settings > Match UI colors: on => <html class="match-ui-colors"> (list = same colour as the UI)
function applyMatchUiColors(enabled) {
  document.documentElement.classList.toggle('match-ui-colors', enabled === true);
}

function applyRoundedCorners(enabled) {
  const root = document.documentElement;
  if (enabled === false) {
    root.style.setProperty('--ui-radius', '0px');
    root.style.setProperty('--ui-margin', '0px');
  } else {
    root.style.removeProperty('--ui-radius');
    root.style.removeProperty('--ui-margin');
  }
}

// ── Date nav ────────────────────────────────────────────────────────────────
const DAYS = [tr('sun','Sun'),tr('mon','Mon'),tr('tue','Tue'),tr('wed','Wed'),tr('thu','Thu'),tr('fri','Fri'),tr('sat','Sat')];
// Short month names from the extension's own translations (keys jan..dec), so the date pills follow the Language menu.
const MONTHS_SHORT = [tr('jan','Jan'),tr('feb','Feb'),tr('mar','Mar'),tr('apr','Apr'),tr('may','May'),tr('jun','Jun'),tr('jul','Jul'),tr('aug','Aug'),tr('sep','Sep'),tr('oct','Oct'),tr('nov','Nov'),tr('dec','Dec')];
// Same interface as Intl.DateTimeFormat#format, used for the .dn-pill-label ("Oct 13")
const PILL_DATE_FMT = { format: d => MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate() };

// Lets a normal mouse wheel (vertical-only deltaY) scroll the horizontally
// scrolling date-pill bar — off by default since trackpads already scroll it
// horizontally on their own; useful for desktop/laptop mouse users. Moves by
// whole pill-widths per wheel "click" rather than raw pixel deltas, with a
// sensitivity setting (1–6) controlling how many days that jumps per click.
let _datePillsWheelEnabled = false;
let _datePillsWheelSensitivity = 1;
// Settings > Appearance > "Fade in list on date change"
let _fadeInListEnabled = true;   // on by default (until the user switches it off in Settings)
function applyDatePillsWheelScroll(enabled, sensitivity) {
  _datePillsWheelEnabled = enabled;
  if (sensitivity != null) _datePillsWheelSensitivity = Math.max(1, Math.min(6, sensitivity));
  const wrap = document.getElementById('dateScrollWrap');
  if (!wrap || wrap._ehWheelBound) return; // bind the listener once; toggle via the flags above
  wrap._ehWheelBound = true;
  let _wheelCooldown = false;
  wrap.addEventListener('wheel', (e) => {
    if (!_datePillsWheelEnabled) return;
    // Only hijack predominantly-vertical wheel input — let native horizontal
    // trackpad/shift-wheel gestures (deltaX) pass through untouched.
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    // Debounce so one physical wheel "click" reliably reads as exactly one
    // step, regardless of how many wheel events the OS/browser fires for it.
    if (_wheelCooldown) return;
    _wheelCooldown = true;
    setTimeout(() => { _wheelCooldown = false; }, 110);

    const pillWidth = _vp ? _vp.W + _vp.gap : 60;
    const dir = e.deltaY > 0 ? 1 : -1;
    wrap.scrollBy({ left: dir * pillWidth * _datePillsWheelSensitivity, behavior: 'smooth' });
  }, { passive: false });
}

// ── Virtualized date pills ──────────────────────────────────────────────────
// A 10-year history means ~3 650 buttons; keeping them all in the DOM costs a lot of RAM. Only the pills in (and
// just around) the visible part of the strip exist; two spacer elements stand in for the rest, so the scroll width
// and every position stay exactly what they would be with all pills present.
let _vp = null;   // { N, W, gap, w0, w1, s, e, t0, fmt, active, needMeasure }
function vpDate(i) { const t = _vp.t0; return new Date(t.getFullYear(), t.getMonth(), t.getDate() - i, 12); }   // noon: immune to DST
function vpKey(i)  { const d = vpDate(i); return calDateKey(d.getFullYear(), d.getMonth(), d.getDate()); }
function vpIndexOfKey(key) {
  if (!_vp || !key) return -1;
  const [y, m, d] = key.split('-').map(Number);
  const t = _vp.t0;
  const a = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()), b = Date.UTC(y, m - 1, d);
  return Math.round((a - b) / 86400000);
}
function vpLeft(i) {                                   // x of pill i inside the strip
  const v = _vp, g = v.gap;
  if (i <= 0) return 0;
  if (i === 1) return v.w0 + g;
  return v.w0 + g + v.w1 + g + (i - 2) * (v.W + g);
}
function vpIndexAt(x) {
  const v = _vp, g = v.gap;
  if (x < v.w0 + g) return 0;
  if (x < v.w0 + g + v.w1 + g) return 1;
  return Math.min(v.N - 1, 2 + Math.floor((x - (v.w0 + v.w1 + 2 * g)) / (v.W + g)));
}
function vpMakePill(i) {
  const d = vpDate(i), key = calDateKey(d.getFullYear(), d.getMonth(), d.getDate());
  const b = document.createElement('button');
  b.className = 'dn-pill';
  b.dataset.date = key;
  if (i < 2) {
    b.classList.add('no-day');
    b.textContent = i === 0 ? (_ehMsg('today') || 'Today') : (_ehMsg('yesterday') || 'Yesterday');
  } else {
    const l = document.createElement('span'); l.className = 'dn-pill-label'; l.textContent = _vp.fmt.format(d);
    const w = document.createElement('span'); w.className = 'dn-pill-day';   w.textContent = DAYS[d.getDay()];
    b.append(l, w);
  }
  if (key === _vp.active) b.classList.add('active');
  return b;
}
function vpRender(s, e) {
  const v = _vp, scroll = document.getElementById('dateScroll');
  s = Math.max(0, s); e = Math.min(v.N, e);
  const frag = document.createDocumentFragment();
  if (s > 0) { const sp = document.createElement('div'); sp.className = 'dn-spacer'; sp.style.width = Math.max(0, vpLeft(s) - v.gap) + 'px'; frag.appendChild(sp); }
  for (let i = s; i < e; i++) frag.appendChild(vpMakePill(i));
  if (e < v.N) {
    const sp = document.createElement('div'); sp.className = 'dn-spacer';
    const total = vpLeft(v.N - 1) + v.W;                      // full strip width
    const endX = e > 0 ? vpLeft(e - 1) + (e - 1 < 2 ? (e - 1 === 0 ? v.w0 : v.w1) : v.W) : 0;
    sp.style.width = Math.max(0, total - endX - v.gap) + 'px';
    frag.appendChild(sp);
  }
  scroll.textContent = '';
  scroll.appendChild(frag);
  v.s = s; v.e = e;
}
function vpMeasure() {
  const v = _vp, scroll = document.getElementById('dateScroll');
  scroll.style.removeProperty('--pw');
  const probes = [];
  const longest = DAYS.reduce((a, b) => (b.length > a.length ? b : a), '');
  const mk = (cls, label, day) => {
    const b = document.createElement('button'); b.className = 'dn-pill ' + cls; b.style.visibility = 'hidden';
    if (day != null) { const l = document.createElement('span'); l.className = 'dn-pill-label'; l.textContent = label; const w = document.createElement('span'); w.className = 'dn-pill-day'; w.textContent = day; b.append(l, w); }
    else b.textContent = label;
    scroll.appendChild(b); probes.push(b); return b;
  };
  const p0 = mk('no-day', _ehMsg('today') || 'Today'), p1 = mk('no-day', _ehMsg('yesterday') || 'Yesterday');
  let W = 0;
  for (let m = 0; m < 12; m++) { const b = mk('', v.fmt.format(new Date(2001, m, 28)), longest); W = Math.max(W, b.getBoundingClientRect().width); }
  const w0 = p0.getBoundingClientRect().width, w1 = p1.getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(scroll).columnGap || getComputedStyle(scroll).gap) || 5;
  probes.forEach(b => b.remove());
  if (W > 0 && w0 > 0) { v.W = Math.ceil(W); v.w0 = Math.ceil(w0); v.w1 = Math.ceil(w1); v.gap = gap; v.needMeasure = false; }
  else { v.W = v.W || 62; v.w0 = v.w0 || 56; v.w1 = v.w1 || 84; v.gap = gap; v.needMeasure = true; }   // hidden right now: measure when it shows
  scroll.style.setProperty('--pw', v.W + 'px');
}
// Make sure the pills around the visible area exist.
function vpEnsure(force) {
  const v = _vp, wrap = document.getElementById('dateScrollWrap');
  if (!v || !wrap) return;
  if (v.needMeasure && wrap.clientWidth > 0) { vpMeasure(); force = true; }
  const x0 = wrap.scrollLeft, x1 = x0 + Math.max(wrap.clientWidth, 300);
  const i0 = vpIndexAt(x0), i1 = vpIndexAt(x1);
  const margin = 12;
  if (!force && v.s <= Math.max(0, i0 - margin) && v.e >= Math.min(v.N, i1 + margin + 1)) return;       // still inside the built window
  const pad = 45;
  vpRender(i0 - pad, i1 + pad + 1);
}
function vpSetActive(key) {
  if (!_vp) return;
  _vp.active = key;
  const scroll = document.getElementById('dateScroll');
  scroll.querySelectorAll('.dn-pill.active').forEach(b => b.classList.remove('active'));
  if (key) { const t = scroll.querySelector(`.dn-pill[data-date="${key}"]`); if (t) t.classList.add('active'); }
}
function buildDateNav(retentionDays) {
  const scroll = document.getElementById('dateScroll');
  const wrap   = document.getElementById('dateScrollWrap');

  // Use the setting value; fall back to 365 if not provided or not a valid number.
  // Add 1 so "today" (i=0) is always included even when retentionDays is exactly 1.
  const pillCount = (Number.isFinite(retentionDays) && retentionDays > 0) ? retentionDays + 1 : 366;

  const prevActive = _vp ? _vp.active : null;
  _vp = { N: pillCount, W: 62, gap: 5, w0: 56, w1: 84, s: 0, e: 0, t0: new Date(), fmt: PILL_DATE_FMT, active: prevActive, needMeasure: false };
  scroll.textContent = '';
  vpMeasure();
  vpRender(0, 100);
  vpEnsure(true);
  if (scroll._ehWired) return;                       // listeners below are attached once
  scroll._ehWired = true;
  scroll.addEventListener('click', (ev) => {
    const pill = ev.target.closest('.dn-pill');
    if (pill && scroll.contains(pill)) activateDatePill(pill.dataset.date);
  });
  const allPillBtn = document.getElementById('dnAllPill');
  allPillBtn.textContent=tr('all','All');
  if (allPillBtn) allPillBtn.addEventListener('click', () => activateDatePill('all'));
  let _raf = 0;
  wrap.addEventListener('scroll', () => { if (_raf) return; _raf = requestAnimationFrame(() => { _raf = 0; vpEnsure(false); }); }, { passive: true });
  try { new ResizeObserver(() => vpEnsure(false)).observe(wrap); } catch (_) {}

  // ── Scroll year indicator on dnAllPill ──────────────────────────────────────
  (function setupScrollYearIndicator() {
    const wrap    = document.getElementById('dateScrollWrap');
    const allPill = document.getElementById('dnAllPill');
    if (!wrap || !allPill) return;

    let _scrollStopTimer = null;
    let _isScrolling = false;

    wrap.addEventListener('scroll', () => {
      if (!_vp) return;
      const i = vpIndexAt(wrap.scrollLeft);
      const year = String(vpDate(i).getFullYear());
      allPill.textContent = year;
      _isScrolling = true;

      // Reset back to "All" shortly after scrolling stops
      clearTimeout(_scrollStopTimer);
      _scrollStopTimer = setTimeout(() => {
        _isScrolling = false;
        // Restore the original label — "All" (use i18n if available)
        allPill.textContent = tr('all','All');
      }, 600);
    }, { passive: true });
  })();

  // Arrow buttons: ‹ selects the date pill to the left of the active one, › the pill to the right
  // (pills run newest → oldest, left to right). With no day selected ("All") the first press picks Today.
  (function setupArrows() {
    const L = document.getElementById('dnLeft');
    const R = document.getElementById('dnRight');
    function step(dir) {
      if (!_vp) return;
      const cur = vpIndexOfKey(_vp.active);
      const next = (!_vp.active || cur < 0) ? 0 : Math.max(0, Math.min(_vp.N - 1, cur + dir));
      if (next === cur) return;                       // already at the first / last pill
      activateDatePill(vpKey(next));
    }
    // Hold an arrow to keep stepping through the dates (first step immediately, then repeating after a short delay).
    function bindHold(btn, dir) {
      let delayT = null, repT = null;
      const stop = () => { clearTimeout(delayT); clearInterval(repT); delayT = repT = null; };
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        stop();
        step(dir);
        delayT = setTimeout(() => { repT = setInterval(() => step(dir), 110); }, 420);
      });
      ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev => btn.addEventListener(ev, stop));
      window.addEventListener('pointerup', stop);
      // Keyboard activation (Enter/Space) has no pointer events: detail === 0 there.
      btn.addEventListener('click', (e) => { if (e.detail === 0) step(dir); });
    }
    bindHold(L, -1);
    bindHold(R, 1);

    // Right-click: ‹ jumps to the newest day (today), › jumps to the oldest day that has history
    L.addEventListener('contextmenu', (e) => { e.preventDefault(); jumpToNewestDay(); });
    R.addEventListener('contextmenu', (e) => { e.preventDefault(); jumpToOldestDay(); });
  })();
}

function jumpToNewestDay() {
  if (_vp) activateDatePill(vpKey(0));               // pills run newest → oldest
}

async function jumpToOldestDay() {
  if (!_vp) return;
  let idx = _vp.N - 1;
  try {
    const st = await sendLong('GET_STATS');
    if (st && st.oldestEntry) {
      const key = new Date(st.oldestEntry).toLocaleDateString('en-CA');
      const i = vpIndexOfKey(key);
      if (i >= 0 && i < _vp.N) idx = i;               // older than the pill range → last pill
    }
  } catch {}
  activateDatePill(vpKey(idx));
}

function activateDatePill(key, silent, hour) {
  filterHour = null;
  document.querySelectorAll('.hn-pill').forEach(b => b.classList.remove('active'));
  document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');

  filterDate = key === 'all' ? null : key;
  document.getElementById('dateFrom').value = filterDate || '';
  document.getElementById('dateTo').value   = filterDate || '';

  // Clear all pills in scroll + the external All pill
  const allPill = document.getElementById('dnAllPill');
  if (allPill) allPill.classList.remove('active');
  vpSetActive(key === 'all' ? null : key);

  if (key === 'all') {
    if (allPill) allPill.classList.add('active');
  } else {
    const idx = vpIndexOfKey(key);
    if (_vp && idx >= 0 && idx < _vp.N && !silent) {
      const wrap = document.getElementById('dateScrollWrap');
      // Land with a few pills visible to the left of the active one. Positions are computed, so this works
      // even when the target pill isn't in the DOM yet (it is created as the strip scrolls there).
      const pillsBack = wrap.offsetWidth < 700 ? 2 : 6;
      const left = vpLeft(idx) - (vpLeft(idx) - vpLeft(Math.max(0, idx - pillsBack)));
      wrap.scrollTo({ left, behavior: 'smooth' });
    }
  }
  updateHourPillsState();
  // Optional hour (0–23): "Jump to date&time" lands on the day AND the hour in a single search
  if (hour != null && filterDate) {
    filterHour = hour;
    document.querySelectorAll('.hn-pill').forEach(x => x.classList.remove('active'));
    document.querySelector(`.hn-pill[data-h="${hour}"]`)?.classList.add('active');
    updateCalHourGridState();
  }
  syncCalActiveDate(key);
  return silent ? undefined : doSearch();
}

// ── Hour nav ────────────────────────────────────────────────────────────────
function buildHourNav() {
  const row = document.getElementById('hourRow');

  function addPill(label, h) {
    const b = document.createElement('button');
    b.className    = 'hn-pill';
    b.textContent  = label;
    b.dataset.h    = h === null ? 'all' : h;
    b.addEventListener('click', () => setFilterHour(h));
    row.appendChild(b);
    return b;
  }

  addPill(tr('all','All'), null).classList.add('active');
  for (let h = 0; h < 24; h++) {
    const lbl = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
    addPill(lbl, h);
  }
  updateHourPillsState();
}

// Shared by the old hour-pill row and the calendar-mode hour grid — a single
// source of truth for `filterHour` so both UIs (only one visible at a time)
// stay in sync no matter which one triggered the change.
function setFilterHour(h) {
  if (h === null) {
    filterHour = null;
  } else {
    filterHour = filterHour === h ? null : h;
  }
  document.querySelectorAll('.hn-pill').forEach(x => x.classList.remove('active'));
  if (filterHour !== null) {
    document.querySelector(`.hn-pill[data-h="${filterHour}"]`)?.classList.add('active');
  } else {
    document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');
  }
  updateCalHourGridState();
  doSearch();
}

// Enable/disable hour pills based on whether a date filter is active
function updateHourPillsState() {
  const hasDate = !!filterDate;
  document.querySelectorAll('.hn-pill:not([data-h="all"])').forEach(b => {
    b.disabled = !hasDate;
    b.style.opacity = hasDate ? '' : '0.35';
    b.style.cursor  = hasDate ? '' : 'default';
    b.title = hasDate ? '' : 'Select a date first to filter by hour';
  });
  updateCalHourGridState();
}

// ══ CALENDAR MODE ═══════════════════════════════════════════════════════════
// Right-side calendar sidebar, shown instead of the date/hour pill nav when
// the "UI calendar mode" setting is on and the History panel is active.
// The calendar sidebar serves two panels: History (default) and Reading Mode (always, once a file is loaded).
let _calTarget = 'history';
const calSel = () => (_calTarget === 'reading' ? _rmFilterDate : filterDate);
function calActivate(key) { if (_calTarget === 'reading') rmActivateDatePill(key); else activateDatePill(key); }
function calMonths() { return window._ehMonthNames(); }
function calWeekdays() { return window._ehWeekdayInitials(); }

function calDateKey(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function calTodayKey() {
  const t = new Date();
  return calDateKey(t.getFullYear(), t.getMonth(), t.getDate());
}

// Calendar-mode hour grid — active/disabled state only (rebuilding the grid
// itself happens once at init via buildCalHourGrid()).
function updateCalHourGridState() {
  const hasDate = !!filterDate;
  document.querySelectorAll('.cal-hour-cell').forEach(b => {
    const h = b.dataset.h;
    const isAll = h === 'all';
    b.disabled = !isAll && !hasDate;
    b.classList.toggle('active', isAll ? filterHour === null : Number(h) === filterHour);
    b.title = (!isAll && !hasDate) ? 'Select a date first to filter by hour' : '';
  });
}

// Keeps the widget's notion of "active date" in sync with activateDatePill(),
// regardless of whether the change came from the old pills, the calendar
// itself, or programmatically. key === 'all' leaves calActiveDate as-is —
// scroll-spy takes over from there once results render.
function syncCalActiveDate(key) {
  if (key && key !== 'all') {
    calActiveDate = key;
    const [y, m] = key.split('-').map(Number);
    calViewYear = y; calViewMonth = m - 1;
  }
  document.getElementById('calAllTimeBtn')?.classList.toggle('active', key === 'all');
  renderCalendarWidget();
}

function renderCalendarWidget() {
  const monthLbl = document.getElementById('calMonthLabel');
  const yearLbl  = document.getElementById('calYearLabel');
  if (monthLbl) monthLbl.textContent = calMonths()[calViewMonth];
  if (yearLbl)  yearLbl.textContent  = String(calViewYear);

  const wdEl = document.getElementById('calWeekdays');
  if (wdEl && !wdEl.dataset.built) {
    wdEl.innerHTML = calWeekdays().map(w => `<span>${w}</span>`).join('');
    wdEl.dataset.built = '1';
  }

  const daysEl = document.getElementById('calDays');
  if (!daysEl) return;
  daysEl.innerHTML = '';

  const firstOfMonth = new Date(calViewYear, calViewMonth, 1);
  const startOffset  = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth   = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const daysInPrev    = new Date(calViewYear, calViewMonth, 0).getDate();
  const todayKey = calTodayKey();

  const cells = [];
  for (let i = startOffset - 1; i >= 0; i--) cells.push({ y: calViewMonth === 0 ? calViewYear - 1 : calViewYear, m: (calViewMonth + 11) % 12, d: daysInPrev - i, outside: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ y: calViewYear, m: calViewMonth, d, outside: false });
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1];
    const nd = new Date(last.y, last.m, last.d + 1);
    cells.push({ y: nd.getFullYear(), m: nd.getMonth(), d: nd.getDate(), outside: true });
  }

  for (const c of cells) {
    const key = calDateKey(c.y, c.m, c.d);
    const btn = document.createElement('button');
    btn.className = 'cal-day-cell';
    btn.textContent = c.d;
    btn.dataset.date = key;
    if (c.outside) btn.classList.add('outside');
    if (key === todayKey) btn.classList.add('today');
    const sel = calSel();
    if (key === sel) btn.classList.add('selected');
    else if (!sel && key === calActiveDate && _calTarget !== 'reading') btn.classList.add('scroll-highlight');
    if (key > todayKey) btn.classList.add('future');
    // Reading mode: only days that exist in the loaded file can be picked
    const noData = _calTarget === 'reading' && !_rmDayMap.has(key);
    if (_calTarget === 'reading') btn.classList.add(noData ? 'no-data' : 'has-data');
    btn.addEventListener('click', () => {
      if (key > todayKey || noData) return;
      calSelectDate(key);
    });
    daysEl.appendChild(btn);
  }
}

function calSelectDate(key) {
  closeCalPickers();
  calActivate(key); // handles the active date, calendar sync, and the search / filter
}

function calGoAllTime() {
  closeCalPickers();
  calActivate('all');
}

function calShiftMonth(delta) {
  calViewMonth += delta;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  renderCalendarWidget();
}

async function calJumpEnd(oldest) {
  if (_calTarget === 'reading') {
    if (!_rmDayIndex.length) return;
    calSelectDate(oldest ? _rmDayIndex[_rmDayIndex.length - 1].key : _rmDayIndex[0].key);
    return;
  }
  if (!oldest) { calSelectDate(calTodayKey()); return; }
  try {
    const st = await sendLong('GET_STATS');
    if (st && st.oldestEntry) { calSelectDate(new Date(st.oldestEntry).toLocaleDateString('en-CA')); return; }
  } catch (_) {}
}

function calShiftDay(delta) {
  if (_calTarget === 'reading') {                       // previous / next day that actually has entries in the file
    const keys = _rmDayIndex.map(d => d.key);            // newest → oldest
    if (!keys.length) return;
    const a = _rmFilterDate;
    let pick = null;
    if (!a) pick = keys[0];
    else if (delta < 0) pick = keys.find(k => k < a) || null;                       // older
    else { for (let i = keys.length - 1; i >= 0; i--) if (keys[i] > a) { pick = keys[i]; break; } }   // newer
    if (pick) calSelectDate(pick);
    return;
  }
  const anchor = filterDate || calActiveDate || calTodayKey();
  const [y, m, d] = anchor.split('-').map(Number);
  const nd = new Date(y, m - 1, d + delta);
  const key = calDateKey(nd.getFullYear(), nd.getMonth(), nd.getDate());
  if (key > calTodayKey()) return; // don't navigate into the future
  calSelectDate(key);
}

function closeCalPickers() {
  const mp = document.getElementById('calMonthPicker');
  const yp = document.getElementById('calYearPicker');
  if (mp) mp.style.display = 'none';
  if (yp) yp.style.display = 'none';
}

function calOpenMonthPicker() {
  const el = document.getElementById('calMonthPicker');
  const yp = document.getElementById('calYearPicker');
  if (!el) return;
  if (yp) yp.style.display = 'none';
  const open = el.style.display !== 'none';
  if (open) { el.style.display = 'none'; return; }
  el.innerHTML = calMonths().map((name, i) =>
    `<div class="cal-picker-cell${i === calViewMonth ? ' active' : ''}" data-m="${i}">${name.slice(0,3)}</div>`
  ).join('');
  el.querySelectorAll('.cal-picker-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      calViewMonth = Number(cell.dataset.m);
      el.style.display = 'none';
      renderCalendarWidget();
    });
  });
  el.style.display = 'grid';
}

let _calYearPageStart = null; // top-left year of the currently shown year-picker page
function calOpenYearPicker() {
  const el = document.getElementById('calYearPicker');
  const mp = document.getElementById('calMonthPicker');
  if (!el) return;
  if (mp) mp.style.display = 'none';
  const open = el.style.display !== 'none';
  if (open) { el.style.display = 'none'; return; }
  if (_calYearPageStart === null) _calYearPageStart = calViewYear - 4;
  calRenderYearPicker();
  el.style.display = 'grid';
}
function calRenderYearPicker() {
  const el = document.getElementById('calYearPicker');
  if (!el) return;
  const years = [];
  for (let i = 0; i < 9; i++) years.push(_calYearPageStart + i);
  el.innerHTML = `
    <div class="cal-picker-nav">
      <button id="calYearPagePrev">‹ ${_calYearPageStart - 9}s</button>
      <button id="calYearPageNext">${_calYearPageStart + 9}s ›</button>
    </div>` +
    years.map(y => `<div class="cal-picker-cell${y === calViewYear ? ' active' : ''}" data-y="${y}">${y}</div>`).join('');
  el.querySelectorAll('.cal-picker-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      calViewYear = Number(cell.dataset.y);
      el.style.display = 'none';
      renderCalendarWidget();
    });
  });
  document.getElementById('calYearPagePrev')?.addEventListener('click', () => { _calYearPageStart -= 9; calRenderYearPicker(); });
  document.getElementById('calYearPageNext')?.addEventListener('click', () => { _calYearPageStart += 9; calRenderYearPicker(); });
}

function buildCalHourGrid() {
  const grid = document.getElementById('calHoursGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'cal-hour-cell all-hours active tb-btn';
  allBtn.textContent = tr('all_hours', 'All hours');
  allBtn.dataset.h = 'all';
  allBtn.addEventListener('click', () => setFilterHour(null));
  grid.appendChild(allBtn);
  for (let h = 0; h < 24; h++) {
    const lbl = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
    const b = document.createElement('button');
    b.className = 'cal-hour-cell tb-btn';
    b.textContent = lbl;
    b.dataset.h = h;
    b.addEventListener('click', () => setFilterHour(h));
    grid.appendChild(b);
  }
  updateCalHourGridState();
}

function dayLabelStickyCheck(area) {
  if (!area || area._dlPending) return;
  area._dlPending = true;
  requestAnimationFrame(() => {
    area._dlPending = false;
    const labels = area.getElementsByClassName('day-label');
    const n = labels.length;
    const bar = area.id === 'listArea' ? document.getElementById('dayLabelBar')
              : area.id === 'rmListArea' ? document.getElementById('rmDayLabelBar') : null;
    if (!n) { area._dlN = 0; area._dlLen = 0; if (bar) bar.textContent = ''; return; }
    const limit = area.getBoundingClientRect().top + 1;
    let lo = 0, hi = n - 1, cur = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (labels[mid].getBoundingClientRect().top <= limit) { cur = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const want = Math.max(cur, 0);                       // labels [0, want) are covered
    if (bar) {                                           // wallpaper mode: bar above the list shows the current day
      const t = labels[want].textContent;
      if (bar.textContent !== t) bar.textContent = t;
      labels[0].classList.add('dl-top');
    }
    if (n !== area._dlLen || labels[0] !== area._dlFirst) {
      for (let i = 0; i < n; i++) labels[i].classList.toggle('dl-covered', i < want);   // list changed: redo all
    } else if (want !== area._dlN) {
      const a = Math.min(want, area._dlN), b = Math.max(want, area._dlN);
      for (let i = a; i < b && i < n; i++) labels[i].classList.toggle('dl-covered', i < want);
    }
    area._dlN = want; area._dlLen = n; area._dlFirst = labels[0];
  });
}

let _calScrollSpyPending = false;
function calScrollSpyCheck(area) {
  if (filterDate) return; // only meaningful in All-time mode
  if (!document.body.classList.contains('cal-sidebar-active')) return;
  if (_calScrollSpyPending) return;
  _calScrollSpyPending = true;
  requestAnimationFrame(() => {
    _calScrollSpyPending = false;
    const areaTop = area.getBoundingClientRect().top;
    const headers = area.querySelectorAll('.day-label[data-date]');
    let topHeader = null;
    for (const hdr of headers) {
      if (hdr.getBoundingClientRect().bottom >= areaTop) { topHeader = hdr; break; }
    }
    const key = topHeader?.dataset.date;
    if (key && key !== calActiveDate) {
      calActiveDate = key;
      const [y, m] = key.split('-').map(Number);
      calViewYear = y; calViewMonth = m - 1;
      renderCalendarWidget();
    }
  });
}

// ── Settings integration ────────────────────────────────────────────────────
function applyCalendarMode(enabled) {
  document.body.classList.toggle('cal-mode', enabled === true);
  updateCalSidebarVisibility();
}

function updateCalSidebarVisibility() {
  const onHistoryPanel = document.getElementById('panel-history')?.classList.contains('active');
  // Reading Mode always uses the calendar (a loaded file can span years — hundreds of pills were slow and clumsy)
  const onReading = !!document.getElementById('panel-readingmode')?.classList.contains('active') && _rmEntries.length > 0;
  const active = onReading || (document.body.classList.contains('cal-mode') && !!onHistoryPanel);
  _calTarget = onReading ? 'reading' : 'history';
  document.body.classList.toggle('rm-cal', onReading);
  document.body.classList.toggle('cal-sidebar-active', active);
  if (active) { renderCalendarWidget(); updateCalHourGridState(); }
  checkCalNarrow();
}

// ── Narrow-viewport auto-hide (< 1000px) ────────────────────────────────────
function checkCalNarrow() {
  const narrow = document.body.classList.contains('cal-sidebar-active') && window.innerWidth < 1250;
  document.body.classList.toggle('cal-narrow', narrow);
  if (!narrow) document.getElementById('calSidebar')?.classList.remove('cal-revealed');
}

function wireCalendarSidebar() {
  document.getElementById('calAllTimeBtn')?.addEventListener('click', calGoAllTime);
  document.getElementById('calPrevMonthBtn')?.addEventListener('click', () => calShiftMonth(-1));
  document.getElementById('calNextMonthBtn')?.addEventListener('click', () => calShiftMonth(1));
  document.getElementById('calMonthLabel')?.addEventListener('click', calOpenMonthPicker);
  document.getElementById('calYearLabel')?.addEventListener('click', calOpenYearPicker);
  document.getElementById('calPrevDayBtn')?.addEventListener('click', () => calShiftDay(-1));
  document.getElementById('calNextDayBtn')?.addEventListener('click', () => calShiftDay(1));
  // Right-click: Prev day → oldest day, Next day → newest day (same as the ‹ › arrows over the date pills)
  document.getElementById('calPrevDayBtn')?.addEventListener('contextmenu', (e) => { e.preventDefault(); calJumpEnd(true); });
  document.getElementById('calNextDayBtn')?.addEventListener('contextmenu', (e) => { e.preventDefault(); calJumpEnd(false); });

  buildCalHourGrid();
  renderCalendarWidget();

  // ── Narrow-viewport hover-reveal, suppressed while the extension's own
  // Chrome side panel (popup.html?sidebar=1) is open — see _extSidebarOpen. ──
  const sidebar = document.getElementById('calSidebar');
  const hoverZone = document.getElementById('calHoverZone');
  let _hideTimer = null;
  function reveal() {
    if (_extSidebarOpen) return; // suppressed — don't fight the side panel
    if (!document.body.classList.contains('cal-narrow')) return;
    clearTimeout(_hideTimer);
    sidebar?.classList.add('cal-revealed');
  }
  function scheduleHide() {
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => sidebar?.classList.remove('cal-revealed'), 350);
  }
  hoverZone?.addEventListener('mouseenter', reveal);
  sidebar?.addEventListener('mouseenter', () => clearTimeout(_hideTimer));
  sidebar?.addEventListener('mouseleave', scheduleHide);
  hoverZone?.addEventListener('mouseleave', () => {
    // Only schedule a hide if the cursor didn't just move onto the sidebar itself.
    setTimeout(() => { if (!sidebar?.matches(':hover')) scheduleHide(); }, 30);
  });

  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(checkCalNarrow, 150);
  });

  // Track the extension's Chrome side panel open/close state (set by popup.js)
  // so the hover-reveal above never fights it for the same screen edge.
  try {
    chrome.storage.local.get('eh_sidebar_open', r => { _extSidebarOpen = r?.eh_sidebar_open === true; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.eh_sidebar_open) _extSidebarOpen = changes.eh_sidebar_open.newValue === true;
    });
  } catch {}
}

// ── Toolbar ─────────────────────────────────────────────────────────────────
function setupToolbar() {
  const si       = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClearBtn');
  if (window.EhExpr) window.EhExpr.attach(si, () => doSearch());     // right-click the search box → Expression mode on/off

  function updateClearBtn() {
    clearBtn?.classList.toggle('visible', si.value.length > 0);
  }

  si.addEventListener('input', () => {
    updateClearBtn();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 260);
  });

  clearBtn?.addEventListener('click', () => {
    si.value = '';
    updateClearBtn();
    si.focus();
    doSearch();
  });

  document.getElementById('searchMode').addEventListener('change', doSearch);
  document.getElementById('dateFrom').addEventListener('change', () => { filterDate = null; updateHourPillsState(); doSearch(); });
  document.getElementById('dateTo').addEventListener('change', () => { filterDate = null; updateHourPillsState(); doSearch(); });

  // The input itself has pointer-events:none (see history.css) so it can't be
  // clicked into and typed over — the wrapper is what's actually clickable,
  // and just opens the native picker. showPicker() needs a user gesture and
  // isn't supported on every browser, so fall back to a focused click.
  const openDatePicker = (input) => {
    try { input.showPicker(); } catch { input.focus(); }
  };
  document.getElementById('dateFromBtn')?.addEventListener('click', () => openDatePicker(document.getElementById('dateFrom')));
  document.getElementById('dateToBtn')?.addEventListener('click', () => openDatePicker(document.getElementById('dateTo')));

  document.getElementById('deleteResultsBtn').addEventListener('click', deleteMatching);

  // "Export": saves only what the current search / filters / date range match
  document.getElementById('exportResultsBtn')?.addEventListener('click', exportMatching);
}

// Exports ONLY the entries the current search/filters match (all of them, not just the part loaded on screen),
// as the same .json format the normal export and Import use.
async function exportMatching() {
  const btn = document.getElementById('exportResultsBtn');
  if (!allResults.length) { toast(tr('no_results_export', 'No results to export'), 'err'); return; }
  const { query, mode, startDate, endDate, expr } = getFilters();
  const qf = (window.QuickFilters && window.QuickFilters.activePatterns && window.QuickFilters.activePatterns()) || null;
  const orig = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;
  try {
    const slim = (e) => { const o = { url: e.url, title: e.title || '', visitTime: e.visitTime, domain: e.domain }; if (e.rawUrl && e.rawUrl !== e.url) o.rawUrl = e.rawUrl; return o; };
    const seen = new Set(), blobs = [];
    let batch = [], n = 0;
    const add = (e) => { const k = historyDupKey(e); if (seen.has(k)) return; seen.add(k); batch.push(JSON.stringify(slim(e))); n++; if (batch.length >= 5000) { blobs.push(new Blob([(blobs.length ? ',' : '') + batch.join(',')])); batch = []; } };
    // everything the database holds for this search, page by page…
    const STEP = 4000, expCid = EH_CID + '_export';
    let expTok = 0;
    for (let offset = 0; ; ) {
      if (btn) btn.textContent = '⬇ ' + fmtNum(n);
      const r = await sendLong('SEARCH', { query, mode, startDate, endDate, offset, limit: STEP, qf, expr, noTotal: true, cid: expCid, token: ++expTok });
      const list = applyQuickFilterEntries(r.entries || []);
      for (const e of list) add(e);
      offset += (r.entries || []).length;
      if ((r.entries || []).length < STEP) break;
    }
    // …plus what is on screen but not in the database yet (today's live visits)
    for (const e of allResults) add(e);
    if (batch.length) blobs.push(new Blob([(blobs.length ? ',' : '') + batch.join(',')]));
    if (!n) { toast(tr('no_results_export', 'No results to export'), 'err'); return; }
    const meta = { exportedAt: new Date().toISOString(), totalEntries: n, search: { query, mode, from: startDate ? new Date(startDate).toISOString() : null, to: endDate ? new Date(endDate).toISOString() : null } };
    const head = JSON.stringify(meta).slice(0, -1) + ',"entries":[';
    let blob = new Blob([head, ...blobs, ']}'], { type: 'application/json' });
    const encOn = ehAlwaysEnc();
    if (encOn) blob = await ehEncryptBlobDH(blob, 'json');
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `extended-history_search_${new Date().toISOString().slice(0, 10)}${encOn ? '_enc' : ''}.json` });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 300000);
    toast(tr('export_results_done', 'Exported {0} matching entries', fmtNum(n)) + (encOn ? ' (' + tr('encrypted', 'encrypted') + ')' : ''), 'ok');
  } catch (err) {
    toast('Export failed: ' + (err.message || err), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ── Selection actions ────────────────────────────────────────────────────────
function setupSelActions() {
  document.getElementById('selAllBtn').addEventListener('click', () => {
    vsRendered.forEach(e => selected.add(e.id));
    selMode = true;
    updateSelBar();
    rerenderVisible();
  });

  document.getElementById('selNoneBtn').addEventListener('click', () => {
    exitSelMode();
  });

  document.getElementById('selDelBtn').addEventListener('click', () => deleteIds([...selected]));
}

function handleCheckClick(id) {
  if (selected.has(id)) { selected.delete(id); } else { selected.add(id); selMode = true; }
  if (selected.size === 0) exitSelMode();
  else { updateSelBar(); rerenderVisible(); }
}

function exitSelMode() {
  selMode = false;
  selected.clear();
  updateSelBar();
  rerenderVisible();
}

// ── Delete helpers ────────────────────────────────────────────────────────────
// Removes one entry from the in-memory list + DOM directly, without a full
// SEARCH round-trip. Used by deleteSingle() below so a single-row delete
// doesn't re-fetch (and re-render) the entire result set just to drop one row.
function removeEntryFromView(id) {
  const idx = allResults.findIndex(e => e.id === id);
  if (idx !== -1) allResults.splice(idx, 1);
  vsRendered = vsRendered.filter(e => e.id !== id);
  selected.delete(id);
  updateSelBar();

  const area = listArea();
  const row = area.querySelector(`.entry[data-id="${CSS.escape(id)}"]`);
  if (!row) return;

  const date = row.dataset.date;
  row.remove();
  vsOffset = Math.max(0, vsOffset - 1); // keep pagination in sync with the shrunk array

  // If that was the last entry for this date, drop the now-empty day header too.
  if (date && !area.querySelector(`.entry[data-date="${CSS.escape(date)}"]`)) {
    area.querySelector(`.day-label[data-date="${CSS.escape(date)}"]`)?.remove();
    dayLabelStickyCheck(area);
  }

  if (!allResults.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span><span>`+tr('no_history_found','No history found<')+`</span></div>`;
  }
}

async function deleteSingle(id) {
  const entry = allResults.find(e => e.id === id);
  const urls = entry ? [entry.url, entry.rawUrl].filter(Boolean) : [];

  // Optimistic UI: drop the row immediately rather than waiting on the
  // backend + a full re-search, which is what made this feel slow.
  removeEntryFromView(id);

  try {
    console.log('[EH] deleteSingle:', id, urls);
    const result = await sendLong('DELETE_IDS', { ids: [id], urls });
    console.log('[EH] deleteSingle response:', result);
    toast('Deleted', 'ok');
  } catch (err) {
    console.error('[EH] deleteSingle failed:', err);
    toast(err.message || 'Delete failed — see console for details', 'err');
    // We already removed it optimistically but the backend delete failed —
    // re-sync with what's actually in storage instead of leaving a stale view.
    await doSearch();
  }
}

// Does the actual DELETE_IDS call + urls lookup — shared by deleteIds() and
// deleteMatching() so both paths delete exactly the ids they were given,
// nothing derived/re-matched on the backend.
async function performDelete(ids) {
  const idSet = new Set(ids);
  const urls = allResults
    .filter(e => idSet.has(e.id))
    .flatMap(e => [e.url, e.rawUrl].filter(Boolean));
  return sendLong('DELETE_IDS', { ids, urls });
}

// ══ DELETE PROGRESS BUBBLE ══════════════════════════════════════════════════
// Bulk deletes (deleteIds / deleteMatching) can take a while — each URL is a
// separate chrome.history.deleteUrl() call on the backend, batched but not
// instant for thousands of entries. This gives visible feedback that
// something is actually happening instead of the UI looking frozen/idle.
let _deleteBubbleEl = null;
function showDeleteProgress(msg) {
  let el = _deleteBubbleEl;
  if (!el) {
    el = document.createElement('div');
    el.id = 'ehDeleteBubble';
    el.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:9999;' +
      'background:var(--surf2,#222);color:var(--text,#eee);border:1px solid var(--border,#444);' +
      'border-radius:20px;padding:8px 16px;font-size:0.8rem;font-weight:600;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.35);display:flex;align-items:center;gap:8px;' +
      'pointer-events:none;';
    el.innerHTML = '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;' +
      'background:#e0555a;animation:ehDeletePulse 1s ease-in-out infinite"></span>' +
      '<span id="ehDeleteBubbleText"></span>';
    if (!document.getElementById('ehDeletePulseStyle')) {
      const style = document.createElement('style');
      style.id = 'ehDeletePulseStyle';
      style.textContent = '@keyframes ehDeletePulse{0%,100%{opacity:1}50%{opacity:0.35}}';
      document.head.appendChild(style);
    }
    document.body.appendChild(el);
    _deleteBubbleEl = el;
  }
  document.getElementById('ehDeleteBubbleText').textContent = msg;
  el.style.display = 'flex';
}
function hideDeleteProgress() {
  if (_deleteBubbleEl) _deleteBubbleEl.style.display = 'none';
}

async function deleteIds(ids) {
  console.log('[EH] deleteIds called with', ids.length, 'ids:', ids);
  if (!ids.length) { toast('Nothing selected', 'err'); return; }
  const ok = confirm(`Delete ${fmtNum(ids.length)} item${ids.length !== 1 ? 's' : ''}?`);
  console.log('[EH] confirm() returned:', ok);
  if (!ok) return;
  showDeleteProgress(`Deleting ${fmtNum(ids.length)} item${ids.length !== 1 ? 's' : ''}…`);
  try {
    const result = await performDelete(ids);
    console.log('[EH] DELETE_IDS response:', result);
    exitSelMode();
    // Re-fetch from the backend — see note in deleteSingle above.
    await doSearch();
    toast(`Deleted ${fmtNum(ids.length)} items`, 'ok');
    console.log('[EH] deleteIds finished, UI refreshed from backend');
  } catch (err) {
    console.error('[EH] deleteIds failed:', err);
    toast(err.message || 'Delete failed — see console for details', 'err');
  } finally {
    hideDeleteProgress();
  }
}

// Deletes every entry currently in allResults — i.e. exactly what's on
// screen after search text + quick filter + date range have all been
// applied. IMPORTANT: this used to re-derive "what matches" on the backend
// from the search query/date range alone (DELETE_MATCHING), which had no
// idea a Quick Filter was active (quick filters are applied client-side,
// on top of the search results — see applyQuickFilterEntries() in
// quick-filters.js). With an active quick filter and an empty search box,
// that backend match was effectively unfiltered and deleted the entire
// history, even though the confirm dialog (correctly, from allResults.length)
// said only the filtered count. Deleting the exact ids in allResults instead
// guarantees the delete always matches what the confirm dialog told you.
async function deleteMatching() {
  if (!allResults.length) { toast('No results to delete'); return; }
  const { startDate, endDate } = getFilters();

  // Check if "all time" is selected (no date filters)
  const isAllTime = !startDate && !endDate;
  const confirmMsg = isAllTime 
   ? _ehMsg("confirm_delete_all_time", fmtNum(allResults.length))
  : _ehMsg("confirm_delete_filtered", fmtNum(allResults.length));
  
  if (!confirm(confirmMsg)) return;

  const ids = allResults.map(e => e.id);
  showDeleteProgress(`Deleting ${fmtNum(ids.length)} item${ids.length !== 1 ? 's' : ''}…`);
  try {
    await performDelete(ids);
    exitSelMode();
    await doSearch();
    toast(`Deleted ${fmtNum(ids.length)} items`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    hideDeleteProgress();
  }
}

// ══ ACTIVITY ════════════════════════════════════════════════════════════════
async function loadActivity() {
  try {
    const s    = await sendLong('GET_STATS');
    const key  = new Date().toLocaleDateString('en-CA');
    const todayCt = s.dailyActivity?.[key] || 0;
    document.getElementById('actKpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="total_visits">Total visits</div><div class="kpi-val">${fmtNum(s.totalEntries)}</div></div>
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="today">Today</div><div class="kpi-val">${fmtNum(todayCt)}</div></div>
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="storage">Storage</div><div class="kpi-val sm">${s.storageMB} MB</div></div>
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="since">Since</div><div class="kpi-val sm">${s.oldestEntry ? new Date(s.oldestEntry).toLocaleDateString(undefined, { month:'short', year:'numeric' }) : '—'}</div></div>
    `;
    // Reapply translations to dynamically added content
    if (typeof window.applyTranslations === 'function') window.applyTranslations();
    drawLineChart(s.dailyActivity);
    drawBarChart(s.dailyActivity);
  } catch (err) { console.error(err); }
  loadHourlyAvg();   // separate: scans all history, must not delay the charts above
}

// Positions a chart tooltip next to the cursor, flipping it to the left of the cursor when it would stick out
// past the right edge of the chart (content must already be set so the width is known).
function placeChartTip(tip, wrap, ev) {
  const r = wrap.getBoundingClientRect();
  tip.style.display = 'block';
  const w = tip.offsetWidth, cx = ev.clientX - r.left;
  let x = cx + 14;
  if (x + w > r.width) x = cx - 14 - w;
  tip.style.left = Math.max(0, x) + 'px';
  tip.style.top  = `${ev.clientY - r.top - 38}px`;
}

// Average visits per hour of the day (0–23, local time), over the whole history.
async function loadHourlyAvg() {
  try {
    const r = await sendLong('GET_HOURLY_AVG');
    if (r && !r.error) drawHourlyChart(r.avg, r.days);
  } catch (err) { console.error(err); }
}
function drawHourlyChart(avg, days) {
  const svg = document.getElementById('hourlySvg');
  if (!svg) return;
  const tip = document.getElementById('hourlyTip'), wrap = svg.parentElement;
  const W = wrap.clientWidth || 860, H = 170;
  const p = { t: 18, r: 12, b: 26, l: 46 };
  const iW = W - p.l - p.r, iH = H - p.t - p.b;
  const vals = Array.from({ length: 24 }, (_, h) => (avg && avg[h]) || 0);
  const hasData = vals.some(v => v > 0);
  const maxV = Math.max(...vals, 0.1), curH = new Date().getHours();   // highlight the hour we are in now
  const fmt = v => v >= 10 ? String(Math.round(v)) : v.toFixed(1);

  let grid = '';
  for (let i = 0; i <= 3; i++) {
    const y = p.t + (i / 3) * iH;
    grid += `<line class="grid-ln" x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="ax-lbl" font-size="9" x="${p.l - 5}" y="${y + 3}" text-anchor="end">${fmt(maxV * (1 - i / 3))}</text>`;
  }
  const slot = iW / 24, bw = Math.max(3, Math.min(28, slot * 0.7));
  let bars = '';
  vals.forEach((v, h) => {
    const bh = Math.max(v > 0 ? 2 : 0, (v / maxV) * iH);
    const x = p.l + slot * h + (slot - bw) / 2, y = p.t + iH - bh;
    const lbl = `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`;
    bars += `<rect class="hr-bar" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="2" fill="var(--accent)" fill-opacity="${h === curH ? 1 : 0.6}" data-h="${lbl}" data-v="${v.toFixed(1)}"/>`;
    bars += `<text class="ax-lbl" font-size="${slot < 18 ? 8 : 9}" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${h}h</text>`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = grid + bars + (hasData ? '' : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="var(--text3)" font-family="var(--font-mono)">No data yet</text>`);

  svg.querySelectorAll('.hr-bar').forEach(bar => {
    bar.addEventListener('mousemove', ev => {
      tip.innerHTML = `<b>${bar.dataset.h}</b> — ${bar.dataset.v} ${tr('visits_per_day','visits / day')}`;
      placeChartTip(tip, wrap, ev);
    });
    bar.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// Hover for a smooth line chart: the pointer snaps to the nearest data point, a dot + guide line
// appear on it and the tooltip shows its label. points = [{x, y, text}] in SVG viewBox coordinates.
function attachLineHover(svg, wrap, tip, points, color, onClick) {
  if (!points.length) return;
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('pointer-events', 'none');
  g.style.display = 'none';
  const guide = document.createElementNS(NS, 'line');
  guide.setAttribute('stroke', color); guide.setAttribute('stroke-opacity', '0.35'); guide.setAttribute('stroke-dasharray', '3 3');
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', '5'); dot.setAttribute('fill', color); dot.setAttribute('stroke', 'var(--bg)'); dot.setAttribute('stroke-width', '2');
  g.append(guide, dot);
  svg.appendChild(g);

  const vb = svg.viewBox.baseVal;
  const nearest = ev => {
    const r = svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (vb.width / (r.width || 1));
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m].x <= x) lo = m; else hi = m; }
    return Math.abs(points[lo].x - x) <= Math.abs(points[hi].x - x) ? lo : hi;
  };
  let cur = -1;
  svg.style.cursor = onClick ? 'pointer' : 'default';
  // The same <svg> is redrawn many times: drop the previous redraw's listeners first
  if (svg._ehHover) { svg.removeEventListener('mousemove', svg._ehHover.move); svg.removeEventListener('mouseleave', svg._ehHover.leave); svg.removeEventListener('click', svg._ehHover.click); }
  const move = ev => {
    cur = nearest(ev);
    const pt = points[cur];
    guide.setAttribute('x1', pt.x); guide.setAttribute('x2', pt.x);
    guide.setAttribute('y1', pt.top); guide.setAttribute('y2', pt.bottom);
    dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
    g.style.display = '';
    tip.innerHTML = pt.text;
    placeChartTip(tip, wrap, ev);
  };
  const leave = () => { g.style.display = 'none'; tip.style.display = 'none'; cur = -1; };
  const click = () => { if (onClick && cur >= 0) onClick(points[cur]); };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', leave);
  svg.addEventListener('click', click);
  svg._ehHover = { move, leave, click };
}

function drawLineChart(daily) {
  const wrap = document.getElementById('lineWrap');
  const svg  = document.getElementById('lineSvg');
  const tip  = document.getElementById('lineTip');
  const W    = wrap.clientWidth || 900;
  const H    = 160;
  const p    = { t: 14, r: 12, b: 4, l: 44 };
  const iW   = W - p.l - p.r, iH = H - p.t - p.b;

  const entries = Object.entries(daily);
  const vals    = entries.map(e => e[1]);
  const maxV = vals.reduce((a, b) => b > a ? b : a, 1);

  const xOf = i => p.l + (i / (entries.length - 1)) * iW;
  const yOf = v => p.t + (1 - v / maxV) * iH;

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = p.t + (i / 4) * iH;
    const v = Math.round(maxV * (1 - i / 4));
    grid += `<line class="grid-ln" x1="${p.l}" x2="${W-p.r}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="ax-lbl" font-size="9" x="${p.l-5}" y="${y+3}" text-anchor="end">${v}</text>`;
  }

  let path = `M ${xOf(0)} ${yOf(vals[0])}`;
  for (let i = 1; i < entries.length; i++) {
    const cx = (xOf(i-1) + xOf(i)) / 2;
    path += ` C ${cx} ${yOf(vals[i-1])}, ${cx} ${yOf(vals[i])}, ${xOf(i)} ${yOf(vals[i])}`;
  }
  const area = path + ` L ${xOf(entries.length-1)} ${H} L ${xOf(0)} ${H} Z`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = `
  <defs>
  <linearGradient id="lg1" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
  <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
  </linearGradient>
  </defs>
  ${grid}
  <path d="${area}" fill="url(#lg1)"/>
  <path class="c-path" d="${path}" stroke="var(--accent)"/>`;

  attachLineHover(svg, wrap, tip,
    entries.map(([date, v], i) => ({ x: xOf(i), y: yOf(v), top: p.t, bottom: p.t + iH, date, text: `<b>${esc(date)}</b> — ${fmtNum(v)} ${tr('visits', 'visits')}` })),
    'var(--accent)', pt => { activateDatePill(pt.date); switchPanel('history'); });

  const lblEl = document.getElementById('lineLabels');
  lblEl.innerHTML = entries.map(([date], i) => {
    const lbl = (i % 14 === 0) ? new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '';
    return `<div style="flex:1;text-align:center;font-size:0.58rem;color:var(--text3);font-family:var(--font-mono);overflow:hidden">${lbl}</div>`;
  }).join('');
}

function drawBarChart(daily) {
  const entries = Object.entries(daily).slice(-30);
  const vals    = entries.map(e => e[1]);
  const maxV = vals.reduce((a, b) => b > a ? b : a, 1);

  document.getElementById('bar30Wrap').innerHTML = entries.map(([date, v]) => {
    const h   = Math.max((v / maxV) * 100, v > 0 ? 3 : 0);
    const lbl = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    return `<div class="b30-col" data-date="${date}" title="${date}: ${v} visits">
    <div class="b30-hover-label">${v}</div>
    <div class="b30-bar" style="height:${h}%"></div>
    </div>`;
  }).join('');

  document.getElementById('bar30Dates').innerHTML = entries.map(([date]) => {
    const d = new Date(date + 'T12:00:00');
    return `<div class="b30-date">${d.toLocaleDateString(undefined, { month:'numeric', day:'numeric' })}</div>`;
  }).join('');

  document.querySelectorAll('.b30-col').forEach(col => {
    col.addEventListener('click', () => { activateDatePill(col.dataset.date); switchPanel('history'); });
  });
}

// ══ TIME SPENT ══════════════════════════════════════════════════════════════
let curTimeDays = 15;

// ── Time Spent: date-arrow / "Today" single-day state ──────────────────────────
// null = not yet touched this session — falls back to today wherever it's read.
let tsSelectedDate = null;
function tsToday() { return new Date().toLocaleDateString('en-CA'); }
function tsUpdateDateLabel() {
  const el = document.getElementById('tsDateLabel');
  if (!el) return;
  const d = new Date((tsSelectedDate || tsToday()) + 'T12:00:00');
  el.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function tsStepDate(delta) {
  const d = new Date((tsSelectedDate || tsToday()) + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  loadTimeSpent(1, d.toLocaleDateString('en-CA'));
}
document.getElementById('tsPrevDay')?.addEventListener('click', () => tsStepDate(-1));
document.getElementById('tsNextDay')?.addEventListener('click', () => tsStepDate(1));
tsUpdateDateLabel();

async function loadTimeSpent(days, dateOverride) {
  curTimeDays = days;
  if (days === 1) {
    // "Today" pill and the date arrows both funnel through here with an explicit
    // date: the pill always passes today's date (so pressing it resets the view
    // even if you'd arrowed off to some other day), the arrows pass the
    // stepped-to date. Falls back to today only if neither ever ran yet.
    tsSelectedDate = dateOverride || tsSelectedDate || tsToday();
  } else {
    // Leaving single-day mode for a rolling range — clear it so the arrows start
    // fresh from today next time, instead of resuming from a stale, possibly
    // long-forgotten date.
    tsSelectedDate = null;
  }
  document.querySelectorAll('.tf-btn').forEach(b =>
  b.classList.toggle('active', parseInt(b.dataset.days) === days));
  tsUpdateDateLabel();
  // "Daily browsing time" is a multi-day trend chart — meaningless for a single day,
  // so hide it in Today/date-arrow mode and only show "Top sites by time spent".
  const dailyCard = document.getElementById('dailyChartCard');
  if (dailyCard) dailyCard.style.display = (days === 1) ? 'none' : '';
  try {
    await send('FLUSH_TIME');
    const r = await send('GET_TIME_DATA', days === 1 ? { days: 1, date: tsSelectedDate } : { days });
    if (days !== 1) drawTimeChart(r.dailyMap, days);
    renderHbars(r.topSites);
    drawPie(r.topSites);
    // One day selected → all-time weekday averages. 7/15/30/90 days → averages over just those days.
    const wdTitle = document.getElementById('weekdayTitle');
    if (days === 1) {
      if (wdTitle) { wdTitle.setAttribute('data-i18n-key', 'avg_time_per_weekday'); wdTitle.textContent = tr('avg_time_per_weekday', 'Average time per weekday (all time)'); }
      drawWeekdayChart(r.weekdayAvg, r.weekdayDays);
    } else {
      if (wdTitle) { wdTitle.setAttribute('data-i18n-key', 'avg_time_per_weekday_range'); wdTitle.textContent = tr('avg_time_per_weekday_range', 'Average time per weekday (last {0} days)').replace("{0}",days); }
      const wd = weekdayAvgForRange(r.dailyMap, days);
      drawWeekdayChart(wd.avg, wd.counts);
    }
  } catch (err) { console.error(err); }
}

document.getElementById('timeFilters').addEventListener('click', ev => {
  const btn = ev.target.closest('.tf-btn');
  if (!btn) return;
  const days = parseInt(btn.dataset.days);
  loadTimeSpent(days, days === 1 ? tsToday() : undefined);
});

// Average browsing time per weekday (index = Date.getDay()) over the last `days` calendar days,
// from the per-day totals already loaded for the range. Days without data count as 0.
function weekdayAvgForRange(dailyMap, days) {
  const sum = [0,0,0,0,0,0,0], counts = [0,0,0,0,0,0,0], now = Date.now();
  for (let i = 0; i < days; i++) {
    const dt = new Date(now - i * 86400000);
    const dm = (dailyMap || {})[dt.toLocaleDateString('en-CA')] || {};
    sum[dt.getDay()] += Object.values(dm).reduce((s, v) => s + v, 0);
    counts[dt.getDay()]++;
  }
  return { avg: sum.map((s, d) => counts[d] ? s / counts[d] : 0), counts };
}

function drawTimeChart(dailyMap, days, anchorDate) {
  const svg  = document.getElementById('timeSvg');
  const tip  = document.getElementById('timeTip');
  const wrap = svg.parentElement;
  const W    = wrap.clientWidth || 860;
  const H    = 130;
  const p    = { t: 12, r: 12, b: 4, l: 46 };
  const iW   = W - p.l - p.r, iH = H - p.t - p.b;

  // In single-day ("Today"/date-arrow) mode, anchor on the selected date rather
  // than "now", so the one point shown lines up with dailyMap's actual key.
  const now   = anchorDate ? new Date(anchorDate + 'T12:00:00').getTime() : Date.now();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(new Date(now - i * 86400000).toLocaleDateString('en-CA'));

  const vals = dates.map(d => {
    const dm = dailyMap[d] || {};
    return Math.round(Object.values(dm).reduce((s, v) => s + v, 0) / 60000);
  });

  const maxV = Math.max(...vals, 1);
  const xOf  = i => p.l + (i / Math.max(dates.length - 1, 1)) * iW;
  const yOf  = v => p.t + (1 - v / maxV) * iH;

  let grid = '';
  for (let i = 0; i <= 3; i++) {
    const y   = p.t + (i / 3) * iH;
    const val = Math.round(maxV * (1 - i / 3));
    const lbl = val >= 60 ? `${Math.round(val/60)}h` : `${val}m`;
    grid += `<line class="grid-ln" x1="${p.l}" x2="${W-p.r}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="ax-lbl" font-size="9" x="${p.l-5}" y="${y+3}" text-anchor="end">${lbl}</text>`;
  }

  let path = '', area = '';
  if (vals.some(v => v > 0)) {
    path = `M ${xOf(0)} ${yOf(vals[0])}`;
    for (let i = 1; i < dates.length; i++) {
      const cx = (xOf(i-1) + xOf(i)) / 2;
      path += ` C ${cx} ${yOf(vals[i-1])}, ${cx} ${yOf(vals[i])}, ${xOf(i)} ${yOf(vals[i])}`;
    }
    area = path + ` L ${xOf(dates.length-1)} ${H} L ${xOf(0)} ${H} Z`;
  }

  const gap = days <= 15 ? 2 : days <= 30 ? 4 : 9;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = `
  <defs>
  <linearGradient id="lg2" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0%" stop-color="var(--accent2)" stop-opacity="0.3"/>
  <stop offset="100%" stop-color="var(--accent2)" stop-opacity="0"/>
  </linearGradient>
  </defs>
  ${grid}
  ${area ? `<path d="${area}" fill="url(#lg2)"/>` : ''}
  ${path ? `<path class="c-path" d="${path}" stroke="var(--accent2)"/>` : `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12" fill="var(--text3)" font-family="var(--font-mono)">No time data yet</text>`}`;

  if (path) attachLineHover(svg, wrap, tip,
    dates.map((d, i) => { const v = vals[i]; return { x: xOf(i), y: yOf(v), top: p.t, bottom: p.t + iH, text: `<b>${esc(d)}</b> — ${v >= 60 ? (v / 60).toFixed(1) + 'h' : v + 'm'}` }; }),
    'var(--accent2)');

  const lblEl = document.getElementById('timeLabels');
  lblEl.innerHTML = dates.map((d, i) => {
    const lbl = (i % gap === 0) ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '';
    return `<div style="flex:1;text-align:center;font-size:0.57rem;color:var(--text3);font-family:var(--font-mono);overflow:hidden">${lbl}</div>`;
  }).join('');
}

// Average hours spent browsing on each weekday, over all stored time data (Mon → Sun).
// avgMs / dayCounts are indexed like Date.getDay() (0 = Sunday); DAYS holds the translated names.
function drawWeekdayChart(avgMs, dayCounts) {
  const svg  = document.getElementById('weekdaySvg');
  if (!svg) return;
  const tip  = document.getElementById('weekdayTip');
  const wrap = svg.parentElement;
  const W = wrap.clientWidth || 860, H = 170;
  const p = { t: 18, r: 12, b: 26, l: 46 };
  const iW = W - p.l - p.r, iH = H - p.t - p.b;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const vals = order.map(d => ((avgMs && avgMs[d]) || 0) / 3600000);       // hours
  const hasData = vals.some(v => v > 0);
  const maxV = Math.max(...vals, 0.1);
  const maxI = vals.indexOf(Math.max(...vals));
  const fmt = h => h.toFixed(1) + 'h';

  let grid = '';
  for (let i = 0; i <= 3; i++) {
    const y = p.t + (i / 3) * iH;
    grid += `<line class="grid-ln" x1="${p.l}" x2="${W - p.r}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="ax-lbl" font-size="9" x="${p.l - 5}" y="${y + 3}" text-anchor="end">${fmt(maxV * (1 - i / 3))}</text>`;
  }

  const slot = iW / 7, bw = Math.min(56, slot * 0.6);
  let bars = '';
  order.forEach((d, i) => {
    const v = vals[i], h = Math.max(v > 0 ? 2 : 0, (v / maxV) * iH);
    const x = p.l + slot * i + (slot - bw) / 2, y = p.t + iH - h;
    const n = (dayCounts && dayCounts[d]) || 0;
    bars += `<rect class="wd-bar" x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="var(--accent2)" fill-opacity="${hasData && i === maxI ? 1 : 0.6}" data-d="${esc(DAYS[d])}" data-lbl="${fmt(v)}" data-n="${n}"/>`;
    if (v > 0) bars += `<text font-size="10" font-weight="600" x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" fill="var(--text2)">${fmt(v)}</text>`;
    bars += `<text class="ax-lbl" font-size="10" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(DAYS[d])}</text>`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = grid + bars + (hasData ? '' : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12" fill="var(--text3)" font-family="var(--font-mono)">No time data yet</text>`);

  svg.querySelectorAll('.wd-bar').forEach(bar => {
    bar.addEventListener('mousemove', ev => {
      tip.innerHTML = `<b>${bar.dataset.d}</b> — ${bar.dataset.lbl} <span style="opacity:.6">(${bar.dataset.n} ${tr('days','days')})</span>`;
      placeChartTip(tip, wrap, ev);
    });
    bar.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

function renderHbars(topSites) {
  const el = document.getElementById('hbarList');
  if (!topSites?.length) {
    el.innerHTML = '<div class="state-msg" style="padding:20px 0"><span class="state-msg-icon">⏱</span>No time data yet. Keep browsing!</div>';
    return;
  }
  const maxM = topSites[0]?.minutes || 1;
  el.innerHTML = topSites.map(s => {
    const pct = (s.minutes / maxM) * 100;
    const lbl = parseFloat(s.hours) >= 1 ? `${s.hours}h` : `${s.minutes}m`;
    return `<div class="hbar-row">
    <div class="hbar-header">
    <div class="hbar-domain">
    <img class="hbar-fav hbar-fav-img" src="${favUrl(s.domain)}" loading="lazy"/>
    ${esc(s.domain)}
    </div>
    <div class="hbar-time">${lbl}</div>
    </div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');

  el.querySelectorAll('.hbar-fav-img').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });
}

function drawPie(topSites) {
  const svg    = document.getElementById('pieSvg');
  const legend = document.getElementById('pieLegend');
  if (!topSites?.length || !topSites.some(s => s.minutes > 0)) {
    svg.innerHTML = `<text x="80" y="87" text-anchor="middle" fill="var(--text3)" font-size="12" font-family="var(--font-mono)">No data</text>`;
    legend.innerHTML = '';
    return;
  }

  const top6 = topSites.slice(0, 6);
  const total = top6.reduce((s, x) => s + x.minutes, 0);
  const cx = 80, cy = 80, R = 70, r = 32;
  let ang = -Math.PI / 2;
  let paths = '', legHtml = '';

  top6.forEach((s, i) => {
    const sweep  = (s.minutes / total) * 2 * Math.PI;
    const end    = ang + sweep;
    const large  = sweep > Math.PI ? 1 : 0;
    const color  = PIE_COLORS[i % PIE_COLORS.length];
    const pct    = Math.round((s.minutes / total) * 100);
    const lbl    = parseFloat(s.hours) >= 1 ? `${s.hours}h` : `${s.minutes}m`;

    const x1 = cx + R * Math.cos(ang),  y1 = cy + R * Math.sin(ang);
    const x2 = cx + R * Math.cos(end),  y2 = cy + R * Math.sin(end);
    const ix1 = cx + r * Math.cos(end), iy1 = cy + r * Math.sin(end);
    const ix2 = cx + r * Math.cos(ang), iy2 = cy + r * Math.sin(ang);

    paths += `<path class="pie-slice" d="M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${r} ${r} 0 ${large} 0 ${ix2} ${iy2} Z" fill="${color}" stroke="var(--bg)" stroke-width="2"><title>${s.domain}: ${lbl} (${pct}%)</title></path>`;
    legHtml += `<div class="pie-leg-item"><div class="pie-leg-dot" style="background:${color}"></div><div class="pie-leg-name">${esc(s.domain)}</div><div class="pie-leg-val">${lbl} · ${pct}%</div></div>`;
    ang = end;
  });

  const totalLbl = (total / 60).toFixed(1);
  paths += `<text x="${cx}" y="${cy - 5}" text-anchor="middle" fill="var(--text)" font-size="16" font-weight="700">${totalLbl}h</text>`;
  paths += `<text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="var(--text3)" font-size="9" font-family="var(--font-mono)">TOTAL</text>`;

  svg.innerHTML = paths;
  legend.innerHTML = legHtml;
}

// ══ SESSIONS ═══════════════════════════════════════════════════════════════
async function loadSessions() {
  const el = document.getElementById('sessionsContent');
  el.innerHTML = '<div class="state-msg" style="color:var(--text3);font-size:0.85rem" data-i18n-key="loading">Loading…</div>';
  try {
    const { sessions, current } = await send('GET_SESSIONS');

    if (!sessions.length && !current) {
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📋</span><span data-i18n-key="no_sessions_yet">No sessions recorded yet</span></div>';
      return;
    }

    el.innerHTML = '';

    function buildSessionCard(dateLabel, badgeText, tabsArr, sessRef) {
      const card = document.createElement('div');
      card.className = 'session-card';

      const head = document.createElement('div');
      head.className = 'sess-head';

      const headLeft = document.createElement('div');
      headLeft.className = 'sess-head-left';

      if (badgeText) {
        const badge = document.createElement('span');
        badge.className   = 'sess-badge';
        badge.textContent = badgeText;
        headLeft.appendChild(badge);
      }

      const info = document.createElement('div');
      const dateEl = document.createElement('div');
      dateEl.className   = 'sess-date';
      dateEl.textContent = dateLabel.main;
      const durEl = document.createElement('div');
      durEl.className   = 'sess-dur';
      durEl.textContent = dateLabel.sub;
      info.appendChild(dateEl);
      info.appendChild(durEl);
      headLeft.appendChild(info);

      const tabCount = document.createElement('span');
      tabCount.className   = 'sess-tab-count';
      tabCount.textContent = `${tabsArr.length+' '+tr('tabs','tabs')}`;

      const exportBtn = document.createElement('button');
      exportBtn.className   = 'tb-btn';
      exportBtn.textContent = tr('export','Export');
      exportBtn.setAttribute('data-i18n-key', 'export');
      exportBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;flex-shrink:0;margin-right:4px';
      exportBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        send('GET_TAB_STORAGE').then(function(r){exportSessionAsHtml(dateLabel.main, tabsArr, r.entries||[]);}).catch(function(){exportSessionAsHtml(dateLabel.main, tabsArr, []);});
      });

      // Restore button — only for past sessions (not current)
      if (!badgeText) {
        const restoreBtn = document.createElement('button');
        restoreBtn.className   = 'tb-btn';
        restoreBtn.textContent = '↺ ' + (_ehMsg('restore') || 'Restore');
        restoreBtn.setAttribute('data-i18n-key', 'restore');
        restoreBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;flex-shrink:0;margin-right:4px;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)';
        restoreBtn.addEventListener('click', async ev => {
          ev.stopPropagation();
          const urls = tabsArr.filter(t => t.url).map(t => t.url);
          if (urls.length > 20 && !confirm(tr('confirm_restore_tabs', 'Restore {0} tabs?', urls.length))) return;
          try {
            const r = await send('RESTORE_SESSION', { tabs: tabsArr });
            const n = (r && r.restored != null) ? r.restored : urls.length;
            const w = (r && r.windows) || 1;
            toast(w > 1
              ? tr('restored_tabs_windows', 'Restored {0} tabs in {1} windows', n, w)
              : tr('restored_tabs_window', 'Restored {0} tabs in a new window', n), 'ok');
          } catch(err) { toast(err.message, 'err'); }
        });
        head.appendChild(restoreBtn); // will be inserted before toggle below
      }

      const toggle = document.createElement('span');
      toggle.className   = 'sess-toggle';
      toggle.textContent = '▶';

      head.appendChild(headLeft);
      head.appendChild(tabCount);
      head.appendChild(exportBtn);
      // restoreBtn already appended conditionally above
      head.appendChild(toggle);

      const tabsEl = document.createElement('div');
      tabsEl.className = 'sess-tabs';

      // Group tabs by windowId if multiple windows present
      const windowIds = [...new Set(tabsArr.map(t => t.windowId).filter(Boolean))];
      const hasMultiWindow = windowIds.length > 1;

      if (hasMultiWindow) {
        // Group tabs by window
        const windowMap = new Map();
        for (const t of tabsArr) {
          const wid = t.windowId || 'unknown';
          if (!windowMap.has(wid)) windowMap.set(wid, []);
          windowMap.get(wid).push(t);
        }
        let winIndex = 1;
        for (const [wid, winTabs] of windowMap) {
          const winHeader = document.createElement('div');
          winHeader.className = 'sess-window-header';
          winHeader.textContent = `Window ${winIndex} — ${winTabs.length} tab${winTabs.length !== 1 ? 's' : ''}`;
          tabsEl.appendChild(winHeader);
          winTabs.slice(0, 200).forEach(t => tabsEl.appendChild(buildSessTabEl(t)));
          winIndex++;
        }
      } else {
        tabsArr.slice(0, 200).forEach(t => tabsEl.appendChild(buildSessTabEl(t)));
      }

      head.addEventListener('click', ev => {
        if (ev.target === exportBtn) return;
        const open = tabsEl.classList.toggle('open');
        toggle.classList.toggle('open', open);
      });

      // Right-click a past session → Delete (with confirmation). The active session can't be deleted.
      if (sessRef) card.addEventListener('contextmenu', ev => {
        ev.preventDefault(); ev.stopPropagation();
        showSessCtxMenu(ev.clientX, ev.clientY, sessRef, dateLabel.main, card);
      });

      card.appendChild(head);
      card.appendChild(tabsEl);
      return card;
    }

    if (current) {
      const dur = fmtDuration(Date.now() - current.start);
      el.appendChild(buildSessionCard(
        { main: _ehMsg("current_session"), sub: `Started ${timeAgo(current.start)} · ${dur}` },
                                      _ehMsg("active"), current.tabs
      ));
    }
    
    sessions.forEach(sess => {
      const dur  = fmtDuration(sess.end - sess.start);
      const date = new Date(sess.start).toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      el.appendChild(buildSessionCard(
        { main: date, sub: `${dur} · ${sess.tabCount+' '+tr('unique_tabs','unique tabs')}` },
        null, sess.tabs, { id: sess.id, start: sess.start }
      ));
    });

  } catch (err) {
    el.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

function buildSessTabEl(t) {
  const dom = tryDomain(t.url || '');

  const row = document.createElement('div');
  row.className = 'sess-tab-row';
  row.addEventListener('click', () => chrome.tabs.create({ url: t.url, active: false }));

  const img = document.createElement('img');
  img.className = 'sess-fav';
  setFavicon(img, dom);
  img.loading   = 'lazy';
  img.addEventListener('error', () => { img.style.opacity = '0'; });

  const body = document.createElement('div');
  body.className = 'sess-tbody';

  const title = document.createElement('div');
  title.className   = 'sess-title';
  title.textContent = t.title || t.url;

  const url = document.createElement('div');
  url.className   = 'sess-url';
  url.textContent = t.url;

  body.appendChild(title);
  body.appendChild(url);
  row.appendChild(img);
  row.appendChild(body);
  return row;
}



// ══ TAB STORAGE ══════════════════════════════════════════════════════════════
async function loadTabStorage() {
  const el = document.getElementById('tabStorageContent');
  if (!el) return;
  // The actual scrollable container is .panel-scroll (parent of tabStorageContent)
  const scrollEl = el.closest('.panel-scroll');
  const prevScroll = scrollEl ? scrollEl.scrollTop : 0;
  el.innerHTML = '<div class="state-msg" style="color:var(--text3);font-size:0.85rem">Loading…</div>';
  try {
    const { entries } = await send('GET_TAB_STORAGE');
    if (!entries || !entries.length) {
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📑</span>'+tr('no_stored_tabs','No stored tabs yet.')+'<br><small style="color:var(--text3)">'+tr('store_tab_hint','Right-click any page → Extended History → Store this tab</small></div>');
      return;
    }
    el.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'ts-header';
    const countEl = document.createElement('span');
    countEl.className = 'ts-count';
    countEl.textContent = `${entries.length} stored tab${entries.length !== 1 ? 's' : ''}`;
    const clearBtn = document.createElement('button');
    clearBtn.className = 'tb-btn';
    clearBtn.textContent = '🗑 '+tr('clear_all','Clear all');
    clearBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,transparent)';
    clearBtn.addEventListener('click', async () => {
      if (!confirm(`Clear all ${entries.length} stored tabs?`)) return;
      await send('CLEAR_TAB_STORAGE');
      toast('Tab storage cleared', 'ok');
      loadTabStorage();
    });
    const restoreAllBtn = document.createElement('button');
    restoreAllBtn.className = 'tb-btn';
    restoreAllBtn.textContent = '↺ '+tr('restore_all','Restore all');
    restoreAllBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)';
    restoreAllBtn.addEventListener('click', async () => {
      if (entries.length > 15 && !confirm(`Open all ${entries.length} stored tabs?`)) return;
      // Hand off to background: clears storage + opens tabs with stagger
      const urls = entries.map(e => e.url).filter(Boolean);
      await send('RESTORE_TAB_STORAGE_ENTRIES', { ids: entries.map(e => e.id), urls });
      toast(`Restoring ${entries.length} tab${entries.length !== 1 ? 's' : ''}…`, 'ok');
      loadTabStorage();
    });
    header.appendChild(countEl);
    header.appendChild(clearBtn);
    header.appendChild(restoreAllBtn);
    el.appendChild(header);
    const list = document.createElement('div');
    list.className = 'ts-list';
    for (const entry of entries) {
      const dom = tryDomain(entry.url);
      const row = document.createElement('div');
      row.className = 'ts-row';
      row.title = entry.url;
      const fav = document.createElement('img');
      fav.className = 'ts-fav';
      setFavicon(fav, dom);
      fav.loading = 'lazy';
      fav.addEventListener('error', () => { fav.style.opacity = '0'; });
      const body = document.createElement('div');
      body.className = 'ts-body';
      const title = document.createElement('div');
      title.className = 'ts-title';
      title.textContent = entry.title || entry.url;
      const meta = document.createElement('div');
      meta.className = 'ts-meta';
      meta.textContent = dom + ' · Saved ' + timeAgo(entry.savedAt);
      body.appendChild(title);
      body.appendChild(meta);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'tb-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove from storage';
      removeBtn.style.cssText = 'font-size:0.72rem;padding:4px 8px;flex-shrink:0;color:var(--text3)';
      removeBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        row.remove();
        if (!list.querySelector('.ts-row')) {
          el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📑</span>'+tr('no_stored_tabs','No stored tabs yet.')+'<br><small style="color:var(--text3)">'+tr('store_tab_hint','Right-click any page → Extended History → Store this tab</small></div>');
        } else {
          const countEl2 = el.querySelector('.ts-count');
          if (countEl2) {
            const n = list.querySelectorAll('.ts-row').length;
            countEl2.textContent = `${n} stored tab${n !== 1 ? 's' : ''}`;
          }
        }
        send('REMOVE_TAB_STORAGE_ENTRY', { id: entry.id });
      });
      row.addEventListener('click', () => {
        chrome.tabs.create({ url: entry.url, active: false });
        row.remove();
        if (!list.querySelector('.ts-row')) {
          el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📑</span>'+tr('no_stored_tabs','No stored tabs yet.')+'<br><small style="color:var(--text3)">'+tr('store_tab_hint','Right-click any page → Extended History → Store this tab</small></div>');
        } else {
          const countEl2 = el.querySelector('.ts-count');
          if (countEl2) {
            const n = list.querySelectorAll('.ts-row').length;
            countEl2.textContent = `${n} stored tab${n !== 1 ? 's' : ''}`;
          }
        }
        send('REMOVE_TAB_STORAGE_ENTRY', { id: entry.id });
      });
      row.appendChild(fav);
      row.appendChild(body);
      row.appendChild(removeBtn);
      list.appendChild(row);
    }
    el.appendChild(list);
    // Restore scroll position after re-render
    requestAnimationFrame(() => { if (scrollEl) scrollEl.scrollTop = prevScroll; });
  } catch (err) {
    el.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

// ══ DEVICES ═════════════════════════════════════════════════════════════════
async function loadDevices() {
  const el = document.getElementById('devicesContent');
  el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📡</span>'+tr('loading','Loading')+'…</div>';
  try {
    const { devices } = await send('GET_DEVICES');
    if (!devices?.length) {
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📡</span>'+tr('no_synced_devices','No synced devices found.')+'<br><small style="color:var(--text3)">'+tr('chrome_sync_hint','Sign in to Chrome and enable Sync.')+'</small></div>';
      return;
    }

    el.innerHTML = '';

    // ── Deduplicate: for same device name keep only the freshest session set ──
    const deviceMap = new Map();
    for (const dev of devices) {
      const key = (dev.deviceName || 'Unknown').toLowerCase().trim();
      // Pick the entry whose most-recent session is newer
      if (!deviceMap.has(key)) {
        deviceMap.set(key, dev);
      } else {
        const existing = deviceMap.get(key);
        const latestTs = d => (d.sessions || []).reduce((m, s) => Math.max(m, s.lastModified || 0), 0);
        if (latestTs(dev) > latestTs(existing)) deviceMap.set(key, dev);
      }
    }

    deviceMap.forEach(dev => {
      const icon = /phone|mobile|android|ios/i.test(dev.deviceName || '') ? '📱' : '💻';
      // Flatten tabs across all sessions, deduplicate by URL
      const seenUrls = new Set();
      const tabs = (dev.sessions || [])
        .flatMap(s => s.window?.tabs || [])
        .filter(t => {
          if (!t.url || seenUrls.has(t.url)) return false;
          seenUrls.add(t.url);
          return true;
        });

      const card = document.createElement('div');
      card.className = 'device-card';

      // ── Header (always visible, click to expand) ──
      const head = document.createElement('div');
      head.className = 'dc-head dc-head-collapsible';

      const headLeft = document.createElement('div');
      headLeft.style.cssText = 'display:flex;align-items:center;gap:10px;flex:1;min-width:0';
      headLeft.innerHTML = `<span class="dc-icon">${icon}</span>`;

      const nameWrap = document.createElement('div');
      nameWrap.style.flex = '1';
      const nameEl = document.createElement('div');
      nameEl.className   = 'dc-name';
      nameEl.textContent = dev.deviceName || 'Unknown';
      const subEl = document.createElement('div');
      subEl.className   = 'dc-sub';
      subEl.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;
      nameWrap.appendChild(nameEl);
      nameWrap.appendChild(subEl);
      headLeft.appendChild(nameWrap);

      // ── Export button ──
      const exportBtn = document.createElement('button');
      exportBtn.className = 'tb-btn';
      exportBtn.textContent = '⬇ '+tr('export','Export');
      exportBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;flex-shrink:0;margin-right:6px';
      exportBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        exportDeviceAsHtml(dev.deviceName || 'Device', tabs);
      });

      const toggle = document.createElement('span');
      toggle.className = 'dc-toggle';
      toggle.textContent = '▶';

      head.appendChild(headLeft);
      head.appendChild(exportBtn);
      head.appendChild(toggle);
      card.appendChild(head);

      // ── Tab list (collapsed by default) ──
      const tabsEl = document.createElement('div');
      tabsEl.className = 'dc-tabs-list';

      let renderedCount = 0;
      tabs.forEach((t, i) => {
        try {
          const dom = tryDomain(t.url || '');
          const row = document.createElement('div');
          row.className = 'dc-row';
          row.dataset.title = (t.title || '').toLowerCase();
          row.dataset.url   = (t.url || '').toLowerCase();
          row.addEventListener('click', () => chrome.tabs.create({ url: t.url, active: false }));

          const img = document.createElement('img');
          img.className = 'dc-rfav';
          setFavicon(img, dom);
          img.loading   = 'lazy';
          img.addEventListener('error', () => { img.style.opacity = '0'; });

          const body = document.createElement('div');
          body.className = 'dc-rbody';
          const titleEl = document.createElement('div');
          titleEl.className   = 'dc-rtitle';
          titleEl.textContent = t.title || t.url;
          const urlEl = document.createElement('div');
          urlEl.className   = 'dc-rurl';
          urlEl.textContent = t.url;
          body.appendChild(titleEl);
          body.appendChild(urlEl);
          row.appendChild(img);
          row.appendChild(body);

          if (t.lastModified) {
            const time = document.createElement('div');
            time.className   = 'dc-rtime';
            time.textContent = timeAgo(t.lastModified * 1000);
            row.appendChild(time);
          }
          tabsEl.appendChild(row);
          renderedCount++;
        } catch (err) {
          // A single malformed tab entry used to be able to throw here and silently
          // abort the rest of forEach, leaving the list truncated with no visible
          // error — that's the leading theory for tab lists appearing cut short.
          console.error('[EH] Devices: failed to render tab row', i, t, err);
        }
      });
      if (renderedCount !== tabs.length) {
        console.warn(`[EH] Devices: only rendered ${renderedCount} of ${tabs.length} tabs for "${dev.deviceName}" — see errors above`);
      }

      if (!tabs.length) {
        const empty = document.createElement('div');
        empty.className   = 'dc-empty';
        empty.textContent = 'No recent tabs';
        tabsEl.appendChild(empty);
      }

      card.appendChild(tabsEl);

      // Toggle expand/collapse on header click
      head.addEventListener('click', () => {
        const open = tabsEl.classList.toggle('open');
        toggle.classList.toggle('open', open);
      });

      el.appendChild(card);
    });

    filterDeviceRows(document.getElementById('deviceSearchInput')?.value || '');
  } catch (err) {
    el.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

// ── Devices search: filter tabs across all device cards by title or URL ─────
function filterDeviceRows(rawQuery) {
  const query = (rawQuery || '').trim().toLowerCase();
  const cards = document.querySelectorAll('#devicesContent .device-card');
  cards.forEach(card => {
    const tabsEl = card.querySelector('.dc-tabs-list');
    const toggle = card.querySelector('.dc-toggle');
    if (!tabsEl) return;
    const rows = tabsEl.querySelectorAll('.dc-row');
    let anyVisible = false;
    rows.forEach(row => {
      const matches = !query || row.dataset.title.includes(query) || row.dataset.url.includes(query);
      row.style.display = matches ? '' : 'none';
      if (matches) anyVisible = true;
    });
    if (query) {
      // Auto-expand cards that have a match so results are visible without
      // needing to click into each device manually; hide cards with none.
      card.style.display = anyVisible ? '' : 'none';
      if (anyVisible) {
        tabsEl.classList.add('open');
        toggle?.classList.add('open');
      }
    } else {
      // Search cleared — restore normal collapsed browsing behavior.
      card.style.display = '';
    }
  });
}

let _deviceSearchWired = false;
function wireDeviceSearch() {
  if (_deviceSearchWired) return;
  const input = document.getElementById('deviceSearchInput');
  const refreshBtn = document.getElementById('devicesRefreshBtn');
  if (!input && !refreshBtn) return;
  _deviceSearchWired = true;
  const clearBtn = document.getElementById('deviceSearchClearBtn');
  const syncClearBtn = () => clearBtn?.classList.toggle('visible', !!(input && input.value.length));
  if (input) input.addEventListener('input', () => { syncClearBtn(); filterDeviceRows(input.value); });
  if (input) input.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && input.value) { ev.preventDefault(); input.value = ''; syncClearBtn(); filterDeviceRows(''); }
  });
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
    syncClearBtn();
    filterDeviceRows('');
    input.focus();
  });
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadDevices());
}

// ── Export device tabs as .html ──────────────────────────────────────────────
function exportDeviceAsHtml(deviceName, tabs) {
  const validTabs = tabs.filter(t => t.url);
  if (!validTabs.length) { toast('No tabs to export', 'err'); return; }

  function tabLink(t) {
    const dom = tryDomain(t.url);
    return '<a href="' + esc(t.url) + '">'
      + '<img class="fav" src="https://www.google.com/s2/favicons?sz=16&domain=' + encodeURIComponent(dom) + '" loading="lazy" onerror="this.style.display=\'none\'"/>'
      + '<span class="title">' + esc(t.title || t.url) + '</span>'
      + '<span class="domain">' + esc(dom) + '</span></a>';
  }

  const allUrls = JSON.stringify(validTabs.map(t => t.url)).replace(/"/g, '&quot;');
  const linksHtml = '<div class="restore-bar">'
    + '<button class="restore-btn" data-urls="' + allUrls + '">\u21BA Open all ' + validTabs.length + ' tabs</button>'
    + '</div>'
    + '<div class="links">' + validTabs.map(tabLink).join('') + '</div>';

  const CSS = ':root{--accent:#3b9eff}'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:system-ui,sans-serif;background:#0d0d10;color:#f0eee8;padding:0}'
    + '.page-header{padding:32px 32px 20px}'
    + 'h1{font-size:1.3rem;font-weight:700;color:var(--accent);margin-bottom:4px}'
    + '.meta{font-size:.78rem;color:#a09eb0}'
    + '.content{padding:0 32px 40px}'
    + '.links{display:flex;flex-direction:column;gap:3px}'
    + 'a{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;text-decoration:none;color:#f0eee8;background:#18181f;border:1px solid rgba(255,255,255,.06);transition:background .1s}'
    + 'a:hover{background:#1f1f28}'
    + '.fav{width:16px;height:16px;border-radius:3px;flex-shrink:0}'
    + '.title{flex:1;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.domain{font-size:.7rem;color:#a09eb0;flex-shrink:0;font-family:monospace}'
    + '.restore-bar{padding:0 0 14px}'
    + '.restore-btn{padding:6px 14px;background:rgba(59,158,255,.12);border:1px solid rgba(59,158,255,.35);border-radius:6px;color:var(--accent);font-size:.75rem;font-weight:600;cursor:pointer;transition:background .1s}'
    + '.restore-btn:hover{background:rgba(59,158,255,.22)}'
    + 'footer{padding:16px 32px 32px;font-size:.7rem;color:#5a5870}';

  const SCRIPT = '(function(){'
    + 'document.querySelectorAll(".restore-btn").forEach(function(btn){'
    +   'btn.addEventListener("click",function(){'
    +     'var u=JSON.parse(btn.getAttribute("data-urls").replace(/&quot;/g,\'"\'));'
    +     'if(!u.length)return;'
    +     'if(u.length>15&&!confirm("Open "+u.length+" tabs?"))return;'
    +     'u.forEach(function(x){window.open(x,"_blank");});'
    +   '});'
    + '});'
    + '})();';

  const html = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/>'
    + '<title>' + esc(deviceName) + ' \u2013 Device Tabs</title>'
    + '<style>' + CSS + '</style></head>\n<body>\n'
    + '<div class="page-header">'
    +   '<h1>' + ((/phone|mobile|android|ios/i.test(deviceName)) ? '📱' : '💻') + ' ' + esc(deviceName) + '</h1>'
    +   '<div class="meta">' + validTabs.length + ' tabs \u00B7 Exported ' + new Date().toLocaleString() + '</div>'
    + '</div>\n'
    + '<div class="content">' + linksHtml + '</div>\n'
    + '<footer>Exported by Extended History</footer>\n'
    + '<script>' + SCRIPT + '<\/script>\n'
    + '</body></html>';

  const safeName = deviceName.replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([html], { type: 'text/html' })),
    download: 'device_' + safeName + '_' + new Date().toISOString().slice(0, 10) + '.html'
  }).click();
  toast('Device tabs exported', 'ok');
}

// ══ BOOKMARKS — split-pane tree + list ══════════════════════════════════════
let _bmTree        = null;   // full Chrome bookmark tree
let _bmActiveNode  = null;   // currently selected folder node (null = root)
let _bmItems       = [];     // flat list of bookmark items for current view
let _bmNodeMap     = new Map(); // id → node, rebuilt whenever tree loads
let _bmFlat        = [];        // precomputed flat search index — rebuilt with tree

// Build flat id→node map from the full tree (call after every tree load)
function _bmBuildNodeMap(nodes) {
  _bmNodeMap.clear();
  function walk(ns) {
    for (const n of ns) { _bmNodeMap.set(n.id, n); if (n.children) walk(n.children); }
  }
  walk(nodes || []);
}

// Build flat search index: one entry per bookmark url-node, with precomputed
// lowercase search fields and resolved folder name so search is a plain filter().
function _bmBuildFlat() {
  _bmFlat = [];
  function walk(ns) {
    for (const n of ns) {
      if (n.url) {
        const parentNode   = n.parentId ? _bmNodeMap.get(n.parentId) : null;
        const isTopRoot    = !parentNode || parentNode.parentId === '0' || !parentNode.parentId;
        const folderName   = (!isTopRoot && parentNode) ? (parentNode.title || '') : '';
        _bmFlat.push({
          node:       n,
          _title:     (n.title || '').toLowerCase(),
          _url:       (n.url   || '').toLowerCase(),
          _domain:    (tryDomain(n.url || '') || '').toLowerCase(),
          _folder:    folderName.toLowerCase(),
          folderName: folderName,
        });
      } else if (n.children) {
        walk(n.children);
      }
    }
  }
  // Walk from real roots (skip chrome's synthetic root wrapper)
  const roots = [];
  for (const r of (_bmTree || [])) {
    if (r.children) roots.push(...r.children);
  }
  walk(roots);
}

async function loadBookmarks() {
  const treePane = document.getElementById('bmTreePane');
  const listPane = document.getElementById('bookmarksContent');
  if (treePane) treePane.innerHTML = '<div class="state-msg" style="padding:20px"><span class="state-msg-icon" style="font-size:20px">⏳</span></div>';
  listPane.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔖</span>'+tr('loading','Loading')+'…</div>';
  _bmFavCache.clear(); // favicon resolver setting may have changed since last visit
  if (!loadBookmarks._setup) {
    loadBookmarks._setup = true;

    // Bookmark search clear button
    const bmSearchInput = document.getElementById('bmSearch');
    const bmClearBtn    = document.getElementById('bmSearchClearBtn');
    if (bmSearchInput && bmClearBtn) {
      bmSearchInput.addEventListener('input', () => {
        bmClearBtn.classList.toggle('visible', bmSearchInput.value.length > 0);
      });
      bmClearBtn.addEventListener('click', () => {
        bmSearchInput.value = '';
        bmClearBtn.classList.remove('visible');
        renderBmItems(_bmActiveNode);
      });
    }
  }
  try {
    const { tree } = await send('GET_BOOKMARKS');
    _bmTree = tree;
    _bmBuildNodeMap(_bmTree);
    _bmBuildFlat();
    _bmActiveNode = null;
    renderBmTree();
    renderBmItems(null);
  } catch (err) {
    listPane.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

// Reload tree data but preserve the currently selected folder, expanded states, scroll position, and active search
async function reloadBookmarksKeepState(resetScroll = true) {
  // Snapshot which node IDs are expanded and which is active
  const expandedIds = new Set();
  function collectExpanded(nodes) {
    for (const n of nodes) {
      if (!n.url && n._expanded) expandedIds.add(n.id);
      if (n.children) collectExpanded(n.children);
    }
  }
  if (_bmTree) collectExpanded(_bmTree);
  const activeId = _bmActiveNode?.id ?? null;

  // Snapshot scroll position and active search query
  const itemsPane   = document.getElementById('bookmarksContent');
  const savedScroll = itemsPane ? itemsPane.scrollTop : 0;
  const searchInput = document.getElementById('bmSearch');
  const activeQuery = searchInput ? searchInput.value.trim() : '';

  // Fetch fresh tree
  try {
    const { tree } = await send('GET_BOOKMARKS');
    _bmTree = tree;
    _bmBuildNodeMap(_bmTree);
    _bmBuildFlat();
    function restoreExpanded(nodes) {
      for (const n of nodes) {
        if (!n.url) {
          if (expandedIds.has(n.id)) n._expanded = true;
          if (n.children) restoreExpanded(n.children);
        }
      }
    }
    restoreExpanded(_bmTree);

    // Find the active node by ID
    _bmActiveNode = null;
    if (activeId) {
      function findNode(nodes) {
        for (const n of nodes) {
          if (n.id === activeId) return n;
          if (n.children) { const f = findNode(n.children); if (f) return f; }
        }
        return null;
      }
      _bmActiveNode = findNode(_bmTree);
    }

    renderBmTree();

    // Re-apply search filter if one was active, otherwise show folder contents
    if (activeQuery) {
      renderBookmarksWithFilter(activeQuery);
    } else {
      renderBmItems(_bmActiveNode);
    }

    // Restore scroll position after render (only when preserving state, e.g. after a move)
    if (!resetScroll && itemsPane) requestAnimationFrame(() => { itemsPane.scrollTop = savedScroll; });
  } catch (err) {
    toast(err.message, 'err');
  }
}

// Build flat list of all top-level chrome bookmark roots' children
function bmRootChildren() {
  const out = [];
  for (const root of (_bmTree || [])) {
    if (root.children) out.push(...root.children);
  }
  return out;
}

// Dragging state
let _bmDragId = null; // chrome bookmark id being dragged
let _bmSelMode = false;           // bookmark multiselect active?
let _bmSelected = new Set();      // selected bookmark ids
let _bmFolderDragId = null;       // folder node id being dragged in tree
let _bmIsSearch = false;          // true when showing search results (show folder label), false = show date

// In-list reorder state — dragging a bookmark up/down within the currently
// viewed folder, dropping it between two other bookmarks. Set/cleared via
// window._bmReorderSetDrag/_bmReorderClearDrag, called from the dragstart/
// dragend handlers in _bmSetupList below.
let _bmReorderDragId    = null;   // id of the bookmark being reordered, or null if this drag isn't eligible
let _bmReorderTargetRow = null;   // row currently showing the insertion-line indicator
let _bmReorderBefore    = true;   // true = indicator/insert above the target row, false = below

// ── Tree drag-and-drop ───────────────────────────────────────────────────────
// Wired ONCE on the (persistent) pane. renderBmTree() replaces the rows on every
// render, so nothing here may hold on to row elements across renders. Rows
// identify themselves via data attributes:
//   data-root="1"        → the "All Bookmarks" row
//   data-folder-id=ID    → a folder row (data-has-sub="1" if it has subfolders)
let _bmLastDropRow = null;   // row currently highlighted as drop target
let _bmExpandTimer = null;   // pending "hover long enough → expand" timer
const BM_HOVER_EXPAND_MS = 400;

// undefined = not a drop target, null = "All Bookmarks" root, node = folder
function _bmTreeRowNode(row) {
  if (!row) return undefined;
  if (row.dataset.root) return null;
  if (row.dataset.folderId !== undefined) return _bmNodeMap.get(row.dataset.folderId) || undefined;
  return undefined;
}

function _bmClearDropHighlight() {
  clearTimeout(_bmExpandTimer);
  _bmExpandTimer = null;
  if (_bmLastDropRow) {
    _bmLastDropRow.classList.remove('bm-drop-target', 'bm-folder-drop-into', 'bm-folder-drop-above', 'bm-folder-drop-below');
    _bmLastDropRow = null;
  }
}

// While a BOOKMARK is dragged over a collapsed folder that has subfolders, open
// it after a short hover so the user can drop into a nested folder.
// (Not done for folder drags: re-rendering the tree would remove the row being
// dragged, and the browser would never fire its dragend.)
function _bmScheduleHoverExpand(row) {
  if (!row.dataset.hasSub) return;
  const node = _bmNodeMap.get(row.dataset.folderId);
  if (!node || node._expanded) return;
  _bmExpandTimer = setTimeout(() => {
    _bmExpandTimer = null;
    if (!_bmDragId) return;
    node._expanded = true;
    renderBmTree();
  }, BM_HOVER_EXPAND_MS);
}

function _bmSetupTreeDnD() {
  const pane = document.getElementById('bmTreePane');
  if (!pane) return;

  // ev.preventDefault() must be called synchronously (browser requirement for drop
  // to work), but the highlight DOM update is deferred via rAF — at most once per frame.
  let rafPending = false;
  let pendingRow = null;
  pane.addEventListener('dragover', ev => {
    if (!_bmDragId && !_bmFolderDragId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    pendingRow = ev.target.closest && ev.target.closest('.bm-tree-row');
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const row = pendingRow;
      if (!row || row === _bmLastDropRow) return;
      _bmClearDropHighlight();
      if (_bmFolderDragId) {
        // Folder-drag: highlight as drop-into target
        if (row !== document.querySelector('.bm-tree-row.bm-folder-dragging')) {
          row.classList.add('bm-folder-drop-into');
          _bmLastDropRow = row;
        }
      } else if (_bmTreeRowNode(row) !== undefined) {
        // Bookmark-item drag
        row.classList.add('bm-drop-target');
        _bmLastDropRow = row;
        _bmScheduleHoverExpand(row);
      }
    });
  });

  pane.addEventListener('dragleave', ev => {
    if (!_bmLastDropRow) return;
    if (!pane.contains(ev.relatedTarget) ||
        (ev.target === _bmLastDropRow && !_bmLastDropRow.contains(ev.relatedTarget))) {
      _bmClearDropHighlight();
    }
  });

  pane.addEventListener('drop', async ev => {
    ev.preventDefault();
    const row = ev.target.closest && ev.target.closest('.bm-tree-row');
    const targetNode = _bmTreeRowNode(row);
    _bmClearDropHighlight();

    // ── Folder drag: move folder into target folder ──────────────────────────
    if (_bmFolderDragId) {
      const folderId = _bmFolderDragId;
      _bmFolderDragId = null;
      if (targetNode === undefined) return; // dropped on no target
      const parentId = targetNode ? targetNode.id : '1'; // null targetNode = root
      if (parentId === folderId) return; // can't move into itself
      const r = await send('MOVE_BOOKMARK', { id: folderId, parentId });
      if (r?.error) toast(r.error, 'err');
      else {
        toast('Folder moved', 'ok');
        if (targetNode) targetNode._expanded = true; // show what just landed inside it
        await reloadBookmarksKeepState();
      }
      return;
    }

    // ── Bookmark-item drag ───────────────────────────────────────────────────
    if (!_bmDragId || targetNode === undefined) return;
    const dragId = _bmDragId;
    _bmDragId = null;
    const parentId = targetNode ? targetNode.id : '1';
    const r = await send('MOVE_BOOKMARK', { id: dragId, parentId });
    if (r?.error) toast(r.error, 'err');
    else {
      toast('Bookmark moved', 'ok');
      if (targetNode) targetNode._expanded = true; // open the folder it was dropped into
      await reloadBookmarksKeepState();
    }
  });
}
_bmSetupTreeDnD();

// Render the left folder tree pane
function renderBmTree() {
  const pane = document.getElementById('bmTreePane');
  if (!pane) return;
  const prevScroll = pane.scrollTop; // rebuilding rows would otherwise jump the tree to the top
  _bmClearDropHighlight();           // rows are about to be replaced
  pane.innerHTML = '';

  // "All bookmarks" root entry
  const rootRow = document.createElement('div');
  rootRow.className = 'bm-tree-row' + (_bmActiveNode === null ? ' active' : '');
  rootRow.dataset.root = '1';
  rootRow.innerHTML = '<span class="bm-tr-icon">📚</span><span class="bm-tr-label">All Bookmarks</span>';
  rootRow.addEventListener('click', () => { _bmActiveNode = null; renderBmTree(); renderBmItems(null); });
  pane.appendChild(rootRow);

  // Folder right-click context menu
  function addFolderCtx(row, n) {
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault(); ev.stopPropagation();
      showBmFolderCtxMenu(ev.clientX, ev.clientY, n);
    });
  }

  // Render folder nodes recursively
  function walkFolders(nodes, depth) {
    for (const n of nodes) {
      if (n.url) continue; // skip bookmarks in tree pane
      if (!n.children) continue;
      const row = document.createElement('div');
      row.className = 'bm-tree-row' + (_bmActiveNode === n ? ' active' : '');
      row.style.paddingLeft = (12 + depth * 16) + 'px';

      // Expand/collapse toggle — ONLY this element triggers expand
      const hasSubFolders = n.children.some(c => !c.url && c.children);
      const toggle = document.createElement('span');
      toggle.className = 'bm-tr-toggle';
      toggle.textContent = hasSubFolders ? '▶' : '';
      if (n._expanded === undefined) n._expanded = false;
      if (n._expanded) toggle.style.transform = 'rotate(90deg)';

      toggle.addEventListener('click', ev => {
        ev.stopPropagation();
        if (!hasSubFolders) return;
        n._expanded = !n._expanded;
        toggle.style.transform = n._expanded ? 'rotate(90deg)' : '';
        // Re-render just the tree pane (cheap, no list repaint)
        renderBmTree();
      });

      const icon = document.createElement('span');
      icon.className = 'bm-tr-icon';
      icon.textContent = '📁';

      const label = document.createElement('span');
      label.className = 'bm-tr-label';
      label.textContent = n.title || 'Folder';

      row.appendChild(toggle);
      row.appendChild(icon);
      row.appendChild(label);

      // Row click = select folder only, no expand/collapse
      row.addEventListener('click', ev => {
        ev.stopPropagation();
        _bmActiveNode = n;
        renderBmTree();
        renderBmItems(n);
      });

      // Right-click = folder context menu
      addFolderCtx(row, n);

      // ── Folder drag-and-drop (move folder into another folder) ──────────────
      row.draggable = true;
      row.dataset.folderId = n.id;
      row.dataset.hasSub = hasSubFolders ? '1' : '';

      row.addEventListener('dragstart', ev => {
        // Don't interfere with bookmark-item drags
        if (_bmDragId) { ev.preventDefault(); return; }
        _bmFolderDragId = n.id;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', 'folder:' + n.id);
        setTimeout(() => { row.classList.add('bm-folder-dragging'); }, 0);
      });

      row.addEventListener('dragend', () => {
        _bmFolderDragId = null;
        document.querySelectorAll('.bm-folder-dragging,.bm-folder-drop-into,.bm-folder-drop-above,.bm-folder-drop-below')
          .forEach(el => el.classList.remove('bm-folder-dragging','bm-folder-drop-into','bm-folder-drop-above','bm-folder-drop-below'));
      });
      // ────────────────────────────────────────────────────────────────────────

      pane.appendChild(row);

      if (hasSubFolders && n._expanded) {
        walkFolders(n.children, depth + 1);
      }
    }
  }

  walkFolders(bmRootChildren(), 0);
  pane.scrollTop = prevScroll;
}

// ── Folder context menu ───────────────────────────────────────────────────────
let _bmCtxFolderNode = null;

function showBmFolderCtxMenu(x, y, node) {
  _bmCtxFolderNode = node;
  const menu = document.getElementById('bmFolderCtx');
  if (!menu) return;
  menu.style.display = 'block';
  // Keep within viewport
  const mw = 190, mh = 80;
  menu.style.left = Math.min(x, window.innerWidth  - mw - 8) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function hideBmFolderCtxMenu() {
  const m = document.getElementById('bmFolderCtx');
  if (m) m.style.display = 'none';
  _bmCtxFolderNode = null;
}

document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideBmFolderCtxMenu(); });

// Single delegated handler — check actions first, then hide menu
document.addEventListener('click', async ev => {
  const menu = document.getElementById('bmFolderCtx');

  // ── Rename ──
  const renameBtn = ev.target.closest('#bmCtxRename');
  if (renameBtn) {
    const node = _bmCtxFolderNode;
    hideBmFolderCtxMenu();
    if (!node) return;
    const newTitle = prompt('Rename folder:', node.title || '');
    if (!newTitle || !newTitle.trim()) return;
    const r = await send('RENAME_BOOKMARK', { id: node.id, title: newTitle.trim() });
    if (r?.error) toast(r.error, 'err');
    else { toast('Folder renamed', 'ok'); node.title = newTitle.trim(); renderBmTree(); }
    return;
  }

  // ── Delete ──
  const deleteBtn = ev.target.closest('#bmCtxDelete');
  if (deleteBtn) {
    const node = _bmCtxFolderNode;
    hideBmFolderCtxMenu();
    if (!node) return;
    const count = (node.children || []).length;
    const msg = count > 0
      ? `Delete folder "${node.title}" and its ${count} item${count !== 1 ? 's' : ''}? Cannot be undone.`
      : `Delete empty folder "${node.title}"?`;
    if (!confirm(msg)) return;
    const r = await send('DELETE_BOOKMARK', { id: node.id });
    if (r?.error) toast(r.error, 'err');
    else { toast('Folder deleted', 'ok'); if (_bmActiveNode === node) _bmActiveNode = null; await reloadBookmarksKeepState(); }
    return;
  }

  // ── New folder ──
  const newFolderBtn = ev.target.closest('#bmCtxNewFolder');
  if (newFolderBtn) {
    const parentNode = _bmCtxFolderNode;
    hideBmFolderCtxMenu();
    const name = prompt('New folder name:', 'New Folder');
    if (!name || !name.trim()) return;
    const parentId = parentNode ? parentNode.id : '1';
    const r = await send('CREATE_BOOKMARK_FOLDER', { parentId, title: name.trim() });
    if (r?.error) toast(r.error, 'err');
    else { toast('Folder created', 'ok'); await reloadBookmarksKeepState(); }
    return;
  }

  // ── Hide menu if clicking outside ──
  if (menu && menu.style.display !== 'none' && !menu.contains(ev.target)) {
    hideBmFolderCtxMenu();
  }
});
// ── Bookmark multiselect helpers ─────────────────────────────────────────────
function _updateBmSelBar() {
  const bar     = document.getElementById('bmSelBar');
  const toolbar = document.getElementById('bmToolbar');
  const count   = document.getElementById('bmSelCount');
  if (bar)     bar.style.display     = _bmSelMode ? 'flex' : 'none';
  if (toolbar) toolbar.style.display = _bmSelMode ? 'none' : 'flex';
  if (count) count.textContent = `${_bmSelected.size} `+ tr('selected','selected');
  const pane = document.getElementById('bookmarksContent');
  if (pane) pane.classList.toggle('bm-sel-mode', _bmSelMode);
}

function _enterBmSelMode(firstId) {
  _bmSelMode = true;
  _bmSelected.clear();
  if (firstId) _bmSelected.add(firstId);
  document.querySelectorAll('#bookmarksContent .bm-item').forEach(r => {
    r.classList.toggle('bm-checked', _bmSelected.has(r.dataset.bmId));
  });
  document.getElementById('bmSelModeBtn')?.classList.add('active');
  _updateBmSelBar();
}

function _exitBmSelMode() {
  _bmSelMode = false;
  _bmSelected.clear();
  document.querySelectorAll('#bookmarksContent .bm-item').forEach(r => {
    r.classList.remove('bm-checked');
  });
  document.getElementById('bmSelModeBtn')?.classList.remove('active');
  _updateBmSelBar();
}

function _toggleBmItem(id, row) {
  if (_bmSelected.has(id)) { _bmSelected.delete(id); row.classList.remove('bm-checked'); }
  else { _bmSelected.add(id); row.classList.add('bm-checked'); }
  _updateBmSelBar();
}

// ── Bookmark list (virtualized) ──────────────────────────────────────────────
// The whole bookmark list lives in memory as plain objects (_bmItems). Only the
// rows in/near the viewport are ever real DOM nodes (~40-60), no matter whether
// there are 200 bookmarks or 20,000. Rows are absolutely positioned inside a
// "sizer" div whose height = rowCount × rowHeight, so the scrollbar behaves as
// if every row existed. All row interaction (click / right-click / drag) is
// handled by ONE delegated listener per event on the pane instead of 4-6
// listeners per row.
//
// One shared formatter: toLocaleDateString(locale, options) builds a new Intl
// formatter on every call, which is costly across thousands of rows.
const _bmDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const _bmFavCache = new Map();   // domain → resolved favicon src (avoids re-asking the background on every re-scroll)
const BM_BUFFER   = 10;          // extra rows rendered above/below the viewport
let _bmRowH       = 38;          // measured row height in px (all rows are the same height)
let _bmNeedMeasure = false;      // true if the list was built while the panel was hidden
let _bmSizer      = null;        // the tall positioning container inside #bookmarksContent
const _bmVRows    = new Map();   // item index → live row element
let _bmVRaf       = 0;

// Build a single bookmark row DOM element (no listeners — see _bmSetupList)
function _buildBmRow(n) {
  const dom = tryDomain(n.url || '');
  const row = document.createElement('div');
  row.className = _bmSelected.has(n.id) ? 'bm-item bm-checked' : 'bm-item';
  row.dataset.bmId = n.id;
  row.draggable = true;
  row.title = (n.title && n.title !== n.url ? n.title + '\n' : '') + (n.url || '');   // hover → title + URL

  const check = document.createElement('span');
  check.className = 'bm-item-check';
  check.textContent = '✓';

  const handle = document.createElement('span');
  handle.className = 'bm-drag-handle';
  handle.title = 'Drag to move to folder';
  handle.textContent = '⠿';

  const fav = document.createElement('img');
  fav.className = 'bm-fav';
  const cachedSrc = _bmFavCache.get(dom);
  if (cachedSrc) {
    fav.src = cachedSrc;
  } else {
    setFavicon(fav, dom);
    fav.addEventListener('load', () => {
      if (dom && fav.src && !_bmFavCache.has(dom)) _bmFavCache.set(dom, fav.src);
    }, { once: true });
  }
  fav.loading = 'lazy';
  fav.addEventListener('error', function(){ this.style.opacity='0'; });

  const title = document.createElement('div');
  title.className = 'bm-title';
  title.textContent = n.title || n.url;

  // Secondary label — folder name during search, date added otherwise
  const folderLabel = document.createElement('span');
  folderLabel.className = 'bm-folder-label';
  let labelText = '';
  if (_bmIsSearch) {
    // Show parent folder name (skip top-level Chrome root folders)
    const parentNode = n.parentId ? _bmNodeMap.get(n.parentId) : null;
    const isTopLevelRoot = !parentNode || parentNode.parentId === '0' || !parentNode.parentId;
    labelText = (!isTopLevelRoot && parentNode) ? (parentNode.title || '') : '';
  } else if (n.dateAdded) {
    labelText = _bmDateFmt.format(new Date(n.dateAdded));
  }
  folderLabel.textContent = labelText;
  folderLabel.style.display = labelText ? '' : 'none';

  row.appendChild(check);
  row.appendChild(handle);
  row.appendChild(fav);
  row.appendChild(title);
  row.appendChild(folderLabel);
  return row;
}

// Measure the real rendered row height (depends on the user's font-size setting).
// Returns 0 if it can't be measured (e.g. panel currently display:none).
function _bmMeasureRowH(sample) {
  if (!_bmSizer) return 0;
  const row = _buildBmRow(sample);
  row.style.visibility = 'hidden';
  _bmSizer.appendChild(row);
  const h = Math.ceil(row.getBoundingClientRect().height);
  row.remove();
  return h;
}

function _bmVRender() {
  _bmVRaf = 0;
  const pane = document.getElementById('bookmarksContent');
  const total = _bmItems.length;
  if (!pane || !_bmSizer || !_bmSizer.isConnected || !total) return;

  // List was built while the panel was hidden → measure now that it is visible
  if (_bmNeedMeasure && pane.clientHeight > 0) {
    const h = _bmMeasureRowH(_bmItems[0]);
    if (h) {
      _bmRowH = h;
      _bmNeedMeasure = false;
      _bmSizer.style.height = (total * _bmRowH) + 'px';
      for (const row of _bmVRows.values()) row.remove();
      _bmVRows.clear();
    }
  }

  const top   = pane.scrollTop;
  const view  = pane.clientHeight || 600;
  const first = Math.max(0, Math.floor(top / _bmRowH) - BM_BUFFER);
  const last  = Math.min(total - 1, Math.ceil((top + view) / _bmRowH) + BM_BUFFER);

  // Drop rows that scrolled far out of view (never the one being dragged —
  // removing a drag source mid-drag would swallow its dragend event)
  for (const [i, row] of _bmVRows) {
    if ((i < first || i > last) && row.dataset.bmId !== _bmDragId) {
      row.remove();
      _bmVRows.delete(i);
    }
  }

  // Add rows that just came into range
  const frag = document.createDocumentFragment();
  for (let i = first; i <= last; i++) {
    if (_bmVRows.has(i)) continue;
    const row = _buildBmRow(_bmItems[i]);
    row.style.top    = (i * _bmRowH) + 'px';
    row.style.height = _bmRowH + 'px';
    _bmVRows.set(i, row);
    frag.appendChild(row);
  }
  if (frag.firstChild) _bmSizer.appendChild(frag);
}

function _bmVSchedule() {
  if (!_bmVRaf) _bmVRaf = requestAnimationFrame(_bmVRender);
}

function _bmInitList(items, emptyMsg) {
  // Exit select mode when navigating to a different folder
  if (_bmSelMode) _exitBmSelMode();
  const pane = document.getElementById('bookmarksContent');
  pane.innerHTML = '';
  pane.scrollTop = 0;
  _bmItems = _bmSortItems(items);
  items = _bmItems;
  _bmVRows.clear();
  _bmSizer = null;

  if (!items.length) {
    pane.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔖</span>' + (emptyMsg || 'No bookmarks here') + '</div>';
    return;
  }

  _bmSizer = document.createElement('div');
  _bmSizer.className = 'bm-vsizer';
  pane.appendChild(_bmSizer);

  const h = _bmMeasureRowH(items[0]);
  _bmNeedMeasure = !h;
  if (h) _bmRowH = h;
  _bmSizer.style.height = (items.length * _bmRowH) + 'px';
  _bmVRender();
}

// One-time wiring: scroll/resize + delegated row interaction
function _bmSetupList() {
  const pane = document.getElementById('bookmarksContent');
  if (!pane) return;

  pane.addEventListener('scroll', _bmVSchedule, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(_bmVSchedule).observe(pane);

  // Click: toggle in selection mode, otherwise open in a background tab
  pane.addEventListener('click', ev => {
    const row = ev.target.closest && ev.target.closest('.bm-item');
    if (!row) return;
    const id = row.dataset.bmId;
    if (_bmSelMode) {
      ev.preventDefault();
      _toggleBmItem(id, row);
      return;
    }
    const n = _bmNodeMap.get(id);
    // Open in background tab — keep focus on extension page
    if (n && n.url) chrome.tabs.create({ url: n.url, active: false });
  });

  pane.addEventListener('contextmenu', ev => {
    const row = ev.target.closest && ev.target.closest('.bm-item');
    if (!row) return;
    ev.preventDefault(); ev.stopPropagation();
    if (_bmSelMode) return; // suppress ctx menu in sel mode
    const n = _bmNodeMap.get(row.dataset.bmId);
    if (n) showCtxMenu(ev.clientX, ev.clientY, { url: n.url, title: n.title, bmId: n.id });
  });

  // Drag-to-folder (only when NOT in sel mode)
  pane.addEventListener('dragstart', ev => {
    const row = ev.target.closest && ev.target.closest('.bm-item');
    if (!row) return;
    if (_bmSelMode) { ev.preventDefault(); return; }
    const id = row.dataset.bmId;
    _bmDragId = id;
    window._bmReorderSetDrag && window._bmReorderSetDrag(id);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', id);
    setTimeout(() => {
      row.classList.add('bm-dragging');
      document.getElementById('panel-bookmarks')?.classList.add('bm-dragging-active');
    }, 0);
  });

  pane.addEventListener('dragend', ev => {
    const row = ev.target.closest && ev.target.closest('.bm-item');
    if (row) row.classList.remove('bm-dragging');
    _bmDragId = null;
    window._bmReorderClearDrag && window._bmReorderClearDrag();
    document.getElementById('panel-bookmarks')?.classList.remove('bm-dragging-active');
    document.querySelectorAll('.bm-drop-target').forEach(el => el.classList.remove('bm-drop-target'));
    _bmVSchedule(); // release the pinned drag row if it is now off-screen
  });
}
_bmSetupList();

// ── In-list reordering ───────────────────────────────────────────────────────
// Only meaningful when viewing a single folder's own contents in their real
// sibling order: "All Bookmarks" flattens every folder into one list, and
// search results are ranked by match, so neither has a single per-folder
// order to write back to via chrome.bookmarks.move.
function _bmReorderEligible() {
  return !!_bmActiveNode && !_bmIsSearch && _bmSort === 'default';
}

// Called from _bmSetupList's dragstart/dragend above.
window._bmReorderSetDrag = function (id) {
  _bmReorderDragId = _bmReorderEligible() ? id : null;
};
window._bmReorderClearDrag = function () {
  _bmReorderDragId = null;
  _bmClearReorderHighlight();
};

function _bmClearReorderHighlight() {
  if (_bmReorderTargetRow) {
    _bmReorderTargetRow.classList.remove('bm-reorder-above', 'bm-reorder-below');
    _bmReorderTargetRow = null;
  }
}

function _bmSetupReorderDnD() {
  const pane = document.getElementById('bookmarksContent');
  if (!pane) return;

  pane.addEventListener('dragover', ev => {
    if (!_bmReorderDragId) return;
    const row = ev.target.closest && ev.target.closest('.bm-item');
    if (!row || row.dataset.bmId === _bmReorderDragId) { _bmClearReorderHighlight(); return; }
    ev.preventDefault(); // allow drop
    ev.dataTransfer.dropEffect = 'move';
    // Which side of the hovered row to insert on is based on drag direction,
    // not cursor position within the row: hovering any row that started
    // below the dragged item inserts after it, any row that started above
    // inserts before it. (Splitting each row into a top/bottom drop zone by
    // cursor Y seems more precise, but it means the cursor has to cross a
    // row's exact midpoint to register a move — dragging down by one row's
    // height only reaches the top half of the next row, which computes back
    // to the item's own original slot, so a single-row drag down silently
    // does nothing. Direction-based zones give one row of travel = one slot
    // of movement in both directions, with no dead zone.)
    const targetNode = _bmNodeMap.get(row.dataset.bmId);
    const dragNode    = _bmNodeMap.get(_bmReorderDragId);
    const before = !(targetNode && dragNode && targetNode.index > dragNode.index);
    if (row !== _bmReorderTargetRow || before !== _bmReorderBefore) {
      _bmClearReorderHighlight();
      row.classList.add(before ? 'bm-reorder-above' : 'bm-reorder-below');
      _bmReorderTargetRow = row;
      _bmReorderBefore    = before;
    }
  });

  pane.addEventListener('dragleave', ev => {
    if (!_bmReorderTargetRow) return;
    if (!pane.contains(ev.relatedTarget)) _bmClearReorderHighlight();
  });

  pane.addEventListener('drop', async ev => {
    if (!_bmReorderDragId) return;
    const dragId = _bmReorderDragId;
    const before = _bmReorderBefore;
    const row    = ev.target.closest && ev.target.closest('.bm-item');
    _bmReorderDragId = null;
    _bmClearReorderHighlight();
    if (!row || row.dataset.bmId === dragId) return;
    ev.preventDefault();

    const targetNode = _bmNodeMap.get(row.dataset.bmId);
    const dragNode    = _bmNodeMap.get(dragId);
    if (!targetNode || !dragNode || targetNode.parentId !== dragNode.parentId) return;

    // Desired final position, computed directly against the real sibling
    // list (bookmarks AND subfolders — Chrome indexes both together, even
    // though subfolders never show up as rows in this list) with the
    // dragged item removed. This is the actual ground truth for where the
    // item should end up; background.js's MOVE_BOOKMARK handler verifies
    // the real result against it and self-corrects if needed, rather than
    // us trying to pre-guess Chrome's internal index adjustment here.
    const parent  = _bmNodeMap.get(targetNode.parentId);
    const others  = (parent?.children || []).filter(n => n.id !== dragId);
    const targetPos = others.findIndex(n => n.id === targetNode.id);
    if (targetPos === -1) return;
    const index = targetPos + (before ? 0 : 1);

    const r = await send('MOVE_BOOKMARK', { id: dragId, parentId: targetNode.parentId, index });
    if (r?.error) { toast(r.error, 'err'); return; }
    await reloadBookmarksKeepState(false); // false = keep scroll position
  });
}
_bmSetupReorderDnD();

// Render the right bookmark list for a folder node (null = show all)
function renderBmItems(folderNode) {
  _bmIsSearch = false;
  let items;
  if (folderNode === null) {
    items = [];
    function collectAll(nodes) {
      for (const n of nodes) {
        if (n.url) items.push(n);
        else if (n.children) collectAll(n.children);
      }
    }
    collectAll(bmRootChildren());
  } else {
    items = (folderNode.children || []).filter(n => !!n.url);
  }
  _bmInitList(items);
}

// Search: flat list across all bookmarks — uses precomputed _bmFlat index for speed.
// The "search in" selector (#bmSearchMode) limits which field(s) the words must match.
function renderBookmarksWithFilter(query) {
  const q = query.trim().toLowerCase();
  if (!_bmTree) return;
  if (!q) { _bmIsSearch = false; renderBmItems(_bmActiveNode); return; }

  const mode  = document.getElementById('bmSearchMode')?.value || 'all';
  // Multi-word: every word must appear in the chosen field(s)
  const words = q.split(/\s+/).filter(Boolean);
  const hit = (e, w) =>
      mode === 'title'  ? e._title.includes(w)
    : mode === 'url'    ? e._url.includes(w)
    : mode === 'domain' ? e._domain.includes(w)
    : (e._title.includes(w) || e._url.includes(w) || e._domain.includes(w) || e._folder.includes(w));
  const results = _bmFlat.filter(e => words.every(w => hit(e, w))).map(e => e.node);

  _bmIsSearch = true;
  _bmInitList(results, 'No matching bookmarks');
}

// ── Bookmark sorting ─────────────────────────────────────────────────────────
// 'default' keeps Chrome's own order (the order they were saved / added);
// the others sort by domain name or title. Persisted per browser.
let _bmSort = 'default';
try { const v = localStorage.getItem('eh_bm_sort'); if (['domain-asc','domain-desc','title-asc','title-desc'].includes(v)) _bmSort = v; } catch {}
function _bmSortItems(items) {
  if (_bmSort === 'default') return items;
  const dir = _bmSort.endsWith('-desc') ? -1 : 1;
  const key = _bmSort.startsWith('title')
    ? n => (n.title || n.url || '').toLowerCase()
    : n => (tryDomain(n.url || '') || '').toLowerCase().replace(/^www\./, '');
  const keyed = items.map((n, i) => ({ n, i, d: key(n) }));
  keyed.sort((a, b) => (dir * a.d.localeCompare(b.d, undefined, { numeric: true, sensitivity: 'base' })) || (a.i - b.i));
  return keyed.map(k => k.n);
}
function _bmRefreshView() {
  const q = document.getElementById('bmSearch')?.value || '';
  if (q.trim()) renderBookmarksWithFilter(q); else renderBmItems(_bmActiveNode);
}
(function setupBmSortSearchUi() {
  const sortSel = document.getElementById('bmSortSel');
  const modeSel = document.getElementById('bmSearchMode');
  if (sortSel) {
    sortSel.value = _bmSort;
    sortSel.addEventListener('change', () => {
      _bmSort = sortSel.value;
      try { localStorage.setItem('eh_bm_sort', _bmSort); } catch {}
      _bmRefreshView();
    });
  }
  if (modeSel) modeSel.addEventListener('change', () => {
    if ((document.getElementById('bmSearch')?.value || '').trim()) _bmRefreshView();
  });
})();
// ── Resizable folder pane ────────────────────────────────────────────────────
// Drag the thin handle between the folder tree and the bookmark list. The width
// is remembered; double-click the handle to reset it.
(function setupBmResizer() {
  const split  = document.querySelector('#panel-bookmarks .bm-split');
  const handle = document.getElementById('bmResizer');
  if (!split || !handle) return;
  const KEY = 'eh_bm_tree_w', DEF = 220, MIN = 160, MIN_LIST = 240;
  const apply = w => split.style.setProperty('--bm-tree-w', w + 'px');

  let saved = DEF;
  try { const v = parseInt(localStorage.getItem(KEY), 10); if (v >= MIN) saved = v; } catch {}
  apply(saved);

  let startX = 0, startW = 0, curW = saved;
  handle.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    startX = ev.clientX;
    startW = curW = split.querySelector('.bm-tree-pane').getBoundingClientRect().width;
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    ev.preventDefault();
  });
  handle.addEventListener('pointermove', ev => {
    if (!handle.classList.contains('dragging')) return;
    const max = Math.max(MIN, split.clientWidth - MIN_LIST);
    curW = Math.max(MIN, Math.min(startW + (ev.clientX - startX), max));
    apply(curW);
  });
  const end = () => {
    if (!handle.classList.contains('dragging')) return;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    try { localStorage.setItem(KEY, String(Math.round(curW))); } catch {}
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    curW = DEF; apply(DEF);
    try { localStorage.removeItem(KEY); } catch {}
  });
})();

// ── Bookmark multiselect bar buttons ────────────────────────────────────────
document.getElementById('bmSelModeBtn')?.addEventListener('click', () => {
  if (_bmSelMode) _exitBmSelMode();
  else _enterBmSelMode(null);
});

document.getElementById('bmSelCancelBtn')?.addEventListener('click', () => _exitBmSelMode());

// Selected bookmark URLs, in on-screen order. Reads from _bmItems (the full
// list), not the DOM, since only a window of rows is rendered at any time.
function _bmSelectedUrls() {
  const urls = [];
  for (const item of _bmItems) {
    if (_bmSelected.has(item.id) && item.url) urls.push(item.url);
  }
  return urls;
}

document.getElementById('bmSelOpenBtn')?.addEventListener('click', () => {
  const urls = _bmSelectedUrls();
  if (!urls.length) return;
  if (urls.length > 15 && !confirm(`Open ${urls.length} bookmarks in new tabs?`)) return;
  // Background tabs, same as a normal click — keeps focus on this page
  for (const url of urls) chrome.tabs.create({ url, active: false });
  toast(`Opened ${urls.length} tab${urls.length === 1 ? '' : 's'}`, 'ok');
  _exitBmSelMode();
});

document.getElementById('bmSelCopyBtn')?.addEventListener('click', async () => {
  const urls = _bmSelectedUrls();
  if (!urls.length) return;
  try {
    await navigator.clipboard.writeText(urls.join(' \r\n'));
    toast(`Copied ${urls.length} link${urls.length === 1 ? '' : 's'}`, 'ok');
    _exitBmSelMode();
  } catch {
    toast('Clipboard access denied', 'err');
  }
});

document.getElementById('bmSelDeleteBtn')?.addEventListener('click', async () => {
  if (!_bmSelected.size) return;
  const ids = [..._bmSelected];
  if (!confirm(`Delete ${ids.length} bookmark${ids.length === 1 ? '' : 's'}?`)) return;
  let failed = 0;
  for (const id of ids) {
    const r = await send('DELETE_BOOKMARK', { id });
    if (r?.error) failed++;
  }
  _exitBmSelMode();
  toast(failed ? `Deleted with ${failed} error(s)` : `Deleted ${ids.length} bookmark${ids.length === 1 ? '' : 's'}`, failed ? 'err' : 'ok');
  await reloadBookmarksKeepState();
});

document.getElementById('bmSelMoveBtn')?.addEventListener('click', () => {
  if (!_bmSelected.size) return;
  _openBmMoveModal();
});

// ── Move-to-folder modal ─────────────────────────────────────────────────────
let _bmMoveSelectedFolder = null; // folder node selected in modal

function _buildFolderList(nodes, depth, container) {
  for (const n of nodes) {
    if (n.url) continue;
    const row = document.createElement('div');
    row.className = 'bm-move-folder-row';
    row.style.paddingLeft = (14 + depth * 16) + 'px';
    row.innerHTML = `<span style="font-size:14px">📁</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.title || 'Folder')}</span>`;
    row.addEventListener('click', () => {
      container.querySelectorAll('.bm-move-folder-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      _bmMoveSelectedFolder = n;
    });
    container.appendChild(row);
    if (n.children) _buildFolderList(n.children, depth + 1, container);
  }
}

function _openBmMoveModal() {
  _bmMoveSelectedFolder = null;
  const modal  = document.getElementById('bmMoveModal');
  const list   = document.getElementById('bmMoveFolderList');
  if (!modal || !list) return;
  list.innerHTML = '';
  // Root entry
  const rootRow = document.createElement('div');
  rootRow.className = 'bm-move-folder-row';
  rootRow.innerHTML = `<span style="font-size:14px">📚</span><span>Bookmarks Bar (root)</span>`;
  rootRow.addEventListener('click', () => {
    list.querySelectorAll('.bm-move-folder-row').forEach(r => r.classList.remove('selected'));
    rootRow.classList.add('selected');
    _bmMoveSelectedFolder = { id: '1' };
  });
  list.appendChild(rootRow);
  if (_bmTree) _buildFolderList(bmRootChildren(), 0, list);
  modal.classList.add('open');
}

document.getElementById('bmMoveCancelBtn')?.addEventListener('click', () => {
  document.getElementById('bmMoveModal').classList.remove('open');
  _bmMoveSelectedFolder = null;
});

document.getElementById('bmMoveConfirmBtn')?.addEventListener('click', async () => {
  if (!_bmMoveSelectedFolder) { toast('Please select a destination folder', 'err'); return; }
  const ids = [..._bmSelected];
  const parentId = _bmMoveSelectedFolder.id;
  let failed = 0;
  for (const id of ids) {
    const r = await send('MOVE_BOOKMARK', { id, parentId });
    if (r?.error) failed++;
  }
  document.getElementById('bmMoveModal').classList.remove('open');
  _exitBmSelMode();
  toast(failed ? `Moved with ${failed} error(s)` : `Moved ${ids.length} bookmark${ids.length === 1 ? '' : 's'}`, failed ? 'err' : 'ok');
  await reloadBookmarksKeepState(false);
});

// Close modal on backdrop click
document.getElementById('bmMoveModal')?.addEventListener('click', ev => {
  if (ev.target === document.getElementById('bmMoveModal')) {
    document.getElementById('bmMoveModal').classList.remove('open');
    _bmMoveSelectedFolder = null;
  }
});

// ── Bookmark export (HTML format compatible with browsers) ───────────────────

document.getElementById('exportBmBtn').addEventListener('click', async () => {
  try {
    const { tree } = await send('GET_BOOKMARKS');
    const html = buildNetscapeHtml(tree);
    const blob = new Blob([html], { type: 'text/html' });
    const a    = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
                               download: `bookmarks_${new Date().toISOString().slice(0,10)}.html`
    });
    a.click();
    toast('Bookmarks exported', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

function buildNetscapeHtml(tree) {
  // Top-level folders are tagged with their root type so import can put them back
  // into the bookmarks bar / other bookmarks / mobile bookmarks whatever the UI language.
  const rootType = n => n.folderType || ({ '1': 'bookmarks-bar', '2': 'other', '3': 'mobile' })[n.id] || '';
  function walk(nodes, depth, atRoot) {
    let s = '';
    const pad = '    '.repeat(depth);
    for (const n of nodes) {
      if (n.url) {
        s += `${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${Math.floor((n.dateAdded||Date.now())/1000)}">${esc(n.title||n.url)}</A>\n`;
      } else if (n.children) {
        const rt = atRoot ? rootType(n) : '';
        const attrs = rt ? ` DATA-EH-ROOT="${rt}"` + (rt === 'bookmarks-bar' ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '') : '';
        s += `${pad}<DT><H3${attrs}>${esc(n.title||'')}</H3>\n`;
        s += `${pad}<DL><p>\n`;
        s += walk(n.children, depth + 1, false);
        s += `${pad}</DL><p>\n`;
      }
    }
    return s;
  }
  const top = (tree[0] && !tree[0].url && !tree[0].title && tree[0].children) ? tree[0].children : tree;
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- Exported by Extended History -->\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${walk(top, 1, true)}</DL><p>`;
}

// Bookmark import
document.getElementById('importBmBtn').addEventListener('click', () => {
  document.getElementById('importBmFile').click();
});

document.getElementById('importBmFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const tree = parseNetscapeBookmarks(text);
    if (!tree.length) { toast('No bookmarks found in file', 'err'); return; }
    const r = await send('IMPORT_BOOKMARKS', { tree });
    toast(`Imported ${fmtNum(r.imported)} bookmarks`, 'ok');
    loadBookmarks();
    ev.target.value = '';
  } catch (err) { toast(err.message, 'err'); }
});

// Parses a Netscape bookmark file into a tree: { title, url } / { title, children, rootType? }
function parseNetscapeBookmarks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function parseDL(dl) {
    const out = [];
    const kids = Array.from(dl.children);
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (el.tagName === 'DT') {
        const h3 = el.querySelector(':scope > h3');
        const a  = el.querySelector(':scope > a');
        if (h3) {
          let sub = el.querySelector(':scope > dl');
          if (!sub && kids[i + 1] && kids[i + 1].tagName === 'DL') { sub = kids[i + 1]; i++; }
          const node = { title: h3.textContent.trim(), children: sub ? parseDL(sub) : [] };
          const eh = (h3.getAttribute('data-eh-root') || '').toLowerCase();
          if (eh) node.rootType = eh;
          else if (h3.hasAttribute('personal_toolbar_folder')) node.rootType = 'bookmarks-bar';
          out.push(node);
        } else if (a && a.getAttribute('href')) {
          out.push({ title: a.textContent.trim(), url: a.getAttribute('href') });
        }
      } else if (el.tagName === 'DL') {
        out.push(...parseDL(el));
      }
    }
    return out;
  }
  const top = doc.querySelector('dl');
  return top ? parseDL(top) : [];
}

// ══ SETTINGS ════════════════════════════════════════════════════════════════
document.getElementById('retChips').addEventListener('click', ev => {
  if (!ev.target.dataset.d) return;
  document.getElementById('retDays').value = ev.target.dataset.d;
  syncRetChips(parseInt(ev.target.dataset.d));
});
document.getElementById('retDays').addEventListener('input', () => {
  syncRetChips(parseInt(document.getElementById('retDays').value));
});
function syncRetChips(days) {
  document.querySelectorAll('#retChips .chip').forEach(c =>
  c.classList.toggle('on', parseInt(c.dataset.d) === days));
}

document.getElementById('fontSel').addEventListener('change', () => {
  document.documentElement.style.setProperty('--font', document.getElementById('fontSel').value);
});
document.getElementById('fontSzInput').addEventListener('input', () => {
  const sz = parseInt(document.getElementById('fontSzInput').value);
  if (sz >= 11 && sz <= 22) document.documentElement.style.setProperty('--fsize', sz + 'px');
});

document.getElementById('toolbarIconGrid')?.addEventListener('click', ev => {
  const btn = ev.target.closest('.icon-opt');
  if (!btn) return;
  document.querySelectorAll('#toolbarIconGrid .icon-opt').forEach(b => {
    const on = b === btn;
    b.classList.toggle('on', on);
    b.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
  });
});

function setupColorPicker(swId, picId, hexId, presetsId, cssVar) {
  const sw  = document.getElementById(swId);
  const pic = document.getElementById(picId);
  const hex = document.getElementById(hexId);

  sw.addEventListener('click', () => pic.click());
  pic.addEventListener('input', () => {
    const c = pic.value;
    sw.style.background = c;
    hex.textContent     = c;
    document.documentElement.style.setProperty(cssVar, c);
    syncCps();
  });
  document.getElementById(presetsId).addEventListener('click', ev => {
    const c = ev.target.dataset.c;
    if (!c) return;
    pic.value = c;
    sw.style.background = c;
    hex.textContent     = c;
    document.documentElement.style.setProperty(cssVar, c);
    syncCps();
  });
}
setupColorPicker('sw1','cp1','ch1','cps1','--accent');
setupColorPicker('sw2','cp2','ch2','cps2','--accent2');

function syncCps() {
  const c1 = document.getElementById('cp1').value;
  const c2 = document.getElementById('cp2').value;
  document.querySelectorAll('#cps1 .cs').forEach(x => x.classList.toggle('on', x.dataset.c === c1));
  document.querySelectorAll('#cps2 .cs').forEach(x => x.classList.toggle('on', x.dataset.c === c2));
}

function populateSettings(s) {
  const followTgl = document.getElementById('followSystemThemeToggle');
  if (followTgl) followTgl.checked = s.followSystemTheme === true;
  if (s.retentionDays) { document.getElementById('retDays').value = s.retentionDays; syncRetChips(s.retentionDays); }
  if (s.maxSessions)   { const el = document.getElementById('maxSessionsInput'); if (el) el.value = s.maxSessions; }
  if (s.fontSize)       document.getElementById('fontSzInput').value = s.fontSize;
  if (s.font) {
    const sel = document.getElementById('fontSel');
    const opt = [...sel.options].find(o => o.value === s.font);
    if (opt) sel.value = s.font;
  }
  const c1 = s.accentColor  || '#3b9eff';
  const c2 = s.accentColor2 || '#2dd4a0';
  ['sw1','cp1','ch1'].forEach(() => {});
  document.getElementById('sw1').style.background = c1;
  document.getElementById('sw2').style.background = c2;
  document.getElementById('cp1').value = c1;
  document.getElementById('cp2').value = c2;
  document.getElementById('ch1').textContent = c1;
  document.getElementById('ch2').textContent = c2;
  syncCps();
  
  // Populate background tint settings
  const bgTintToggle = document.getElementById('bgTintToggle');
  const bgTintHue = document.getElementById('bgTintHue');
  const bgTintOpacity = document.getElementById('bgTintOpacity');
  const bgTintHueVal = document.getElementById('bgTintHueVal');
  const bgTintOpacityVal = document.getElementById('bgTintOpacityVal');
  
  if (bgTintToggle) bgTintToggle.checked = s.bgTintEnabled || false;
  if (bgTintHue) {
    bgTintHue.value = s.bgTintHue !== undefined ? s.bgTintHue : 220;
    if (bgTintHueVal) bgTintHueVal.textContent = bgTintHue.value + '°';
  }
  if (bgTintOpacity) {
    bgTintOpacity.value = s.bgTintOpacity !== undefined ? s.bgTintOpacity : 8;
    if (bgTintOpacityVal) bgTintOpacityVal.textContent = bgTintOpacity.value + '%';
  }


  // Populate popup settings
  const popupSearchToggle = document.getElementById('popupSearchToggle');
  const popupTabsToggle   = document.getElementById('popupTabsToggle');
  const popupURLsToggle   = document.getElementById('popupURLsToggle');
  const popupHeightInput  = document.getElementById('popupHeightInput');
  const popupHeightVal    = document.getElementById('popupHeightVal');
  const popupSidebarToggle = document.getElementById('popupSidebarToggle');
  if (popupSearchToggle) popupSearchToggle.checked = s.popupShowSearch !== false;
  if (popupTabsToggle)   popupTabsToggle.checked   = s.popupShowTabs   !== false;
  if (popupURLsToggle)   popupURLsToggle.checked   = s.popupShowUrl   !== false;
  { const t = document.getElementById('popupSearchLimitToggle'), m = document.getElementById('popupSearchLimitMonths');
    if (t) t.checked = s.popupSearchLimitEnabled === true;
    if (m) m.value = s.popupSearchLimitMonths || 12; }
  if (popupHeightInput)  {
    popupHeightInput.value = s.popupHeight || 320;
    if (popupHeightVal) popupHeightVal.textContent = popupHeightInput.value + 'px';
  }
  if (popupSidebarToggle) {
    popupSidebarToggle.checked = s.popupAsSidebar === true;
    const row = document.getElementById('popupHeightRow');
    if (row) row.style.opacity = s.popupAsSidebar === true ? '0.4' : '';
  }
  const popupQuickFiltersToggle = document.getElementById('popupQuickFiltersToggle');
  if (popupQuickFiltersToggle) popupQuickFiltersToggle.checked = s.popupQuickFilters !== false;
  const sidebarAutoHideToggle = document.getElementById('sidebarAutoHideToggle');
  if (sidebarAutoHideToggle) sidebarAutoHideToggle.checked = s.sidebarAutoHide !== false;

  // Populate UI settings
  const faviconSel = document.getElementById('faviconResolverSel');
  if (faviconSel) faviconSel.value = s.faviconResolver || 'google';
  const autoFocusTgl = document.getElementById('searchAutoFocusToggle');
  if (autoFocusTgl) autoFocusTgl.checked = s.searchAutoFocus !== false;
  const highContrastTgl = document.getElementById('highContrastToggle');
  if (highContrastTgl) highContrastTgl.checked = s.highContrastMode === true;
  const roundedCornersTgl = document.getElementById('roundedCornersToggle');
  if (roundedCornersTgl) roundedCornersTgl.checked = s.roundedCorners !== false;
  const navIconsTgl = document.getElementById('navIconsToggle');
  if (navIconsTgl) navIconsTgl.checked = s.navIcons !== false;
  const matchUiColorsTgl = document.getElementById('matchUiColorsToggle');
  if (matchUiColorsTgl) matchUiColorsTgl.checked = s.matchUiColors === true;
  const calendarModeTgl = document.getElementById('calendarModeToggle');
  if (calendarModeTgl) calendarModeTgl.checked = s.calendarMode === true;
  const fadeInListTgl = document.getElementById('fadeInListToggle');
  if (fadeInListTgl) fadeInListTgl.checked = s.fadeInListOnDateChange !== false;
  _fadeInListEnabled = s.fadeInListOnDateChange !== false;
  const contextMenuTgl = document.getElementById('contextMenuToggle');
  if (contextMenuTgl) contextMenuTgl.checked = s.contextMenuEnabled !== false;

  const datePillsWheelTgl = document.getElementById('datePillsWheelToggle');
  if (datePillsWheelTgl) datePillsWheelTgl.checked = s.datePillsWheelScroll === true;
  const datePillsWheelSensInput = document.getElementById('datePillsWheelSensInput');
  const datePillsWheelSensVal   = document.getElementById('datePillsWheelSensVal');
  const wheelSensitivity = Math.max(1, Math.min(6, parseInt(s.datePillsWheelSensitivity) || 1));
  if (datePillsWheelSensInput) datePillsWheelSensInput.value = wheelSensitivity;
  if (datePillsWheelSensVal)   datePillsWheelSensVal.textContent = `${wheelSensitivity} day${wheelSensitivity === 1 ? '' : 's'}/click`;
  const wheelSensRow = document.getElementById('datePillsWheelSensRow');
  if (wheelSensRow) wheelSensRow.style.opacity = s.datePillsWheelScroll === true ? '' : '0.4';
  applyDatePillsWheelScroll(s.datePillsWheelScroll === true, wheelSensitivity);

  // Auto export interval
  const autoExportInput = document.getElementById('autoExportInput');
  if (autoExportInput) autoExportInput.value = s.autoExportIntervalMonths || 0;
  const autoExportModeSel = document.getElementById('autoExportMode');
  if (autoExportModeSel) autoExportModeSel.value = s.autoExportMode === 'incremental' ? 'incremental' : 'full';
  const autoExportZipChk = document.getElementById('autoExportZip');
  if (autoExportZipChk) autoExportZipChk.checked = s.autoExportZip === true;
  const autoExportDestSel = document.getElementById('autoExportDestination');
  if (autoExportDestSel) autoExportDestSel.value = ['local', 'webdav', 'both'].includes(s.autoExportDestination) ? s.autoExportDestination : 'local';
  const autoExportWebDavUrl = document.getElementById('autoExportWebDavUrl');
  if (autoExportWebDavUrl) autoExportWebDavUrl.value = s.autoExportWebDavUrl || '';
  const autoExportWebDavUsername = document.getElementById('autoExportWebDavUsername');
  if (autoExportWebDavUsername) autoExportWebDavUsername.value = s.autoExportWebDavUsername || '';
  const autoExportWebDavPassword = document.getElementById('autoExportWebDavPassword');
  if (autoExportWebDavPassword) autoExportWebDavPassword.value = s.autoExportWebDavPassword || '';
  updateAutoExportDestinationUi();
  ehInitBackupExtras(s);
  ehInitAlwaysEnc(s);
  refreshAutoExportStatus();

  // Populate toolbar icon picker
  const selectedIcon = s.toolbarIcon || 'default';
  document.querySelectorAll('#toolbarIconGrid .icon-opt').forEach(btn => {
    const on = btn.dataset.icon === selectedIcon;
    btn.classList.toggle('on', on);
    btn.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
  });

  // Performance
  const timeTrackTgl = document.getElementById('timeTrackingToggle');
  if (timeTrackTgl) timeTrackTgl.checked = s.timeTrackingEnabled !== false;
  applyTimeTrackingState(s.timeTrackingEnabled !== false);
  const syncIntervalInput = document.getElementById('syncIntervalInput');
  if (syncIntervalInput) syncIntervalInput.value = typeof s.syncInterval === 'number' ? s.syncInterval : 30;

  // Auto-store idle tabs
  const autoStoreTgl = document.getElementById('autoStoreToggle');
  const autoStoreHrsInput = document.getElementById('autoStoreHoursInput');
  const autoStoreHrsRow   = document.getElementById('autoStoreHoursRow');
  if (autoStoreTgl) {
    autoStoreTgl.checked = s.autoStoreEnabled === true;
    if (autoStoreHrsRow) autoStoreHrsRow.style.display = s.autoStoreEnabled ? '' : 'none';
  }
  if (autoStoreHrsInput) autoStoreHrsInput.value = typeof s.autoStoreHours === 'number' ? s.autoStoreHours : 6;
}

function applyTimeTrackingState(enabled) {
  const navItem = document.querySelector('.nav-item[data-panel="timespent"]');
  if (!navItem) return;
  navItem.style.opacity = enabled ? '' : '0.2';
  navItem.style.pointerEvents = enabled ? '' : 'none';
  navItem.title = enabled ? '' : 'Time Spent tracking is disabled in Settings';
}

// ── Toolbar icon variants (kept in sync with background.js TOOLBAR_ICON_FILES) ─
const ICON_VARIANT_FILES = {
  default: '/icons/icon128.png',
  bw:      '/icons/icon_bw.png',
  emerald: '/icons/icon_emerlad.png',
  green:   '/icons/icon_green.png',
  gold:    '/icons/icon_gold.png',
  pink:    '/icons/icon_pink.png',
  red:     '/icons/icon_red.png',
  purple:     '/icons/icon_purple.png',
  orange:     '/icons/icon_orange.png',
  blue:     '/icons/icon_darkblue.png',
};
function applyIconVariant(variant) {
  const file = ICON_VARIANT_FILES[variant] || ICON_VARIANT_FILES.default;
  const img = document.querySelector('.logo-icon');
  if (img) img.src = file;
}

function applyVisuals(s) {
  const r = document.documentElement;
  if (s.accentColor)  r.style.setProperty('--accent',  s.accentColor);
  if (s.accentColor2) r.style.setProperty('--accent2', s.accentColor2);
  if (s.fontSize)     r.style.setProperty('--fsize',   s.fontSize + 'px');
  if (s.font)         r.style.setProperty('--font',    s.font);
  applyThemeSettings(s);
  applyRoundedCorners(s.roundedCorners !== false);
  applyNavIcons(s.navIcons !== false);
  applyMatchUiColors(s.matchUiColors === true);
  applyCalendarMode(s.calendarMode === true);
  applyIconVariant(s.toolbarIcon || 'default');
  
  // Apply background tint: hue-rotate filter on the wallpaper layer.
  // The layer itself stays unblurred — blur now lives on the glass panels
  // (see applyWallpaper), so this only ever touches hue-rotate.
  const wpLayer = document.getElementById('eh-wallpaper-layer');
  if (s.bgTintEnabled && s.bgTintHue !== undefined) {
    const hueRot = s.bgTintHue;
    if (wpLayer) wpLayer.style.filter = `hue-rotate(${hueRot}deg)`;
    r.style.setProperty('--bg-tint-hue', hueRot + 'deg');
  } else {
    if (wpLayer) wpLayer.style.removeProperty('filter');
    r.style.removeProperty('--bg-tint-hue');
  }
}
// ── Storage backend migration ─────────────────────────────────────────────────
const EH_BACKEND_NAMES = { local: 'Local Storage', idb: 'IndexedDB', sqlite: 'SQLite' };

async function loadStorageBackend() {
  try {
    const r = await send('GET_STORAGE_BACKEND');
    const backend = r.backend || 'local';
    const sel = document.getElementById('storageBackendSel');
    const lbl = document.getElementById('storageBackendLabel');
    if (sel) sel.value = backend;
    if (lbl) { lbl.textContent = EH_BACKEND_NAMES[backend] || backend; lbl.dataset.backend = backend; }
  } catch {}
}

async function migrateStorage() {
  const sel    = document.getElementById('storageBackendSel');
  const status = document.getElementById('migrateStorageStatus');
  const btn    = document.getElementById('migrateStorageBtn');
  const lbl    = document.getElementById('storageBackendLabel');
  if (!sel) return;

  const target = sel.value;
  const currentBackend = lbl?.dataset.backend || 'local';
  const nameOf = (k) => EH_BACKEND_NAMES[k] || k;

  if (target === currentBackend) {
    toast('Already using ' + nameOf(target), 'ok');
    return;
  }
  if (!confirm(`Migrate history to ${nameOf(target)}? This may take a while for large histories — keep this tab open. ` +
               `The old copy is deleted once the move is complete (so it does not take up disk space); you can move back at any time.`)) return;

  btn.disabled = true;
  btn.textContent = 'Migrating…';
  if (status) status.textContent = 'Please wait…';
  const onProgress = (m) => { if (m && m.type === 'MIGRATE_PROGRESS' && status) status.textContent = (m.phase && m.phase !== 'copying') ? ({ reading: 'Reading your history…', starting: 'Starting the database…', verifying: 'Checking the copy…', finishing: 'Finishing up…' }[m.phase] || 'Please wait…') : `Copied ${fmtNum(m.done)} of ${fmtNum(m.total)} entries…`; };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    const type = target === 'sqlite' ? 'MIGRATE_TO_SQLITE' : (target === 'idb' ? 'MIGRATE_TO_IDB' : 'MIGRATE_TO_LOCAL');
    const r = await sendLong(type);
    if (r.error) throw new Error(r.error);
    if (lbl) { lbl.textContent = nameOf(target); lbl.dataset.backend = target; }
    if (status) status.textContent = `✓ Migrated ${fmtNum(r.migrated)} entries`;
    toastLong(`Migrated ${fmtNum(r.migrated)} entries to ${nameOf(target)}`, 'ok');
    doSearch();
  } catch(err) {
    if (status) status.textContent = '✗ Migration failed: ' + err.message;
    toastLong('Migration failed: ' + err.message, 'err');
    if (sel) sel.value = currentBackend;
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    btn.disabled = false;
    btn.textContent = tr('apply_migrate', 'Apply & Migrate');
  }
}

// Returns true when everything was saved (used by the unsaved-changes prompt too).
async function saveSettings() {
  const days    = parseInt(document.getElementById('retDays').value);
  const c1      = document.getElementById('cp1').value;
  const c2      = document.getElementById('cp2').value;
  const font    = document.getElementById('fontSel').value;
  const sz      = parseInt(document.getElementById('fontSzInput').value);
  const maxSess = parseInt(document.getElementById('maxSessionsInput')?.value || '4');
  const bgTintEnabled = document.getElementById('bgTintToggle')?.checked || false;
  const bgTintHue = parseInt(document.getElementById('bgTintHue')?.value || '220');
  const bgTintOpacity = parseInt(document.getElementById('bgTintOpacity')?.value || '8');
  const popupShowSearch = document.getElementById('popupSearchToggle')?.checked !== false;
  const popupShowTabs   = document.getElementById('popupTabsToggle')?.checked   !== false;
  const popupShowUrl   = document.getElementById('popupURLsToggle')?.checked   !== false;
  const popupSearchLimitEnabled = document.getElementById('popupSearchLimitToggle')?.checked === true;
  const popupSearchLimitMonths  = Math.max(1, Math.min(600, parseInt(document.getElementById('popupSearchLimitMonths')?.value || '12') || 12));
  const popupHeight     = parseInt(document.getElementById('popupHeightInput')?.value || '320');
  const popupAsSidebar  = document.getElementById('popupSidebarToggle')?.checked === true;
  const popupQuickFilters = document.getElementById('popupQuickFiltersToggle')?.checked === true;
  const sidebarAutoHide = document.getElementById('sidebarAutoHideToggle')?.checked !== false;
  const faviconResolver = document.getElementById('faviconResolverSel')?.value || 'google';
  const searchAutoFocus = document.getElementById('searchAutoFocusToggle')?.checked !== false;
  const highContrastMode = document.getElementById('highContrastToggle')?.checked === true;
  const roundedCorners = document.getElementById('roundedCornersToggle')?.checked !== false;
  const navIcons = document.getElementById('navIconsToggle')?.checked !== false;
  const matchUiColors = document.getElementById('matchUiColorsToggle')?.checked === true;
  const calendarMode = document.getElementById('calendarModeToggle')?.checked === true;
  const fadeInListOnDateChange = document.getElementById('fadeInListToggle')?.checked !== false;
  const contextMenuEnabled = document.getElementById('contextMenuToggle')?.checked !== false;
  const datePillsWheelScroll = document.getElementById('datePillsWheelToggle')?.checked === true;
  const datePillsWheelSensitivity = Math.max(1, Math.min(6, parseInt(document.getElementById('datePillsWheelSensInput')?.value || '1') || 1));
  const toolbarIcon = document.querySelector('#toolbarIconGrid .icon-opt.on')?.dataset.icon || 'default';
  const autoExportIntervalMonths = Math.max(0, Math.min(60, parseInt(document.getElementById('autoExportInput')?.value || '0') || 0));
  const autoExportMode = document.getElementById('autoExportMode')?.value === 'incremental' ? 'incremental' : 'full';
  const autoExportZip  = document.getElementById('autoExportZip')?.checked === true;
  const autoExportDestination = ['local', 'webdav', 'both'].includes(document.getElementById('autoExportDestination')?.value)
    ? document.getElementById('autoExportDestination').value
    : 'local';
  const autoExportWebDavUrl = document.getElementById('autoExportWebDavUrl')?.value.trim() || '';
  const autoExportWebDavUsername = document.getElementById('autoExportWebDavUsername')?.value || '';
  const autoExportWebDavPassword = document.getElementById('autoExportWebDavPassword')?.value || '';
  
  if (!days || days < 1) { toast('Invalid retention', 'err'); return false; }
  if ((autoExportDestination === 'webdav' || autoExportDestination === 'both') && autoExportIntervalMonths > 0) {
    if (!autoExportWebDavUrl) { toast('Enter a WebDAV URL', 'err'); return false; }
    if (!await ensureWebDavPermission(autoExportWebDavUrl)) return false;
  }
  try {
    const r = await send('SAVE_SETTINGS', { 
      settings: { 
        retentionDays: days, 
        accentColor: c1, 
        accentColor2: c2, 
        font, 
        fontSize: sz, 
        theme: _curSettings.theme || 'dark',
        followSystemTheme: document.getElementById('followSystemThemeToggle')?.checked === true,
        bgTintEnabled,
        bgTintHue,
        bgTintOpacity,
        popupShowSearch,
        popupShowTabs,
        popupShowUrl,
        popupSearchLimitEnabled,
        popupSearchLimitMonths,
        popupHeight,
        popupAsSidebar,
        popupQuickFilters,
        sidebarAutoHide,
        faviconResolver,
        searchAutoFocus,
        contextMenuEnabled,
        datePillsWheelScroll,
        highContrastMode,
        roundedCorners,
        navIcons,
        matchUiColors,
        calendarMode,
        fadeInListOnDateChange,
        datePillsWheelSensitivity,
        toolbarIcon,
        autoExportIntervalMonths,
        autoExportMode,
        autoExportZip,
        autoExportDestination,
        autoExportWebDavUrl,
        autoExportWebDavUsername,
        autoExportWebDavPassword,
        timeTrackingEnabled: document.getElementById('timeTrackingToggle')?.checked !== false,
        syncInterval: Math.max(1, Math.min(1440, parseInt(document.getElementById('syncIntervalInput')?.value || '30') || 30)),
        autoStoreEnabled: document.getElementById('autoStoreToggle')?.checked === true,
        autoStoreHours: Math.max(1, Math.min(168, parseInt(document.getElementById('autoStoreHoursInput')?.value || '6') || 6))
      } 
    });
    _curSettings = r.settings;
    applyThemeSettings(_curSettings);
    applyIconVariant(_curSettings.toolbarIcon || 'default');
    applyDatePillsWheelScroll(_curSettings.datePillsWheelScroll === true, _curSettings.datePillsWheelSensitivity);
    applyHighContrastMode(_curSettings.highContrastMode === true);
    // Mirror to localStorage (shared across this extension's pages) so the
    // popup's pre-paint inline script can size itself correctly on its very
    // first paint next time it's opened, instead of resizing (and flashing)
    // once its own async chrome.storage.local read comes back.
    try { localStorage.setItem('eh_popup_qf', popupQuickFilters ? '1' : '0'); } catch (e) {}
    // Save max sessions separately
    if (maxSess >= 1 && maxSess <= 20) await send('SET_MAX_SESSIONS', { value: maxSess });
    // Save auto-save interval
    const autoSaveMins = parseInt(document.getElementById('autoSaveInput')?.value || '0');
    await send('SET_AUTO_SAVE_INTERVAL', { minutes: autoSaveMins });
    toast('Settings saved', 'ok');
    refreshAutoExportStatus();
    snapshotSettings();
    return true;
  } catch (err) { toast(err.message, 'err'); return false; }
}
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

// ── Auto export interval ──────────────────────────────────────────────────────
function updateAutoExportDestinationUi() {
  const dest = document.getElementById('autoExportDestination')?.value || 'local';
  const fields = document.getElementById('autoExportWebDavFields');
  if (fields) fields.style.display = (dest === 'webdav' || dest === 'both') ? 'flex' : 'none';
  const zip = document.getElementById('autoExportZip');
  if (zip) {
    zip.disabled = dest === 'webdav';
    zip.title = dest === 'webdav' ? 'WebDAV uploads are saved as JSON' : '';
  }
}

async function ensureWebDavPermission(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const origin = u.origin + '/*';
    if (!chrome.permissions || !chrome.permissions.request) return true;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    const ok = await chrome.permissions.request({ origins: [origin] });
    if (!ok) toast('WebDAV server permission was not granted', 'err');
    return ok;
  } catch {
    toast('Invalid WebDAV URL', 'err');
    return false;
  }
}

// The "Compress as .zip" checkbox is markup-named compress_as_zip, but the settings code looks for autoExportZip.
{ const z = document.getElementById('compress_as_zip'); if (z && !document.getElementById('autoExportZip')) z.id = 'autoExportZip'; }
document.getElementById('autoExportDestination')?.addEventListener('change', updateAutoExportDestinationUi);

// Delegated (capture) so nothing around the field can swallow the click.
document.addEventListener('click', (ev) => {
  const eye = ev.target.closest && ev.target.closest('#autoExportWebDavEye');
  if (!eye) return;
  ev.preventDefault();
  const i = document.getElementById('autoExportWebDavPassword');
  if (!i) return;
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  eye.setAttribute('aria-pressed', show ? 'true' : 'false');
  eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  eye.textContent = show ? '🙈' : '👁';
}, true);

// Test the WebDAV settings currently typed in: uploads a tiny file, then removes it again.
document.getElementById('testWebDavBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('testWebDavBtn');
  const out = document.getElementById('webDavTestResult');
  const url = document.getElementById('autoExportWebDavUrl')?.value.trim() || '';
  const username = document.getElementById('autoExportWebDavUsername')?.value || '';
  const password = document.getElementById('autoExportWebDavPassword')?.value || '';
  const show = (t, c) => { if (out) { out.textContent = t; out.className = 'wd-result ' + (c || ''); } };
  if (!url) { show('Enter the server URL first.', 'err'); return; }
  if (!await ensureWebDavPermission(url)) { show('Permission for this server was not granted.', 'err'); return; }
  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Testing…'; show('Uploading a test file…');
  try {
    const r = await send('TEST_WEBDAV', { url, username, password });
    if (r.ok) { show('✓ ' + r.message + (r.ms ? ' (' + r.ms + ' ms)' : ''), 'ok'); toast('WebDAV upload works', 'ok'); }
    else { show('✗ ' + r.message, 'err'); toast('WebDAV test failed', 'err'); }
  } catch (e) { show('✗ ' + e.message, 'err'); }
  btn.disabled = false; btn.textContent = orig;
});

// ── Incremental backup extras (built here, the page markup is untouched) ─────────────────────────────────
// • "Encrypt incremental exports with a password": the stored AES key is the double hash of the password (see
//   ehDoubleHashBytes); importing such a file asks for the password.
// • "Re-download last incremental backup": rebuilds the file of the last incremental export.
function ehInitBackupExtras(s) {
  const status = document.getElementById('autoExportStatus');
  if (!status || !status.parentElement) return;
  let box = document.getElementById('ehIncExtras');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ehIncExtras';
    box.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:6px';
    box.innerHTML =
      '<div id="ehEncBox" style="display:none;flex-direction:column;align-items:flex-end;gap:4px">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;cursor:pointer"><input type="checkbox" id="ehEncChk"/> <span id="ehEncLbl"></span></label>' +
        '<button type="button" class="action-btn" id="ehEncChangeBtn" style="font-size:0.72rem;padding:3px 8px;display:none"></button>' +
        '<div id="ehEncNote" style="font-size:0.7rem;color:var(--text3);text-align:right;max-width:240px;line-height:1.4"></div>' +
      '</div>' +
      '<button type="button" class="action-btn" id="ehRedownloadBtn" style="font-size:0.75rem;padding:4px 10px"></button>' +
      '<div id="ehRedownloadNote" style="font-size:0.7rem;color:var(--text3);text-align:right;max-width:240px"></div>';
    status.parentElement.insertBefore(box, status);
    document.getElementById('ehEncLbl').textContent = tr('enc_incremental', 'Encrypt incremental exports with a password');
    document.getElementById('ehEncChangeBtn').textContent = tr('enc_change_pw', 'Change password');
    document.getElementById('ehRedownloadBtn').textContent = '⬇ ' + tr('redownload_last_incremental_backup', 'Re-download last incremental backup');

    const saveEnc = async (settings) => {
      const r = await send('SAVE_SETTINGS', { settings });
      _curSettings = Object.assign(_curSettings || {}, r.settings || settings);
      ehInitBackupExtras(_curSettings);
    };
    const askNewPassword = async () => {
      const pw = prompt(tr('enc_prompt_pw', 'Password for encrypting incremental exports (needed again to import them):'));
      if (!pw) return null;
      if (pw.length < 4) { toast(tr('lock_password_short', 'Password must be at least 4 characters'), 'err'); return null; }
      if (pw !== prompt(tr('lock_confirm_password', 'Confirm password'))) { toast(tr('lock_password_mismatch', 'Passwords do not match'), 'err'); return null; }
      return pw;
    };
    const setPassword = async () => {
      const pw = await askNewPassword();
      if (!pw) return false;
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await ehDoubleHashBytes(pw, salt);
      await saveEnc({ autoExportEncrypt: true, autoExportEncKey: _u8toB64(key), autoExportEncSalt: _u8toB64(salt) });
      toast(tr('enc_on', 'Incremental exports will be encrypted'), 'ok');
      return true;
    };
    document.getElementById('ehEncChk').addEventListener('change', async (ev) => {
      const chk = ev.target;
      try {
        if (chk.checked) { if (!(await setPassword())) chk.checked = false; }
        else {
          if (!confirm(tr('enc_off_confirm', 'Stop encrypting incremental exports? Already created encrypted files still need the password.'))) { chk.checked = true; return; }
          await saveEnc({ autoExportEncrypt: false, autoExportEncKey: '', autoExportEncSalt: '' });
          toast(tr('enc_off', 'Incremental exports are no longer encrypted'), 'ok');
        }
      } catch (err) { toast(err.message || String(err), 'err'); chk.checked = !chk.checked; }
    });
    document.getElementById('ehEncChangeBtn').addEventListener('click', async () => {
      try { await setPassword(); } catch (err) { toast(err.message || String(err), 'err'); }
    });
    document.getElementById('ehRedownloadBtn').addEventListener('click', async (ev) => {
      const b = ev.currentTarget, orig = b.textContent;
      b.disabled = true; b.textContent = tr('redownloading', 'Preparing…');
      try {
        const r = await sendLong('REDOWNLOAD_LAST_INCREMENTAL');
        toast(tr('redownload_done', 'Saved the last incremental backup ({0} entries)', fmtNum(r.exported)) + (r.encrypted ? ' (' + tr('encrypted', 'encrypted') + ')' : ''), 'ok');
      } catch (err) { toast(err.message || String(err), 'err'); }
      b.disabled = false; b.textContent = orig;
    });
    document.getElementById('autoExportMode')?.addEventListener('change', () => ehInitBackupExtras(_curSettings || {}));
  }
  const incr = document.getElementById('autoExportMode')?.value === 'incremental';
  const encOn = s.autoExportEncrypt === true && !!s.autoExportEncKey;
  document.getElementById('ehEncBox').style.display = incr ? 'flex' : 'none';
  document.getElementById('ehEncChk').checked = encOn;
  document.getElementById('ehEncChangeBtn').style.display = encOn ? '' : 'none';
  document.getElementById('ehEncNote').textContent = encOn
    ? tr('enc_note_on', 'Encrypted with AES-256. The key (a double hash of your password, not the password) is kept in this extension so exports can run on their own. Keep your password: importing asks for it.')
    : '';
  const last = s.autoExportLastIncremental;
  const rb = document.getElementById('ehRedownloadBtn');
  rb.disabled = !(last && last.until);
  document.getElementById('ehRedownloadNote').textContent = last && last.until
    ? tr('redownload_note', 'Last incremental backup: {0} · {1} entries').replace('{0}', new Date(last.until).toLocaleString()).replace('{1}', fmtNum(last.count || 0))
    : tr('no_incremental_backup_yet', 'No incremental backup made yet');
}

// ── Settings: "Always encrypt search/filtered exports" ──────────────────────
// Small modal with real password fields (prompt() would show the password in clear text).
function ehPasswordModal(title, withConfirm, note) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,8,12,0.55);backdrop-filter:blur(6px)';
    const card = document.createElement('div');
    card.style.cssText = 'width:100%;max-width:380px;box-sizing:border-box;padding:22px;border-radius:14px;background:var(--surf1,#18181f);color:var(--text,#f0eee8);border:1px solid var(--border2,rgba(255,255,255,.12));box-shadow:0 24px 80px rgba(0,0,0,.5)';
    const inp = 'display:block;width:100%;box-sizing:border-box;padding:10px 12px;margin-top:10px;border-radius:8px;outline:none;font-size:.9rem;background:var(--surf3,#1f1f28);color:inherit;border:1px solid var(--border2,rgba(255,255,255,.12))';
    card.innerHTML = '<div style="font-weight:700;font-size:1.05rem;margin-bottom:6px"></div>' +
      '<div style="font-size:.78rem;line-height:1.5;color:var(--text2,#a09eb0)"></div>' +
      '<input type="password" id="ehPm1" autocomplete="new-password" style="' + inp + '">' +
      (withConfirm ? '<input type="password" id="ehPm2" autocomplete="new-password" style="' + inp + '">' : '') +
      '<div id="ehPmErr" style="min-height:1.1em;margin-top:8px;font-size:.78rem;color:var(--danger,#f06060)"></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="action-btn" id="ehPmCancel" style="flex:1"></button><button class="action-btn" id="ehPmOk" style="flex:1;background:var(--accent);color:#fff"></button></div>';
    card.children[0].textContent = title;
    card.children[1].textContent = note || '';
    const $ = q => card.querySelector(q);
    $('#ehPm1').placeholder = tr('lock_password', 'Password');
    if (withConfirm) $('#ehPm2').placeholder = tr('lock_confirm_password', 'Confirm password');
    $('#ehPmCancel').textContent = tr('cancel', 'Cancel');
    $('#ehPmOk').textContent = tr('ok', 'OK');
    ov.appendChild(card); document.body.appendChild(ov);
    const done = v => { ov.remove(); resolve(v); };
    const submit = () => {
      const a = $('#ehPm1').value, err = $('#ehPmErr');
      if (withConfirm) {
        if (a.length < 4) { err.textContent = tr('lock_password_short', 'Password must be at least 4 characters'); return; }
        if (a !== $('#ehPm2').value) { err.textContent = tr('lock_password_mismatch', 'Passwords do not match'); return; }
      } else if (!a) { $('#ehPm1').focus(); return; }
      done(a);
    };
    $('#ehPmOk').addEventListener('click', submit);
    $('#ehPmCancel').addEventListener('click', () => done(null));
    ov.addEventListener('mousedown', e => { if (e.target === ov) done(null); });
    card.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') done(null); });
    setTimeout(() => $('#ehPm1').focus(), 30);
  });
}

function ehInitAlwaysEnc(s) {
  const tgl = document.getElementById('alwaysEncToggle');
  if (!tgl) return;
  const on = s.alwaysEncryptExports === true && !!s.exportEncKey;
  tgl.checked = on;
  const chg = document.getElementById('alwaysEncPwBtn');
  if (chg) chg.style.display = on ? '' : 'none';
  const st = document.getElementById('alwaysEncStatus');
  if (st) st.textContent = on ? tr('always_enc_on', 'Exports are encrypted with your export password.') : '';
  if (ehInitAlwaysEnc._wired) return;
  ehInitAlwaysEnc._wired = true;

  const save = async (settings) => {
    const r = await send('SAVE_SETTINGS', { settings });
    _curSettings = Object.assign(_curSettings || {}, (r && r.settings) || settings);
    ehInitAlwaysEnc(_curSettings);
  };
  const setPassword = async () => {
    const pw = await ehPasswordModal(
      tr('set_export_password', 'Set export password'), true,
      tr('set_export_password_note', 'Needed to import or open your exports. If you forget it, encrypted exports cannot be recovered.'));
    if (!pw) return false;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await ehDoubleHashBytes(pw, salt);
    await save({ alwaysEncryptExports: true, exportEncKey: _u8toB64(key), exportEncSalt: _u8toB64(salt) });
    return true;
  };
  tgl.addEventListener('change', async (ev) => {
    const chk = ev.target;
    try {
      if (chk.checked) {
        if (await setPassword()) toast(tr('always_enc_enabled', 'Exports will now be encrypted'), 'ok');
        else chk.checked = false;
      } else {
        if (!confirm(tr('always_enc_off_confirm', 'Stop encrypting exports? Files already encrypted still need the password.'))) { chk.checked = true; return; }
        await save({ alwaysEncryptExports: false, exportEncKey: '', exportEncSalt: '' });
        toast(tr('always_enc_disabled', 'Exports are no longer encrypted'), 'ok');
      }
    } catch (err) { toast(err.message || String(err), 'err'); chk.checked = !chk.checked; }
  });
  chg?.addEventListener('click', async () => {
    try { if (await setPassword()) toast(tr('always_enc_pw_changed', 'Export password changed'), 'ok'); }
    catch (err) { toast(err.message || String(err), 'err'); }
  });
}

async function refreshAutoExportStatus() {
  const el = document.getElementById('autoExportStatus');
  if (!el) return;
  try {
    const r = await send('GET_AUTO_EXPORT_STATUS');
    if (!r.enabled) { el.textContent = tr('disabled', 'Disabled'); return; }
    const parts = [];
    if (r.lastRunAt) parts.push(tr('last_export', 'Last export:')+('{0}').replace('{0}', new Date(r.lastRunAt).toLocaleDateString()));
    parts.push(Date.now() >= r.nextDueAt
      ? tr('auto_export_due', 'Due — will run on next check')
      : tr('auto_export_next', 'Next export: {0}').replace('{0}',new Date(r.nextDueAt).toLocaleDateString())
              );
    el.textContent = parts.join(' · ');
  } catch {
    el.textContent = '';
  }
}

document.getElementById('testAutoExportBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('testAutoExportBtn');
  const inputEl = document.getElementById('autoExportInput');
  const interval = Math.max(0, Math.min(60, parseInt(inputEl?.value || '0') || 0));
  if (interval <= 0) { toast('Enter a number of months above 0 first', 'err'); return; }

  const mode = document.getElementById('autoExportMode')?.value === 'incremental' ? 'incremental' : 'full';
  const zip  = document.getElementById('autoExportZip')?.checked === true;
  const destination = ['local', 'webdav', 'both'].includes(document.getElementById('autoExportDestination')?.value)
    ? document.getElementById('autoExportDestination').value
    : 'local';
  const webDavUrl = document.getElementById('autoExportWebDavUrl')?.value.trim() || '';
  const webDavUsername = document.getElementById('autoExportWebDavUsername')?.value || '';
  const webDavPassword = document.getElementById('autoExportWebDavPassword')?.value || '';
  if ((destination === 'webdav' || destination === 'both') && !webDavUrl) { toast('Enter a WebDAV URL first', 'err'); return; }
  if ((destination === 'webdav' || destination === 'both') && !await ensureWebDavPermission(webDavUrl)) return;
  const ok = confirm(mode === 'incremental'
    ? tr('auto_export_confirm_incr', 'This will export everything recorded since your last export. Nothing is deleted. Continue?')
    : tr('auto_export_confirm_full', 'This will export your full history. Nothing is deleted. Continue?'));
  if (!ok) return;

  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Running…';
  try {
    // Persist the interval so "Run now" always reflects what's currently typed in,
    // even if "Save Settings" was never clicked.
    await send('SAVE_SETTINGS', { settings: {
      autoExportIntervalMonths: interval,
      autoExportMode: mode,
      autoExportZip: zip,
      autoExportDestination: destination,
      autoExportWebDavUrl: webDavUrl,
      autoExportWebDavUsername: webDavUsername,
      autoExportWebDavPassword: webDavPassword,
    } });
    _curSettings.autoExportIntervalMonths = interval;
    _curSettings.autoExportMode = mode;
    _curSettings.autoExportZip = zip;
    _curSettings.autoExportDestination = destination;

    const r = await sendLong('TRIGGER_AUTO_EXPORT');
    if (r.success) {
      const target = r.uploaded && !r.downloaded ? ' to WebDAV' : (r.uploaded ? ' + WebDAV' : '');
      toast(tr('auto_export_done', 'Exported {0} entries', fmtNum(r.exported)) + target, 'ok');
    } else if (r.reason === 'empty' || r.reason === 'nothing_new') {
      toast(tr('auto_export_nothing_new', 'Nothing new to export since the last export'), 'ok');
    } else if (r.reason === 'download_failed') {
      toast(tr('auto_export_failed', 'Could not save the export file. Try again.'), 'err');
    } else if (r.reason === 'webdav_failed') {
      toast(r.error || 'WebDAV upload failed', 'err');
    } else {
      toast('Nothing to export yet', 'err');
    }
    refreshAutoExportStatus();
    send('GET_SETTINGS').then(st => { _curSettings = Object.assign(_curSettings || {}, st); ehInitBackupExtras(_curSettings); }).catch(() => {});
  } catch (err) { toast(err.message, 'err'); }
  btn.disabled = false; btn.textContent = orig;
});

document.getElementById('timeTrackingToggle')?.addEventListener('change', (e) => {
  applyTimeTrackingState(e.target.checked);
});

document.getElementById('autoStoreToggle')?.addEventListener('change', (e) => {
  const row = document.getElementById('autoStoreHoursRow');
  if (row) row.style.display = e.target.checked ? '' : 'none';
});

document.getElementById('testAutoSaveBtn')?.addEventListener('click', async () => {
  try {
    await send('TRIGGER_AUTO_SAVE');
    toast('Session saved to downloads folder', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// Signal SW that this page is loaded and ready to handle downloads
chrome.runtime.sendMessage({ type: 'AUTO_SAVE_READY' }).catch(() => {});

// SW sends the content to download — use anchor click (bypasses browser "ask where to save").
// Used for both session auto-save (HTML) and history auto-export (JSON).
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type !== 'AUTO_SAVE_DOWNLOAD') return;
  const save = (blob, filename) => {
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: filename || 'extended-history-session.html', target:"_blank",
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10000);
  };
  (async () => {
    try {
      // Big exports arrive as chunks the page pulls itself (message size limit); small ones inline.
      const source = msg.pullId
        ? new Blob(await ehPullParts(msg.pullId, msg.pullCount), { type: 'application/json' })
        : (msg.content ?? msg.html); // msg.html kept for back-compat
      if (msg.zipEntryName) {
        try {
          save(await ehMakeZip(msg.zipEntryName, source), msg.filename);
        } catch {
          // zipping failed → still deliver the data, as plain JSON
          save(new Blob([source], { type: 'application/json' }), (msg.filename || 'export.zip').replace(/\.zip$/i, '.json'));
        }
      } else {
        save(source instanceof Blob ? source : new Blob([source], { type: msg.mime || 'text/html' }), msg.filename);
      }
      respond({ ok: true });
    } catch (err) {
      respond({ ok: false, error: err.message });
    }
  })();
  return true; // async response
});

// ── Minimal single-file .zip writer (deflate via CompressionStream, else "stored") ──
let _crcTable = null;
function ehCrc32(bytes) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function ehMakeZip(entryName, source) {   // source: string or Blob
  const enc  = new TextEncoder();
  const srcBlob = source instanceof Blob ? source : new Blob([source]);
  const data = new Uint8Array(await srcBlob.arrayBuffer());
  const name = enc.encode(entryName);
  const crc  = ehCrc32(data);

  let body = data, method = 0; // 0 = stored, 8 = deflate
  if (typeof CompressionStream === 'function') {
    try {
      const cs = new CompressionStream('deflate-raw');
      body = new Uint8Array(await new Response(srcBlob.stream().pipeThrough(cs)).arrayBuffer());
      method = 8;
    } catch { body = data; method = 0; }
  }

  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  const lh = new DataView(new ArrayBuffer(30));
  lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8 names
  lh.setUint16(8, method, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
  lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, data.length, true);
  lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);

  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
  cd.setUint16(10, method, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
  cd.setUint32(16, crc, true); cd.setUint32(20, body.length, true); cd.setUint32(24, data.length, true);
  cd.setUint16(28, name.length, true); // extra(30), comment(32), disk(34), attrs(36,38), offset(42) all 0

  const cdOffset = 30 + name.length + body.length;
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, 1, true); eo.setUint16(10, 1, true);
  eo.setUint32(12, 46 + name.length, true); eo.setUint32(16, cdOffset, true);

  return new Blob([lh, name, body, cd, name, eo], { type: 'application/zip' });
}

document.getElementById('exportDataBtn').addEventListener('click', async () => {
  const btn = document.getElementById('exportDataBtn');
  try {
    // Ask everything up front, then do the (possibly long) work.
    const useEncrypt = confirm('Encrypt export with a password?\n\nClick OK to encrypt, Cancel to export as plain JSON.');
    let pw = null;
    if (useEncrypt) {
      pw = prompt('Enter encryption password:');
      if (!pw) { toast('Export cancelled', 'err'); return; }
      const pw2 = prompt('Confirm password:');
      if (pw !== pw2) { toast('Passwords do not match', 'err'); return; }
    }

    btn.disabled = true;
    toastProgress(tr('export_preparing', 'Preparing export…'), null);
    const begin = await sendLong('EXPORT_BEGIN');            // the data stays in the background; we pull it in chunks
    const t0 = Date.now();
    const blob = await ehExportToBlob(begin, pw, (chars) => {
      toastProgress(`${useEncrypt ? tr('export_encrypting', 'Exporting & encrypting…') : tr('export_exporting', 'Exporting…')} ${Math.round(chars / 1048576)} MB`, null);
    });
    let filename = `extended-history_${new Date().toISOString().slice(0,10)}${useEncrypt ? '_enc' : ''}.json`;
    let outBlob = blob;
    if (document.getElementById('exportDataZip')?.checked) {       // "Compress as .zip"
      toastProgress(tr('export_compressing', 'Compressing…'), null);
      try {
        outBlob  = await ehMakeZip(filename, blob);
        filename = filename.replace(/\.json$/, '.zip');
      } catch (_) { outBlob = blob; }                               // zipping failed → still deliver the plain .json
    }
    const url = URL.createObjectURL(outBlob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 300000);     // a big file is still being saved for a while
    toastProgressHide();
    toast(`Exported ${fmtNum(begin.totalEntries)} entries${useEncrypt ? ' (encrypted)' : ''}`, 'ok');
  } catch (err) {
    toastProgressHide();
    toast('Export failed: ' + (err.message || err), 'err');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('importDataBtn')?.addEventListener('click', () => {
  document.getElementById('importDataFile')?.click();
});
// Several .json / .tsv files can be picked at once; they are imported one after the other, each as soon as the previous one is done.
{ const f = document.getElementById('importDataFile'); if (f) f.multiple = true; }
let _ehImportQueueBusy = false;
document.getElementById('importDataFile')?.addEventListener('change', async ev => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length || _ehImportQueueBusy) return;
  _ehImportQueueBusy = true;
  try {
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) toast(tr('import_file_n_of_m', 'Importing file {0} of {1}: {2}', i + 1, files.length, files[i].name), 'ok');
      try { await ehRunImport(files[i], true); }
      catch (err) { toastLong('Import failed (' + files[i].name + '): ' + (err.message || err), 'err'); }
    }
  } finally { _ehImportQueueBusy = false; }
});

// Files at least this big (≈130k+ entries) are imported into SQLite: IndexedDB / Local Storage
// keep too much in memory for millions of entries. The switch happens automatically.
const EH_LARGE_IMPORT_BYTES = 25 * 1024 * 1024;

async function ehEnsureSqliteForLargeImport(file, btn) {
  if (file.size < EH_LARGE_IMPORT_BYTES) return true;
  let backend = 'local';
  try { backend = (await send('GET_STORAGE_BACKEND')).backend || 'local'; } catch {}
  if (backend === 'sqlite') return true;
  const mb = Math.round(file.size / 1048576);
  if (btn) btn.textContent = tr('switching_sqlite', 'Switching to SQLite…');
  toastLong(tr('large_import_switch', 'Large file ({0} MB): switching storage to SQLite first. Your existing history is copied over.', mb), 'ok');
  try {
    const r = await sendLong('MIGRATE_TO_SQLITE');
    if (r && r.error) throw new Error(r.error);
    loadStorageBackend();
    toast(tr('switched_sqlite', 'Now using SQLite ({0} existing entries copied)', fmtNum(r.migrated)), 'ok');
    return true;
  } catch (err) {
    return confirm(tr('sqlite_switch_failed',
      'Could not switch to SQLite:\n{0}\n\nImport into {1} anyway? A file this large can use many GB of memory and may crash the browser.',
      err.message || err, EH_BACKEND_NAMES[backend] || backend));
  }
}

async function ehRunImport(file, allowRetentionPrompt) {
  const btn = document.getElementById('importDataBtn');
  // (several files are imported one after the other: remember the ORIGINAL label, not a previous file's "Done" text)
  const btnHtml = btn ? (window.__ehImportBtnHtml = window.__ehImportBtnHtml || btn.innerHTML) : '';
  clearTimeout(window.__ehImportBtnTimer);
  const setBtn = (t) => { if (btn) btn.textContent = t; };
  if (btn) btn.disabled = true;
  if (!(await ehEnsureSqliteForLargeImport(file, btn))) {
    if (btn) { btn.innerHTML = btnHtml; btn.disabled = false; }
    return;
  }
  let jobId = null, total = 0, r = null;
  let direct = false, cutoff = 0, realCutoff = 0, minT = 0, dstats = { imported: 0, dup: 0, old: 0, invalid: 0, oldestOld: 0 };
  // Batches are sent straight to the database and several are kept in flight, so reading the
  // file, preparing rows and writing them all happen at the same time.
  const inflight = new Set(); let sendErr = null;
  const sendDirect = async (batch) => {
    const resp = await new Promise((res, rej) => chrome.runtime.sendMessage({ target: 'eh-sql', op: 'importBatch', args: { entries: batch, cutoff } },
      x => { if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else res(x); }));
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'database did not answer');
    const st = resp.result;
    dstats.imported += st.imported; dstats.dup += st.dup; dstats.old += st.old; dstats.invalid += st.invalid;
    if (st.oldestOld && (!dstats.oldestOld || st.oldestOld < dstats.oldestOld)) dstats.oldestOld = st.oldestOld;
  };
  try {
    setBtn('⬆ 0%');
    toast(tr('import_started', 'Reading {0}…', file.name), 'ok');
    await ehReadEntries(file, {
      onBatch: async (batch) => {
        if (sendErr) throw sendErr;
        if (!jobId) {
          const b = await sendLong('IMPORT_BEGIN', { bulk: file.size >= EH_LARGE_IMPORT_BYTES })    // big files are staged append-only (flat speed however large the database is) and merged in throttled windows at the end; small ones go straight in
          jobId = b.id; direct = !!b.direct; cutoff = b.cutoff || 0;
          // Direct import: nothing is skipped for being older than the retention window. The oldest date is tracked while
          // reading, and the user is asked ONCE at the end whether to raise retention — no second import pass is ever needed.
          if (direct && allowRetentionPrompt) { realCutoff = cutoff; cutoff = 0; }
        }
        if (realCutoff) for (const e of batch) { const t = e && e.visitTime; if (t && (!minT || t < minT)) minT = t; }
        total += batch.length;
        if (!direct) { await sendLong('IMPORT_BATCH', { id: jobId, entries: batch }); return; }
        const p = sendDirect(batch).catch(e => { sendErr = e; }).finally(() => inflight.delete(p));
        inflight.add(p);
        if (inflight.size >= 3) await Promise.race(inflight);
      },
      onProgress: (read, size, n) => setBtn(`⬆ ${Math.min(100, Math.floor(read / (size || 1) * 100))}% · ${fmtNum(n)}`),
    });
    if (!jobId || !total) {
      toast(tr('no_entries_file','No entries found in file'), 'err');
      if (btn) { btn.innerHTML = btnHtml; btn.disabled = false; }
      return;
    }
    setBtn('⬆ 100%');
    await Promise.all([...inflight]);
    if (sendErr) throw sendErr;
    // The upload is done, but the database still sorts the rows and builds its indexes (minutes for a big file):
    // show that honestly, with real progress where the database reports it.
    const t0 = Date.now();
    const names = { indexing: tr('import_indexing', 'Building search index…'), upgrade: 'Optimizing database…', ready: tr('import_finishing', 'Finishing…') };
    const mmss = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    const poll = async () => {
      try {
        const st = await send('GET_DB_PROGRESS');
        const secs = Math.round((Date.now() - t0) / 1000);
        if (st && st.pctOnly && st.total) {
          setBtn(`⚙ ${Math.round(100 * st.done / st.total)}%`);
          toastProgress(`${st.step || names.indexing} (${mmss(secs)})`, 100 * st.done / st.total);
        } else {
          setBtn(`⚙ ${mmss(secs)}`);
          toastProgress(`${tr('import_organizing', 'Organizing history & building indexes…')} (${mmss(secs)})`, null);
        }
      } catch (_) {}
    };
    poll();
    const pollTimer = setInterval(poll, 1000);
    try { r = await sendLong('IMPORT_HISTORY', { job: jobId, ...(direct ? { stats: dstats } : {}) }); }
    finally { clearInterval(pollTimer); toastProgressHide(); }
  } catch (err) {
    toastLong('Import failed: ' + (err.message || err), 'err');
    if (btn) { btn.innerHTML = btnHtml; btn.disabled = false; }
    return;
  }
  // Success: say so on the button itself for a while, then restore it.
  if (btn) {
    btn.textContent = `✔ ${tr('import_done', 'Done')} · ${fmtNum(r.imported)}`;
    btn.disabled = false;
    window.__ehImportBtnTimer = setTimeout(() => { btn.innerHTML = btnHtml; }, 10000);
  }

  const st = r.stats || {};
  // Integrity check: every entry read from the file must be accounted for as imported / duplicate / too old / invalid.
  // If not, part of the file never reached the database — importing the same file again is safe (duplicates are skipped).
  const processed = (st.imported || 0) + (st.dup || 0) + (st.old || 0) + (st.invalid || 0);
  if (total && processed < total) {
    toastLong(tr('import_incomplete', 'Only {0} of {1} entries from {2} were processed.', fmtNum(processed), fmtNum(total), file.name), 'err');
    if (confirm(tr('import_incomplete_retry', 'The import of "{0}" looks incomplete ({1} of {2} entries processed).\n\nRun it again now? Entries that were already imported are skipped, nothing is duplicated.', file.name, fmtNum(processed), fmtNum(total)))) {
      invalidateHistCache();
      await ehRunImport(file, false);
      return;
    }
  }
  const notes = [];
  if (st.dup)     notes.push(`${fmtNum(st.dup)} duplicates`);
  if (st.old)     notes.push(`${fmtNum(st.old)} older than your retention setting`);
  if (st.invalid) notes.push(`${fmtNum(st.invalid)} invalid`);
  toastLong(tr('import_finished','Import finished — ')+`${fmtNum(r.imported)} `+tr('new_entries_added','new entries added') + (notes.length ? ` (`+tr('skipped','skipped')+`: ${notes.join(', ')})` : ''), tr('ok','ok'));
  invalidateHistCache();
  doSearch();

  // Direct import kept everything; if the file reaches back further than the retention window, decide now (no re-import).
  if (realCutoff && minT && minT < realCutoff) {
    const cur    = _curSettings.retentionDays || 365;
    const needed = Math.ceil((Date.now() - minT) / 86400000) + 1;
    if (confirm(
      `The imported file contains entries back to ${new Date(minT).toLocaleDateString()}, older than your retention setting (${fmtNum(cur)} days).\n\n` +
      `OK = raise retention to ${fmtNum(needed)} days and keep them all.\nCancel = remove the entries older than ${fmtNum(cur)} days.`)) {
      try {
        await send('SAVE_SETTINGS', { settings: { retentionDays: needed } });
        _curSettings.retentionDays = needed;
        const rd = document.getElementById('retDays'); if (rd) rd.value = needed;
        syncRetChips(needed);
        buildDateNav(needed);
      } catch (err) { toast(err.message || tr('cant_update_ret','Could not update retention'), 'err'); }
    } else {
      try {
        toastProgress(tr('import_pruning', 'Removing entries older than the retention window…'), null);
        const resp = await new Promise((res, rej) => chrome.runtime.sendMessage({ target: 'eh-sql', op: 'deleteBelow', args: { t: realCutoff } },
          x => { if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else res(x); }));
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'database did not answer');
      } catch (err) { toast(err.message || tr('cant_remove_old','Could not remove old entries'), 'err'); }
      finally { toastProgressHide(); }
    }
    invalidateHistCache();
    doSearch();
  }

  // Entries older than the retention window were skipped (and would be pruned later anyway).
  // Offer to widen retention so they can be kept, then run the import again.
  if (allowRetentionPrompt && st.old && st.oldestOld) {
    const cur    = _curSettings.retentionDays || 365;
    const needed = Math.ceil((Date.now() - st.oldestOld) / 86400000) + 1;
    if (needed > cur && confirm(
      `${fmtNum(st.old)} entries were skipped because they're older than your retention setting (${fmtNum(cur)} days).\n\n` +
      `Raise retention to ${fmtNum(needed)} days (back to ${new Date(st.oldestOld).toLocaleDateString()}) and import them now?`)) {
      try {
        await send('SAVE_SETTINGS', { settings: { retentionDays: needed } });
        _curSettings.retentionDays = needed;
        const rd = document.getElementById('retDays'); if (rd) rd.value = needed;
        syncRetChips(needed);
        buildDateNav(needed);
        await ehRunImport(file, false);
      } catch (err) { toast(err.message || tr('cant_update_retention','Could not update retention'), 'err'); }
    }
  }
}

document.getElementById('reBackfillBtn')?.addEventListener('click', async () => {
  if (!confirm(tr('re_import_all','Re-import all available Chrome native history? New entries will be merged in.'))) return;
  toast(tr('importing_from_chrome','Importing from Chrome history…'));
  try {
    const r = await send('RE_BACKFILL');
    if (r?.error) { toast(r.error, 'err'); return; }
    toast(`Imported ${fmtNum(r.imported)} new entries from Chrome history`, 'ok');
    invalidateHistCache();
    doSearch();
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if (!confirm(tr('delete_all_confirm','Delete ALL history permanently? Cannot be undone.'))) return;
  try {
    await sendLong('CLEAR_ALL');
    allResults = []; invalidateHistCache(); exitSelMode(); buildVirtualList();
    toast(tr('all_cleared','All history cleared'), 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

// Time Spent → Export: every tracked day as .csv — date, website, time spent (hh:mm:ss)
document.getElementById('exportTimeBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('exportTimeBtn');
  if (btn) btn.disabled = true;
  try {
    await send('FLUSH_TIME');
    const r = await send('EXPORT_TIME_DATA');
    const rows = r.rows || [];
    if (!rows.length) { toast(tr('no_time_data_export', 'No time data to export'), 'err'); return; }
    const q = (v) => /[",\r\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const hms = (ms) => {
      const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    };
    const lines = ['Date,Website,Timespent(hh:mm:ss)'];
    for (const [date, site, ms] of rows) lines.push([date, q(site), hms(ms)].join(','));
    const blob = new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });   // BOM: Excel reads it as UTF-8
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `extended-history_time-spent_${new Date().toISOString().slice(0,10)}.csv` });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
    toast(tr('time_exported', 'Exported {0} rows', fmtNum(rows.length)), 'ok');
  } catch (err) {
    toast('Export failed: ' + (err.message || err), 'err');
  } finally { if (btn) btn.disabled = false; }
});

document.getElementById('clearTimeBtn')?.addEventListener('click', async () => {
  if (!confirm(tr('clear_time_data','Clear all time-spent data? This will not affect history. Cannot be undone.'))) return;
  try {
    await send('CLEAR_TIME_DATA');
    toast(tr('time_data_cleared','Time data cleared'), 'ok');
    loadTimeSpent(curTimeDays || 15);
  } catch (err) { toast(err.message, 'err'); }
});

// ── Session context menu (right-click a session → Delete) ────────────────────
let _sessCtx = null;
function showSessCtxMenu(x, y, ref, label, card) {
  _sessCtx = { ref, label, card };
  const m = document.getElementById('sessCtx');
  if (!m) return;
  hideCtxMenu();
  m.style.display = 'block';
  m.style.left = Math.max(4, Math.min(x, window.innerWidth  - 180)) + 'px';
  m.style.top  = Math.max(4, Math.min(y, window.innerHeight - 60))  + 'px';
}
function hideSessCtxMenu() {
  const m = document.getElementById('sessCtx');
  if (m) m.style.display = 'none';
}
document.addEventListener('click', hideSessCtxMenu);
document.addEventListener('scroll', hideSessCtxMenu, true);
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideSessCtxMenu(); });
document.getElementById('sessCtxDelete')?.addEventListener('click', async () => {
  const c = _sessCtx; _sessCtx = null;
  hideSessCtxMenu();
  if (!c) return;
  if (!confirm(tr('confirm_delete_session', 'Delete this session ({0})? This cannot be undone.', c.label))) return;
  try {
    const r = await send('DELETE_SESSION', { id: c.ref.id, start: c.ref.start });
    if (r && r.error) throw new Error(r.error);
    c.card.remove();
    toast(tr('session_deleted', 'Session deleted'), 'ok');
    const el = document.getElementById('sessionsContent');
    if (el && !el.querySelector('.session-card'))
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📋</span><span data-i18n-key="no_sessions_yet">No sessions recorded yet</span></div>';
  } catch (err) { toast(err.message || String(err), 'err'); }
});

// ── Context menu ──────────────────────────────────────────────────────────────
let _ctxEntry = null;
let _ctxSource = 'history'; // 'history' | 'readingmode'

function showCtxMenu(x, y, entry, source) {
  _ctxEntry = entry;
  _ctxSource = source || 'history';
  const menu       = document.getElementById('ctxMenu');
  const delEl      = document.getElementById('ctx-delete');
  const delSep     = document.getElementById('ctx-del-sep');
  const jumpEl     = document.getElementById('ctx-jump-to-date');
  const jumpSep    = document.getElementById('ctx-jump-sep');
  const jumpDtEl   = document.getElementById('ctx-jump-to-datetime');
  const bmRemove   = document.getElementById('ctx-remove-bookmark');
  const bmRemoveSep= document.getElementById('ctx-bm-remove-sep');
  const bmRename   = document.getElementById('ctx-rename-bookmark');
  const bmFilter   = document.getElementById('ctx-filter-domain');
  const hasId   = !!entry.id;
  const hasDate = !!entry.visitTime;
  const hasBmId = !!entry.bmId;
  if (delEl)        delEl.style.display        = hasId   ? '' : 'none';
  if (delSep)       delSep.style.display       = hasId   ? '' : 'none';
  if (jumpEl)       jumpEl.style.display       = hasDate ? '' : 'none';
  if (jumpDtEl)     jumpDtEl.style.display     = hasDate ? '' : 'none';
  if (jumpSep)      jumpSep.style.display      = hasDate ? '' : 'none';
  if (bmRemove)     bmRemove.style.display     = hasBmId ? '' : 'none';
  if (bmRename)     bmRename.style.display     = hasBmId ? '' : 'none';
  if (bmFilter)     bmFilter.style.display     = hasBmId ? '' : 'none';
  if (bmRemoveSep)  bmRemoveSep.style.display  = hasBmId ? '' : 'none';
  menu.style.display = 'block';
  const mw = 210, mh = 370;
  menu.style.left = Math.min(x, window.innerWidth  - mw - 6) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - mh - 6) + 'px';
}
function hideCtxMenu() {
  const m = document.getElementById('ctxMenu');
  if (m) m.style.display = 'none';
  _ctxEntry = null;
}
document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideCtxMenu(); });

document.getElementById('ctx-open-tab').addEventListener('click', () => {
  if (_ctxEntry?.url) chrome.tabs.create({ url: _ctxEntry.url, active: false }); hideCtxMenu();
});
document.getElementById('ctx-open-incognito').addEventListener('click', () => {
  if (_ctxEntry?.url) send('OPEN_INCOGNITO', { url: _ctxEntry.url }); hideCtxMenu();
});
document.getElementById('ctx-jump-to-date').addEventListener('click', () => {
  if (!_ctxEntry?.visitTime) { hideCtxMenu(); return; }
  const dateKey = new Date(_ctxEntry.visitTime).toLocaleDateString('en-CA');
  hideCtxMenu();
  if (_ctxSource === 'readingmode') {
    rmActivateDatePill(dateKey);
  } else {
    const si = document.getElementById('searchInput');
    if (si) { si.value = ''; document.getElementById('searchClearBtn')?.classList.remove('visible'); }
    activateDatePill(dateKey);
  }
});
// Scrolls to an entry in the (already filtered) list and flashes it. Rows are append-only and 1:1 with the
// list array, so the row index equals the array index; pages are rendered until that row exists.
async function ehJumpHighlight(entry, source) {
  const rm   = source === 'readingmode';
  const list = rm ? _rmFiltered : allResults;
  const area = rm ? rmListArea() : listArea();
  if (!area || !list.length) return false;
  const idx = list.findIndex(e => (entry.id && e.id === entry.id) || (e.url === entry.url && e.visitTime === entry.visitTime));
  if (idx < 0) return false;
  for (let guard = 0; guard < 5000 && (rm ? _rmVsOffset : vsOffset) <= idx && (rm ? _rmVsOffset : vsOffset) < list.length; guard++) {
    if (rm) rmAppendPage(); else appendPage();
  }
  const row = area.querySelectorAll('.entry')[idx];
  if (!row) return false;
  area.querySelectorAll('.entry.jump-highlight').forEach(r => r.classList.remove('jump-highlight'));
  row.scrollIntoView({ block: 'center' });
  void row.offsetWidth;                       // restart the animation if it was already running
  row.classList.add('jump-highlight');
  setTimeout(() => row.classList.remove('jump-highlight'), 4500);
  return true;
}
document.getElementById('ctx-jump-to-datetime').addEventListener('click', async () => {
  const entry = _ctxEntry, source = _ctxSource;
  hideCtxMenu();
  if (!entry?.visitTime) return;
  const d = new Date(entry.visitTime);
  const dateKey = d.toLocaleDateString('en-CA');
  try {
    if (source === 'readingmode') {
      rmActivateDatePill(dateKey);            // reading mode has no hour filter: land on the day, highlight the entry
    } else {
      const si = document.getElementById('searchInput');
      if (si) { si.value = ''; document.getElementById('searchClearBtn')?.classList.remove('visible'); }
      await activateDatePill(dateKey, false, d.getHours());   // date + hour filter, one search
    }
    await ehJumpHighlight(entry, source);
  } catch (err) { toast(err.message || String(err), 'err'); }
});
document.getElementById('ctx-more-domain').addEventListener('click', () => {
  const domain = tryDomain(_ctxEntry?.url || '');
  hideCtxMenu();
  if (!domain) return;
  // Search the whole history (all dates) by domain, from the History panel
  switchPanel('history');
  const modeSel = document.getElementById('searchMode');
  if (modeSel) modeSel.value = 'domain';
  const si = document.getElementById('searchInput');
  if (si) { si.value = domain; document.getElementById('searchClearBtn')?.classList.add('visible'); }
  activateDatePill('all');
});
document.getElementById('ctx-ignore-domain').addEventListener('click', async () => {
  const domain = tryDomain(_ctxEntry?.url || '');
  const source = _ctxSource;
  hideCtxMenu();
  if (!domain) return;
  if (!confirm(`Add "${domain}" to the ignore list? Existing history from it will be removed.`)) return;
  try {
    const r = await send('ADD_IGNORE_PATTERN', { pattern: domain });
    if (r && r.success === false) { toast(r.error || 'Could not add', 'err'); return; }
    toast(`Ignoring ${domain}`, 'ok');
    // Background purges matching history asynchronously — refresh shortly after
    if (source === 'history') setTimeout(() => doSearch(), 900);
  } catch (err) { toast(err.message, 'err'); }
});
document.getElementById('ctx-copy-url').addEventListener('click', () => {
  if (_ctxEntry?.url) navigator.clipboard.writeText(_ctxEntry.url).then(() => toast('URL copied', 'ok')); hideCtxMenu();
});
document.getElementById('ctx-copy-title').addEventListener('click', () => {
  const t = _ctxEntry?.title || _ctxEntry?.url || '';
  if (t) navigator.clipboard.writeText(t).then(() => toast('Copied', 'ok')); hideCtxMenu();
});
document.getElementById('ctx-delete').addEventListener('click', () => {
  if (_ctxEntry?.id) deleteSingle(_ctxEntry.id); hideCtxMenu();
});
document.getElementById('ctx-rename-bookmark').addEventListener('click', async () => {
  const entry = _ctxEntry;          // hideCtxMenu() clears _ctxEntry, so grab it first
  hideCtxMenu();
  if (!entry?.bmId) return;
  const newTitle = prompt('Rename bookmark:', entry.title || '');
  if (newTitle === null) return;    // cancelled
  const title = newTitle.trim();
  if (title === (entry.title || '')) return;
  const r = await send('RENAME_BOOKMARK', { id: entry.bmId, title });
  if (r?.error) { toast(r.error, 'err'); return; }
  toast('Bookmark renamed', 'ok');
  // Refresh list + search index, keeping folder, search query and scroll position
  reloadBookmarksKeepState(false).catch(() => loadBookmarks());
});

// Bookmarks: filter the list by this bookmark's domain (search box = domain, search-in = Domain)
document.getElementById('ctx-filter-domain').addEventListener('click', () => {
  const domain = tryDomain(_ctxEntry?.url || '');
  hideCtxMenu();
  if (!domain) return;
  const modeSel = document.getElementById('bmSearchMode');
  if (modeSel) modeSel.value = 'domain';
  const si = document.getElementById('bmSearch');
  if (si) si.value = domain;
  document.getElementById('bmSearchClearBtn')?.classList.add('visible');
  renderBookmarksWithFilter(domain);
});

document.getElementById('ctx-remove-bookmark').addEventListener('click', () => {
  if (!_ctxEntry?.bmId) { hideCtxMenu(); return; }
  if (!confirm('Remove this bookmark?')) { hideCtxMenu(); return; }
  chrome.bookmarks.remove(_ctxEntry.bmId, () => {
    hideCtxMenu();
    toast('Bookmark removed', 'ok');
    // Reload bookmarks panel
    reloadBookmarksKeepState().catch(() => loadBookmarks());
  });
});

// ── Session export as HTML ────────────────────────────────────────────────────
function exportSessionAsHtml(label, tabs, tabStorageEntries) {
  tabStorageEntries = tabStorageEntries || [];
  const validTabs = tabs.filter(t => t.url);
  const windowIds = [...new Set(validTabs.map(t => t.windowId).filter(Boolean))];
  const hasMultiWindow = windowIds.length > 1;

  function tabLink(t, domFn) {
    const dom = domFn(t.url);
    return '<a href="' + esc(t.url) + '">'
      + '<img class="fav" src="https://www.google.com/s2/favicons?sz=16&domain=' + encodeURIComponent(dom) + '" loading="lazy" onerror="this.style.display=\'none\'"/>'
      + '<span class="title">' + esc(t.title || t.url) + '</span>'
      + '<span class="domain">' + esc(dom) + '</span></a>';
  }

  let sessHtml = '';
  if (hasMultiWindow) {
    const windowMap = new Map();
    for (const t of validTabs) {
      const wid = t.windowId || 'unknown';
      if (!windowMap.has(wid)) windowMap.set(wid, []);
      windowMap.get(wid).push(t);
    }
    let wi = 1;
    for (const [, winTabs] of windowMap) {
      const urlsJson = JSON.stringify(winTabs.map(t => t.url)).replace(/"/g, '&quot;');
      sessHtml += '<div class="win-header">'
        + '<span class="win-label">Window ' + wi + '</span>'
        + '<span class="win-count">' + winTabs.length + ' tab' + (winTabs.length !== 1 ? 's' : '') + '</span>'
        + '<button class="restore-btn" data-urls="' + urlsJson + '">\u21BA Restore Window</button>'
        + '</div>';
      sessHtml += winTabs.map(t => tabLink(t, tryDomain)).join('');
      wi++;
    }
  } else {
    const allUrls = JSON.stringify(validTabs.map(t => t.url)).replace(/"/g, '&quot;');
    sessHtml += '<div class="restore-bar">'
      + '<button class="restore-btn" data-urls="' + allUrls + '">\u21BA Restore all ' + validTabs.length + ' tabs</button>'
      + '</div>';
    sessHtml += validTabs.map(t => tabLink(t, tryDomain)).join('');
  }

  let tsHtml = '';
  if (tabStorageEntries.length) {
    tsHtml = tabStorageEntries.map(e => {
      try {
        const dom = tryDomain(e.url);
        return '<a href="' + esc(e.url) + '">'
          + '<img class="fav" src="https://www.google.com/s2/favicons?sz=16&domain=' + encodeURIComponent(dom) + '" loading="lazy" onerror="this.style.display=\'none\'"/>'
          + '<span class="title">' + esc(e.title || e.url) + '</span>'
          + '<span class="domain">' + esc(dom) + '</span></a>';
      } catch(ex) { return ''; }
    }).join('');
  }

  const tsContent = tabStorageEntries.length
    ? '<div class="links">' + tsHtml + '</div>'
    : '<div class="ts-empty">No stored tabs.</div>';

  const CSS = ':root{--accent:#3b9eff}'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:system-ui,sans-serif;background:#0d0d10;color:#f0eee8;padding:0}'
    + '.page-header{padding:32px 32px 0}'
    + 'h1{font-size:1.3rem;font-weight:700;color:var(--accent);margin-bottom:4px}'
    + '.meta{font-size:.78rem;color:#a09eb0;margin-bottom:20px}'
    + '.tabs-nav{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.08);padding:0 32px}'
    + '.tab-btn{padding:10px 18px;background:none;border:none;border-bottom:2px solid transparent;color:#a09eb0;font-size:.82rem;font-weight:600;cursor:pointer;transition:color .15s,border-color .15s;margin-bottom:-1px}'
    + '.tab-btn:hover{color:#f0eee8}'
    + '.tab-btn.active{color:var(--accent);border-bottom-color:var(--accent)}'
    + '.tab-panel{display:none;padding:20px 32px 40px}'
    + '.tab-panel.active{display:block}'
    + '.links{display:flex;flex-direction:column;gap:3px}'
    + 'a{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;text-decoration:none;color:#f0eee8;background:#18181f;border:1px solid rgba(255,255,255,.06);transition:background .1s}'
    + 'a:hover{background:#1f1f28}'
    + '.fav{width:16px;height:16px;border-radius:3px;flex-shrink:0}'
    + '.title{flex:1;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.domain{font-size:.7rem;color:#a09eb0;flex-shrink:0;font-family:monospace}'
    + '.win-header{font-size:.75rem;font-weight:700;color:var(--accent);padding:20px 0 6px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(59,158,255,.2);margin-bottom:4px}'
    + '.win-header:first-child{padding-top:4px}'
    + '.win-label{font-weight:700}'
    + '.win-count{font-weight:400;color:#a09eb0;flex:1}'
    + '.restore-bar{padding:0 0 14px}'
    + '.restore-btn{padding:6px 14px;background:rgba(59,158,255,.12);border:1px solid rgba(59,158,255,.35);border-radius:6px;color:var(--accent);font-size:.75rem;font-weight:600;cursor:pointer;transition:background .1s;flex-shrink:0}'
    + '.restore-btn:hover{background:rgba(59,158,255,.22)}'
    + '.ts-empty{color:#a09eb0;font-size:.85rem;padding:20px 0}'
    + 'footer{padding:16px 32px 32px;font-size:.7rem;color:#5a5870}';

  const SCRIPT = '(function(){'
    + 'function st(name){'
    +   '["sessions","tabstorage"].forEach(function(n){'
    +     'document.getElementById("tab-"+n).classList.toggle("active",n===name);'
    +     'document.getElementById("btn-"+n).classList.toggle("active",n===name);'
    +   '});'
    + '}'
    + 'document.getElementById("btn-sessions").addEventListener("click",function(){st("sessions");});'
    + 'document.getElementById("btn-tabstorage").addEventListener("click",function(){st("tabstorage");});'
    + 'document.querySelectorAll(".restore-btn").forEach(function(btn){'
    +   'btn.addEventListener("click",function(){'
    +     'var u=JSON.parse(btn.getAttribute("data-urls").replace(/&quot;/g,\'"\'));'
    +     'if(!u.length)return;'
    +     'if(u.length>15&&!confirm("Open "+u.length+" tabs?"))return;'
    +     'u.forEach(function(x){window.open(x,"_blank");});'
    +   '});'
    + '});'
    + '})();';

  const html = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/>'
    + '<title>Session \u2013 ' + esc(label) + '</title>'
    + '<style>' + CSS + '</style></head>\n<body>\n'
    + '<div class="page-header">'
    +   '<h1>\uD83D\uDCCB ' + esc(label) + '</h1>'
    +   '<div class="meta">' + validTabs.length + ' tabs \u00B7 Exported ' + new Date().toLocaleString() + '</div>'
    + '</div>\n'
    + '<div class="tabs-nav">'
    +   '<button class="tab-btn active" id="btn-sessions">Sessions</button>'
    +   '<button class="tab-btn" id="btn-tabstorage">Tab Storage</button>'
    + '</div>\n'
    + '<div class="tab-panel active" id="tab-sessions"><div class="links">' + sessHtml + '</div></div>\n'
    + '<div class="tab-panel" id="tab-tabstorage">' + tsContent + '</div>\n'
    + '<footer>Exported by Extended History</footer>\n'
    + '<script>' + SCRIPT + '<\/script>\n'
    + '</body></html>';

  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([html], {type: 'text/html'})),
    download: 'session_' + new Date().toISOString().slice(0,10) + '.html'
  }).click();
  toast('Session exported', 'ok');
}

// ══ PANEL NAV ════════════════════════════════════════════════════════════════
// ══ FILE FORMAT HELPERS (shared by Import + Reading Mode) ══════════════════
// JSON exports start with { or [ ; anything else is treated as TSV.
function ehLooksLikeJson(text) {
  const c = String(text).replace(/^\uFEFF/, '').trimStart().charAt(0);
  return c === '{' || c === '[';
}

// ── Streaming file reader (Import + Reading Mode) ───────────────────────────
// Files are read in chunks and turned into entries as they go, so the whole file
// text is never held in memory (a 400 MB export used to need several GB).

// V8 "sliced strings" keep their whole parent string alive. When entries are kept
// (Reading Mode), copy the strings so the big chunk text can be freed.
function ehDetach(s) { return (' ' + s).slice(1); }

const _EH_HOST_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^\/?#@]*@)?([^\/?#:]+)/i;
function ehFastDomain(url) {
  const m = _EH_HOST_RE.exec(url);
  if (!m || m[1].charAt(0) === '[') return tryDomain(url);
  return m[1].toLowerCase().replace(/^www\./, '');
}

// One TSV line (History Trends Unlimited):
//   url <TAB> U<timestamp ms, fractional> <TAB> <number, ignored> <TAB> title (optional)
function ehParseTsvLine(line, retain) {
  const i1 = line.indexOf('\t');
  if (i1 < 0) return null;
  const url = line.slice(0, i1).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;                 // not a URL → skip (header/junk)
  const i2 = line.indexOf('\t', i1 + 1);
  let ts = parseFloat(line.slice(i1 + 1, i2 < 0 ? undefined : i2).trim().replace(/^U/i, ''));
  if (!isFinite(ts) || ts <= 0) return null;
  if (ts < 1e11) ts *= 1000;                                            // seconds → ms, just in case
  const i3 = i2 < 0 ? -1 : line.indexOf('\t', i2 + 1);
  const title = i3 < 0 ? '' : line.slice(i3 + 1).trim();
  if (!retain) return { url, title, visitTime: ts };
  return { url: ehDetach(url), title: title ? ehDetach(title) : '', visitTime: ts, domain: ehFastDomain(url) };
}
function ehParseHistoryTsv(text) {   // whole-text variant, kept for small inputs
  const out = [];
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const e = ehParseTsvLine(line, true);
    if (e) out.push(e);
  }
  return out;
}

// Incremental scanner for {"...":..., "entries":[{...},{...}], ...} or a bare [{...},...] array.
// Feed it text chunks; it calls onObject(parsedEntry) per entry and returns true once the
// entries array has ended. Handles strings/escapes and objects split across chunks.
function ehJsonScanner(onObject) {
  let depth = 0, inStr = false, esc = false, started = false;
  let capturing = false, keyBuf = '', lastKey = '';
  let rootArray = false, inEntries = false, objDepth = 0, inObj = false, objStart = 0, pending = '';
  return function push(text) {
    if (inObj) objStart = 0;
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (inStr) {
        if (esc) { esc = false; if (capturing) keyBuf += text[i]; }
        else if (c === 92) { esc = true; }
        else if (c === 34) { inStr = false; if (capturing) { capturing = false; lastKey = keyBuf; } }
        else if (capturing) keyBuf += text[i];
        continue;
      }
      if (c === 34) {                                   // "
        inStr = true;
        if (depth === 1 && !rootArray && !inEntries) { capturing = true; keyBuf = ''; }
      } else if (c === 123) {                           // {
        started = true; depth++;
        if (inEntries && !inObj && depth === objDepth) { inObj = true; objStart = i; pending = ''; }
      } else if (c === 125) {                           // }
        if (inObj && depth === objDepth) {
          const s = pending + text.slice(objStart, i + 1);
          inObj = false; pending = '';
          try { onObject(JSON.parse(s)); } catch {}
        }
        depth--;
      } else if (c === 91) {                            // [
        if (!started) { started = true; rootArray = true; inEntries = true; objDepth = 2; }
        else if (depth === 1 && !rootArray && lastKey === 'entries') { inEntries = true; objDepth = 3; }
        depth++;
      } else if (c === 93) {                            // ]
        if (inEntries && depth === (rootArray ? 1 : 2)) { inEntries = false; return true; }
        depth--;
      }
    }
    if (inObj) pending += text.slice(objStart);
    return false;
  };
}

// Reads a .json / .tsv / .txt history file in chunks, handing entries to onBatch(array)
// (awaited, so the consumer sets the pace) in batches. onProgress(bytesRead, fileSize, entriesSoFar).
// retain:true → entries are kept by the caller (Reading Mode): add domain, detach strings.
// Encrypted exports can't be streamed, so those are decrypted whole, then batched.
async function ehReadEntries(file, { onBatch, onProgress, batchSize = 10000, retain = false }) {
  const head = await file.slice(0, 65536).text();
  const isJson = ehLooksLikeJson(head);
  let total = 0, lastUi = 0;
  const queue = [];
  const drain = async (force) => {
    while (queue.length >= batchSize || (force && queue.length)) {
      const b = queue.splice(0, batchSize);
      total += b.length;
      await onBatch(b);
    }
  };
  const report = (read, force) => {
    if (!onProgress) return;
    const now = performance.now();
    if (force || now - lastUi > 120) { lastUi = now; onProgress(read, file.size, total + queue.length); }
  };

  if (isJson && head.includes('"__eh_encrypted"') && /"v"\s*:\s*3/.test(head)) {
    // Binary chunked encrypted export (v3): read each piece straight from the file, decrypt, stream it through the scanner.
    const nl = head.indexOf('\n');                                   // the header is ASCII, so character index = byte index
    const hm = /"salt"\s*:\s*"([^"]+)"/.exec(head.slice(0, nl));
    if (nl < 0 || !hm) throw new Error('Damaged encrypted file');
    const pw = prompt('This file is encrypted. Enter the password to decrypt:');
    if (!pw) throw new Error('Cancelled');
    const key = await ehDeriveKey(pw, _b64toU8(hm[1]), 'decrypt');
    const scanner = ehJsonScanner(o => queue.push(o));
    const td = new TextDecoder('utf-8');
    const readAt = async (off) => {                                    // → {iv, ct, next} or null at end
      if (off + 16 > file.size) return null;
      const lenBuf = new DataView(await file.slice(off, off + 4).arrayBuffer());
      const len = lenBuf.getUint32(0, true);
      if (len < 16 || off + 16 + len > file.size) throw new Error('Damaged encrypted file');
      const buf = await file.slice(off + 4, off + 16 + len).arrayBuffer();
      return { iv: new Uint8Array(buf, 0, 12), ct: new Uint8Array(buf, 12), next: off + 16 + len };
    };
    let cur = await readAt(nl + 1), done = false;
    while (cur) {
      const pending = readAt(cur.next);                                // read the next piece while this one is decrypted + scanned
      let plain;
      try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cur.iv }, key, cur.ct); }
      catch { throw new Error('Wrong password or corrupted file'); }
      if (scanner(td.decode(plain))) done = true;
      if (retain) for (const e of queue) if (e && !e.domain && e.url) e.domain = ehFastDomain(e.url);
      await drain(false);
      report(cur.next, false);
      cur = done ? null : await pending;
    }
    await drain(true);
    report(file.size, true);
    return total;
  }

  if (isJson && head.includes('"__eh_encrypted"') && /"v"\s*:\s*2/.test(head)) {
    // Chunked encrypted export (v2): decrypt chunk by chunk and stream the plain text through the normal scanner.
    const pw = prompt('This file is encrypted. Enter the password to decrypt:');
    if (!pw) throw new Error('Cancelled');
    const reader = file.stream().getReader();
    const td = new TextDecoder('utf-8');
    const scanner = ehJsonScanner(o => queue.push(o));
    let read = 0, key = null, finished = false, done = false;
    const handleLine = async (line) => {
      line = line.trim();
      if (!line) return;
      if (!key) {                                          // header line(s) until the salt is known
        const m = /"salt"\s*:\s*"([^"]+)"/.exec(line);
        if (m) key = /"kdf"\s*:\s*"dh"/.test(line) ? await ehDoubleHashKey(pw, _b64toU8(m[1]), 'decrypt') : await ehDeriveKey(pw, _b64toU8(m[1]), 'decrypt');
        return;
      }
      if (!line.startsWith('{')) return;                   // "chunks":[ / ]}
      const c = JSON.parse(line.replace(/,$/, ''));
      let plain;
      try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _b64toU8(c.iv) }, key, _b64toU8(c.ct)); }
      catch { throw new Error('Wrong password or corrupted file'); }
      if (!done && scanner(td2.decode(plain))) done = true;
      if (retain) for (const e of queue) if (e && !e.domain && e.url) e.domain = ehFastDomain(e.url);
      await drain(false);
    };
    const td2 = new TextDecoder('utf-8');
    // A line is one 20 MB encrypted piece; it arrives in 64 KB reads. Collect the fragments and join ONCE per line
    // (carry + text on every read copied the growing line again and again — gigabytes of copying).
    let pieces = [];
    const feed = async (text, final) => {
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        if (nl === -1) break;
        pieces.push(text.slice(start, nl));
        const line = pieces.join(''); pieces = [];
        await handleLine(line);
        start = nl + 1;
      }
      pieces.push(start ? text.slice(start) : text);
      if (final) { const line = pieces.join(''); pieces = []; await handleLine(line); }
    };
    while (!finished) {
      const { done: d, value } = await reader.read();
      let text;
      if (d) { text = td.decode(); finished = true; } else { read += value.byteLength; text = td.decode(value, { stream: true }); }
      await feed(text, finished);
      report(read, finished);
    }
    await drain(true);
    return total;
  }

  if (isJson && head.includes('"__eh_encrypted"')) {
    const raw = JSON.parse(await file.text());
    const pw = prompt('This file is encrypted. Enter the password to decrypt:');
    if (!pw) throw new Error('Cancelled');
    let data;
    try { data = JSON.parse(await ehDecrypt(raw, pw)); }
    catch { throw new Error('Wrong password or corrupted file'); }
    const list = Array.isArray(data) ? data : (data.entries || []);
    for (let i = 0; i < list.length; i += batchSize) {
      queue.push(...list.slice(i, i + batchSize));
      await drain(true);
      report(file.size * Math.min(1, (i + batchSize) / list.length), true);
    }
    return total;
  }

  const scanner = isJson ? ehJsonScanner(o => queue.push(o)) : null;
  const reader  = file.stream().getReader();
  const dec     = new TextDecoder('utf-8');
  let read = 0, first = true, carry = '', finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    let text;
    if (done) { text = dec.decode(); finished = true; }
    else { read += value.byteLength; text = dec.decode(value, { stream: true }); }
    if (first && text) { if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); first = false; }

    if (scanner) {
      if (text && scanner(text)) { finished = true; read = file.size; try { await reader.cancel(); } catch {} }
    } else {
      const lines = (carry + text).split('\n');
      carry = finished ? '' : lines.pop();
      for (const line of lines) { if (line.length > 4) { const e = ehParseTsvLine(line, retain); if (e) queue.push(e); } }
    }
    if (retain && scanner) {                             // JSON entries (Reading Mode): same extras as TSV
      for (const e of queue) if (e && !e.domain && e.url) e.domain = ehFastDomain(e.url);
    }
    await drain(finished);
    report(read, finished);
  }
  return total;
}

// ══ READING MODE ════════════════════════════════════════════════════════════
let _rmEntries    = [];   // all entries from loaded file
let _rmFiltered   = [];   // after date/search filter
let _rmFilterDate = null; // 'YYYY-MM-DD' | null = all
let _rmSearchVal  = '';
let _rmVsOffset   = 0;
let _rmVsLoading  = false;

function rmListArea()  { return document.getElementById('rmListArea'); }

// ── Load file ────────────────────────────────────────────────────────────────
async function rmLoadFile(file) {
  const inner = document.querySelector('#rm-dropzone .rm-drop-inner');
  let prog = document.getElementById('rmProgress');
  if (!prog && inner) {
    prog = document.createElement('div');
    prog.id = 'rmProgress';
    prog.style.cssText = 'margin-top:14px;font-size:0.82rem;color:var(--text2);text-align:center';
    inner.appendChild(prog);
  }
  const setProg = (t) => { if (prog) prog.textContent = t; };
  try {
    const entries = [];
    let n = 0;
    setProg(`${tr('reading_file', 'Reading file…')} 0%`);
    await ehReadEntries(file, {
      retain: true,
      onBatch: async (batch) => {
        for (const e of batch) {
          // Slim exports / TSV files carry no ids; the list UI needs a unique one per row.
          if (!e.id) e.id = 'rm_' + n;
          n++;
          entries.push(e);
        }
      },
      onProgress: (read, size, count) =>
        setProg(`${tr('reading_file', 'Reading file…')} ${Math.min(100, Math.floor(read / (size || 1) * 100))}% · ${fmtNum(count)} ${tr('entries', 'entries')}`),
    });
    if (!entries.length) { toast('No entries found in file', 'err'); setProg(''); return; }

    setProg(tr('sorting_entries', 'Sorting…'));
    await new Promise(r => setTimeout(r, 30));          // let the message paint before the long sort
    entries.sort((a, b) => b.visitTime - a.visitTime);
    _rmEntries = entries;
    _rmFilterDate = null;
    _rmSearchVal  = '';

    document.getElementById('rm-filename').textContent   = file.name;
    document.getElementById('rm-entrycount').textContent = `${fmtNum(_rmEntries.length)} entries`;
    document.getElementById('rm-dropzone').style.display = 'none';
    document.getElementById('rm-reader').style.display   = 'flex';    document.getElementById('rmSearchInput').value = '';
    document.getElementById('rmSearchClearBtn')?.classList.remove('visible');

    rmBuildDateNav();
    rmDoFilter();
    setProg('');
  } catch (err) {
    setProg('');
    toast('Could not read file: ' + err.message, 'err');
  }
}

function rmUnload() {
  _rmEntries = []; _rmFiltered = []; _rmFilterDate = null; _rmSearchVal = '';
  _rmDayIndex = []; _rmDayMap = new Map();
  updateCalSidebarVisibility();
  document.getElementById('rm-dropzone').style.display = 'flex';
  document.getElementById('rm-reader').style.display   = 'none';
  document.getElementById('rmDateScroll').innerHTML    = '';
  if (rmListArea()) rmListArea().innerHTML             = '';
  const _rmBar = document.getElementById('rmDayLabelBar'); if (_rmBar) _rmBar.textContent = '';
}

// ── Date nav ─────────────────────────────────────────────────────────────────
// One pass over the (newest-first) entries: each day is a contiguous slice, so picking a day later is a
// slice() instead of formatting the date of every entry in the file.
let _rmDayIndex = [];            // [{key:'YYYY-MM-DD', from, to}] newest → oldest
let _rmDayMap   = new Map();
function rmBuildDayIndex() {
  _rmDayIndex = []; _rmDayMap = new Map();
  const n = _rmEntries.length;
  let i = 0;
  while (i < n) {
    const d = new Date(_rmEntries[i].visitTime);
    if (isNaN(d)) { i++; continue; }
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    const start = new Date(y, m, day).getTime(), end = new Date(y, m, day + 1).getTime();
    let j = i;
    while (j < n && _rmEntries[j].visitTime >= start && _rmEntries[j].visitTime < end) j++;
    if (j === i) j = i + 1;
    const rec = { key: calDateKey(y, m, day), from: i, to: j };
    if (!_rmDayMap.has(rec.key)) { _rmDayIndex.push(rec); _rmDayMap.set(rec.key, rec); }
    i = j;
  }
}

function rmBuildDateNav() {
  rmBuildDayIndex();
  // Open the calendar on the newest day in the file
  if (_rmDayIndex.length) {
    const [y, m] = _rmDayIndex[0].key.split('-').map(Number);
    calViewYear = y; calViewMonth = m - 1; calActiveDate = null;
  }
  updateCalSidebarVisibility();
  rmActivateDatePill('all', true);
}

// keep the calendar sidebar in step when the filter changes through the range inputs / "all time" button
function rmSyncCal(isAll) {
  document.getElementById('calAllTimeBtn')?.classList.toggle('active', !!isAll);
  if (_calTarget === 'reading') renderCalendarWidget();
}

function rmActivateDatePill(key, silent) {
  _rmFilterDate = key === 'all' ? null : key;
  const fromEl = document.getElementById('rmDateFrom');
  const toEl   = document.getElementById('rmDateTo');
  if (fromEl) fromEl.value = _rmFilterDate || '';
  if (toEl)   toEl.value   = _rmFilterDate || '';
  if (key !== 'all') {
    calActiveDate = key;
    const [y, m] = key.split('-').map(Number);
    calViewYear = y; calViewMonth = m - 1;
  }
  document.getElementById('calAllTimeBtn')?.classList.toggle('active', key === 'all');
  if (_calTarget === 'reading') renderCalendarWidget();
  if (!silent) rmDoFilter();
}

// ── Filter + render ──────────────────────────────────────────────────────────
function rmDoFilter() {
  const q     = _rmSearchVal.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const mode  = (document.getElementById('rmSearchMode')?.value) || 'all';

  // Date range from picker inputs (only used when no pill date is active)
  const fromVal = document.getElementById('rmDateFrom')?.value;
  const toVal   = document.getElementById('rmDateTo')?.value;
  const fromTs  = (!_rmFilterDate && fromVal) ? new Date(fromVal + 'T00:00:00').getTime() : null;
  const toTs    = (!_rmFilterDate && toVal)   ? new Date(toVal + 'T23:59:59').getTime()   : null;

  // Narrow down by date first, without touching entries outside the range:
  // a single day is a precomputed slice, a range is two binary searches (entries are sorted newest-first).
  let base = _rmEntries;
  if (_rmFilterDate) {
    const r = _rmDayMap.get(_rmFilterDate);
    base = r ? _rmEntries.slice(r.from, r.to) : [];
  } else if (fromTs || toTs) {
    const firstIdx = (fn) => { let lo = 0, hi = _rmEntries.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (fn(_rmEntries[mid])) hi = mid; else lo = mid + 1; } return lo; };
    const start = toTs   ? firstIdx(e => e.visitTime <= toTs)   : 0;
    const end   = fromTs ? firstIdx(e => e.visitTime <  fromTs) : _rmEntries.length;
    base = _rmEntries.slice(start, Math.max(start, end));
  }
  _rmFiltered = !words.length ? base : base.filter(e => {
    const dom = e.domain || tryDomain(e.url);
    let hay;
    if      (mode === 'title')  hay = (e.title || '').toLowerCase();
    else if (mode === 'url')    hay = (e.url   || '').toLowerCase();
    else if (mode === 'domain') hay = dom.toLowerCase();
    else                        hay = [e.url, e.title||'', dom].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });

  _rmVsOffset = 0; _rmVsLoading = false;
  const area = rmListArea();
  if (!_rmFiltered.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span>No entries found</div>`;
    dayLabelStickyCheck(area);
    return;
  }
  area.innerHTML = '';
  rmAppendPage();
  dayLabelStickyCheck(area);
  area.onscroll = () => {
    if (area.scrollTop + area.clientHeight >= area.scrollHeight - 400) rmAppendPage();
    dayLabelStickyCheck(area);
  };
}

function rmAppendPage() {
  if (_rmVsLoading) return;
  if (_rmVsOffset >= _rmFiltered.length) return;
  _rmVsLoading = true;
  const area  = rmListArea();
  const slice = _rmFiltered.slice(_rmVsOffset, _rmVsOffset + PAGE_SIZE);
  let prevDay = _rmVsOffset > 0 ? dayLabel(_rmFiltered[_rmVsOffset - 1].visitTime) : null;

  for (const e of slice) {
    const dl  = dayLabel(e.visitTime);
    const dom = e.domain || tryDomain(e.url);

    if (dl !== prevDay) {
      const hdr = document.createElement('div');
      hdr.className = 'day-label';
      hdr.innerHTML = esc(dl);
      area.appendChild(hdr);
      prevDay = dl;
    }

    const row = document.createElement('div');
    row.className = 'entry';
    row.innerHTML = `
      <img class="e-fav" src="${favUrl(dom)}" loading="lazy"/>
      <div class="e-body">
        <div class="e-title">${esc(e.title || e.url)}</div>
        <div class="e-url">${esc(e.url)}</div>
      </div>
      <div class="e-time">${fmtTime(e.visitTime)}</div>`;
    row.querySelector('.e-fav').addEventListener('error', function(){ this.style.opacity='0'; });
    row.addEventListener('click', () => window.open(e.url, '_blank'));
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault(); ev.stopPropagation();
      showCtxMenu(ev.clientX, ev.clientY, { url: e.url, title: e.title, visitTime: e.visitTime }, 'readingmode');
    });
    area.appendChild(row);
  }

  _rmVsOffset += slice.length;
  _rmVsLoading = false;
  dayLabelStickyCheck(area);
}

// ── Wire up drop zone + file input ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const dropzone = document.getElementById('rm-dropzone');
  const fileInput = document.getElementById('rmFileInput');

  document.getElementById('rmPickBtn')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', ev => {
    const f = ev.target.files[0]; if (f) rmLoadFile(f); ev.target.value = '';
  });
  document.getElementById('rmCloseBtn')?.addEventListener('click', rmUnload);

  // Drag-and-drop on the dropzone
  dropzone?.addEventListener('dragover', ev => {
    ev.preventDefault(); dropzone.classList.add('drag-over');
  });
  dropzone?.addEventListener('dragleave', ev => {
    if (!dropzone.contains(ev.relatedTarget)) dropzone.classList.remove('drag-over');
  });
  dropzone?.addEventListener('drop', ev => {
    ev.preventDefault(); dropzone.classList.remove('drag-over');
    const f = ev.dataTransfer.files[0];
    if (f) rmLoadFile(f);
  });

  // Search input
  let _rmTimer = null;
  document.getElementById('rmSearchInput')?.addEventListener('input', ev => {
    _rmSearchVal = ev.target.value;
    document.getElementById('rmSearchClearBtn')?.classList.toggle('visible', !!ev.target.value);
    clearTimeout(_rmTimer);
    _rmTimer = setTimeout(rmDoFilter, 260);
  });
  document.getElementById('rmSearchClearBtn')?.addEventListener('click', () => {
    _rmSearchVal = '';
    document.getElementById('rmSearchInput').value = '';
    document.getElementById('rmSearchClearBtn')?.classList.remove('visible');
    rmDoFilter();
  });
  // Search mode filter
  document.getElementById('rmSearchMode')?.addEventListener('change', rmDoFilter);
  // Date range inputs
  document.getElementById('rmDateFrom')?.addEventListener('change', () => {
    _rmFilterDate = null; // clear pill selection when using range
    document.querySelectorAll('#rmDateScroll .dn-pill').forEach(b => b.classList.remove('active'));
    document.getElementById('rmAllPill')?.classList.remove('active');
    rmSyncCal(false);
    rmDoFilter();
  });
  document.getElementById('rmDateTo')?.addEventListener('change', () => {
    _rmFilterDate = null;
    document.querySelectorAll('#rmDateScroll .dn-pill').forEach(b => b.classList.remove('active'));
    document.getElementById('rmAllPill')?.classList.remove('active');
    rmSyncCal(false);
    rmDoFilter();
  });
  // All time / clear filters
  document.getElementById('rmClearFiltersBtn')?.addEventListener('click', () => {
    _rmFilterDate = null;
    _rmSearchVal  = '';
    const si = document.getElementById('rmSearchInput');
    if (si) { si.value = ''; }
    document.getElementById('rmSearchClearBtn')?.classList.remove('visible');
    document.getElementById('rmDateFrom').value = '';
    document.getElementById('rmDateTo').value   = '';
    document.querySelectorAll('#rmDateScroll .dn-pill').forEach(b => b.classList.remove('active'));
    document.getElementById('rmAllPill')?.classList.add('active');
    rmSyncCal(true);
    rmDoFilter();
  });
});

// ══ END READING MODE ═════════════════════════════════════════════════════════

// ── Ignore List Password Gate ─────────────────────────────────────────────────
const IGNORE_PW_KEY = 'eh_ignore_pw_hash';

async function hashPassword(pw) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode('EH_IGNORE:' + pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleIgnoreListAccess() {
  const stored = await chrome.storage.local.get([IGNORE_PW_KEY, 'eh_ignore_list']);
  const pwHash = stored[IGNORE_PW_KEY];
  const list   = stored['eh_ignore_list'] || [];
  const isFirstTime = !pwHash || list.length === 0;

  const modal    = document.getElementById('ignorePasswordModal');
  const title    = document.getElementById('ignorePwTitle');
  const desc     = document.getElementById('ignorePwDesc');
  const input    = document.getElementById('ignorePwInput');
  const errEl    = document.getElementById('ignorePwError');
  const okBtn    = document.getElementById('ignorePwOkBtn');
  const resetBtn = document.getElementById('ignorePwResetBtn');
  const cancelBtn= document.getElementById('ignorePwCancelBtn');

  input.value = '';
  errEl.style.display = 'none';
  errEl.textContent = '';

  let mode = isFirstTime ? 'setup' : 'unlock'; // 'setup' | 'unlock' | 'reset-new'
  let _resolvePw = null;

  function setMode(m) {
    mode = m;
    if (m === 'setup') {
      title.textContent = tr('ignore_list_setup','🔒 Set Up Ignore List');
      desc.textContent  = tr('ignore_list_setup_desc','No password is set yet. Create a master password to protect your ignore list.');
      resetBtn.style.display = 'none';
      okBtn.textContent =  tr('create_password','Create Password');
      cancelBtn.textContent = tr('cancel','Cancel');
      input.placeholder=  tr('master_password','Master Password');
    } else if (m === 'unlock') {
      title.textContent = tr('ignore_list_access','🔒 Ignore List Access');
      desc.textContent  = tr('ignore_list_access_desc','Enter your master password to view the ignore list.');
      resetBtn.style.display = '';
      resetBtn.textContent = tr('reset','Reset');
      okBtn.textContent = tr('ok','OK');
      cancelBtn.textContent = tr('cancel','Cancel');
      input.placeholder=  tr('master_password','Master Password');
    } else if (m === 'reset-new') {
      title.textContent = tr('reset_ignore_list','🔑 Reset Ignore List');
      desc.textContent  = tr('reset_ignore_list_desc','Ignore list has been cleared. Enter a new master password to continue.');
      resetBtn.style.display = 'none';
      okBtn.textContent = tr('set_new_password','Set New Password');
      cancelBtn.textContent = tr('cancel','Cancel');
      input.placeholder=  tr('master_password','Master Password');
    }
    input.value = '';
    errEl.style.display = 'none';
  }

  setMode(mode);
  modal.classList.add('open');
  setTimeout(() => input.focus(), 50);

  function cleanup() {
    modal.classList.remove('open');
    okBtn.removeEventListener('click', onOk);
    resetBtn.removeEventListener('click', onReset);
    cancelBtn.removeEventListener('click', onCancel);
    input.removeEventListener('keydown', onKey);
  }

  async function onOk() {
    const pw = input.value.trim();
    if (!pw) { errEl.textContent = tr('please_enter_password','Please enter a password.'); errEl.style.display = ''; return; }

    if (mode === 'setup' || mode === 'reset-new') {
      // Set new password
      const hash = await hashPassword(pw);
      await chrome.storage.local.set({ [IGNORE_PW_KEY]: hash });
      cleanup();
      // Now show the ignore list panel
      _showIgnorePanel();
    } else {
      // Verify password
      const hash = await hashPassword(pw);
      if (hash !== pwHash) {
        errEl.textContent = 'Incorrect password. Try again.';
        errEl.style.display = '';
        input.value = '';
        input.focus();
        return;
      }
      cleanup();
      _showIgnorePanel();
    }
  }

  async function onReset() {
    if (!confirm(tr('confirm_clear_ignore_list','This will clear your entire ignore list and remove the password. Continue?'))) return;
    // Clear ignore list and password
    await chrome.storage.local.remove([IGNORE_PW_KEY, 'eh_ignore_list']);
    await send('SET_IGNORE_LIST', { list: [] }).catch(() => {});
    setMode('reset-new');
    input.focus();
  }

  function onCancel() {
    cleanup();
    // Go back to history panel
    switchPanel('history');
  }

  function onKey(e) {
    if (e.key === 'Enter') onOk();
    if (e.key === 'Escape') onCancel();
  }

  okBtn.addEventListener('click', onOk);
  resetBtn.addEventListener('click', onReset);
  cancelBtn.addEventListener('click', onCancel);
  input.addEventListener('keydown', onKey);
}

function _showIgnorePanel() {
  // Inject real content into the locked container (only now, after auth)
  const inner = document.getElementById('ignoreListInner');
  if (inner && !inner.dataset.loaded) {
    inner.dataset.loaded = '1';
    inner.innerHTML = `
      <div class="panel-scroll">
        <div class="panel-heading">🚫 <span data-i18n-key="ignored_domains">Ignored Domains</span></div>
        <p style="color:var(--text2);font-size:0.9rem;margin-bottom:20px;line-height:1.5;max-width:600px">
          <span data-i18n-key="domains_added_will_not_be">Domains added here will not be saved in history. Use the button below to remove entries that are already stored.</span>
          <span data-i18n-key="ignore_keywords_note">Words without a dot are treated as keywords — they match any URL or page title containing that word.</span>
        </p>
         <div class="ignore-toggle-wrapper" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div class="ignore-toggle-text">
            <div class="ignore-toggle-title">${tr('ignore_mode_title', 'List mode:')}</div>
            <div class="ignore-toggle-subtitle" id="ignoreModeDesc">${tr('ignore_mode_desc_black', 'Blacklist (sites in the list below are ignored)')}</div>
          </div>
          <div id="ignoreModeSwitch" role="radiogroup" style="display:inline-flex;gap:8px">
            <button id="ignoreModeBlack" type="button" class="action-btn" role="radio" style="background:transparent;border:1px solid var(--border,#444);border-radius:8px;padding:6px 16px;font-size:0.85rem;cursor:pointer;">${tr('ignore_mode_black', 'Blacklist mode')}</button>
            <button id="ignoreModeWhite" type="button" class="action-btn" role="radio" style="background:transparent;border:1px solid var(--border,#444);border-radius:8px;padding:6px 16px;font-size:0.85rem;cursor:pointer;">${tr('ignore_mode_white', 'Whitelist mode')}</button>
          </div>
        </div>
        <div class="ignore-toggle-wrapper">
          <label class="toggle-switch">
            <input type="checkbox" id="ignoreListToggle" checked>
            <span class="toggle-slider"></span>
          </label>
          <label class="ignore-toggle-label" for="ignoreListToggle">
            <div class="ignore-toggle-text">
              <div class="ignore-toggle-title" data-i18n-key="enable_ignore">Enable Ignore List</div>
              <div class="ignore-toggle-subtitle" data-i18n-key="filter_urls">Filter URLs matching patterns below</div>
            </div>
          </label>
        </div>
        <div class="ignore-toggle-wrapper">
          <label class="toggle-switch">
            <input type="checkbox" id="hideTimeSpentToggle">
            <span class="toggle-slider"></span>
          </label>
          <label class="ignore-toggle-label" for="hideTimeSpentToggle">
            <div class="ignore-toggle-text">
              <div class="ignore-toggle-title" data-i18n-key="hide_from_time_spent">Hide from Time Spent</div>
              <div class="ignore-toggle-subtitle" data-i18n-key="hide_from_time_spent_desc">Hides domains matching the patterns below from the Time Spent view — doesn't delete any tracked time data</div>
            </div>
          </label>
        </div>
       <div><button class="action-btn danger" id="ignoreCleanBtn" style="font-size:0.8rem;padding:6px 14px;margin-bottom:20px;">${tr('ignore_clean_black', 'Remove existing entries from sites that are in the blacklist')}</button></div>
        <div class="ignore-add">
          <input type="text" id="ignorePatternInput" placeholder="example.com or keyword" spellcheck="false">
          <button id="addIgnoreBtn" data-i18n-key="add_patern">Add Pattern</button>
        </div>
        <div class="pattern-guide-toggle">
          <button id="patternGuideToggle">▼ <span data-i18n-key="url_pattern_guide">URL Pattern Guide</span></button>
        </div>
        <div id="patternGuide" class="pattern-guide" style="display:none">
      <table>
              <tr>
                <!-- Needs translations (TODO) START-->
                <td><strong><span data-i18n-key="specific_word">Specific keyword</span></strong></td> 
                <td><code><span data-i18n-key="example_com_6">example</span></code></td>
                <td><span data-i18n-key="block_all_example_7">Only blocks that keyword</span></td>
                <!-- Needs translations (TODO) END-->
              </tr>
              <tr>
                <td><strong><span data-i18n-key="basic_domain">Basic domain</span></strong></td>
                <td><code><span data-i18n-key="example_com_1">example.com</span></code></td>
                <td><span data-i18n-key="block_all_example_1">Blocks all of example.com</span></td>
              </tr>
              <tr>
                <td><strong><span data-i18n-key="all_subdomains">All subdomains</span></strong></td>
                <td><code><span data-i18n-key="example_com_2">*.example.com</span></code></td>
                <td><span data-i18n-key="block_all_example_2">Blocks blog.example.com, shop.example.com, etc.</span></td>
              </tr>
              <tr>
                <td><strong><span data-i18n-key="specific_subdomain">Specific subdomain</span></strong></td>
                <td><code><span data-i18n-key="example_com_3">blog.example.com</span></code></td>
                <td><span data-i18n-key="block_all_example_3">Only blocks blog.example.com</span></td>
              </tr>
              <tr>
                <td><strong><span data-i18n-key="specific_path">Specific path</span></strong></td>
                <td><code><span data-i18n-key="example_com_4">example.com/private</span></code></td>
                <td><span data-i18n-key="block_all_example_4">Only blocks URLs under /private</span></td>
              </tr>
              <tr>
                <td><strong><span data-i18n-key="specific_file">Specific file</span></strong></td>
                <td><code><span data-i18n-key="example_com_5">example.com/file.html</span></code></td>
                <td><span data-i18n-key="block_all_example_5">Only blocks that specific file</span></td>
              </tr>
            </table>
        </div>
        <div id="ignoreList" class="ignore-list">
          <div class="empty-msg">No patterns added yet</div>
        </div>
      </div>`;
    inner.style.display = 'flex';
    // Re-init ignore-list.js listeners now that the DOM elements exist
    if (window.IgnoreList) {
      // Re-wire buttons manually since initIgnoreList already ran before elements existed
      const addBtn = document.getElementById('addIgnoreBtn');
      if (addBtn) addBtn.addEventListener('click', window.IgnoreList.add);
      const toggle = document.getElementById('ignoreListToggle');
      if (toggle) toggle.addEventListener('change', window.IgnoreList.toggle);
      const tsToggle = document.getElementById('hideTimeSpentToggle');
      if (tsToggle) tsToggle.addEventListener('change', window.IgnoreList.toggleTimeSpent);
      document.getElementById('ignoreModeBlack')?.addEventListener('click', () => window.IgnoreList.setMode(false));
      document.getElementById('ignoreModeWhite')?.addEventListener('click', () => window.IgnoreList.setMode(true));
      document.getElementById('ignoreCleanBtn')?.addEventListener('click', window.IgnoreList.cleanOutside);
      const guideToggle = document.getElementById('patternGuideToggle');
      if (guideToggle) guideToggle.addEventListener('click', window.IgnoreList.toggleGuide);
      const input = document.getElementById('ignorePatternInput');
      if (input) input.addEventListener('keypress', e => { if (e.key === 'Enter') window.IgnoreList.add(); });
    }
  } else if (inner) {
    inner.style.display = 'flex';
  }

  // Activate the panel
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === 'panel-ignorelist'));

  // Load patterns
  if (window.IgnoreList) window.IgnoreList.load();

  // Re-apply translations to newly injected content
  if (typeof window.applyTranslations === 'function') window.applyTranslations();
}

// ══ SETTINGS: UNSAVED CHANGES ═══════════════════════════════════════════════
// A snapshot of every Settings control is taken once the panel has been filled from the saved
// settings (and again after a successful save). Leaving the panel with a different state asks
// whether to save. Controls that apply/save on their own (language, wallpaper, storage backend,
// file pickers) are not part of the snapshot.
let _settingsSnap = null;
function _settingsState() {
  const out = {};
  document.querySelectorAll('#panel-settings input, #panel-settings select, #panel-settings textarea').forEach((el, i) => {
    if (el.type === 'file' || el.type === 'button' || el.type === 'submit') return;
    if (el.id === 'languageSelect' || el.id === 'storageBackendSel' || /^wp/.test(el.id)) return;
    out[el.id || ('#' + i)] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
  });
  out.__icon = document.querySelector('#toolbarIconGrid .icon-opt.on')?.dataset.icon || '';
  return JSON.stringify(out);
}
function snapshotSettings() { _settingsSnap = _settingsState(); }
function settingsDirty() { return _settingsSnap !== null && _settingsSnap !== _settingsState(); }

// Save / Discard / Cancel dialog. Resolves 'save' | 'discard' | 'cancel'.
function askSaveSettings() {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.5)';
    ov.innerHTML = `<div role="dialog" aria-modal="true" style="width:100%;max-width:380px;box-sizing:border-box;padding:22px;border-radius:14px;background:var(--surf1);color:var(--text);border:1px solid var(--border2);box-shadow:0 20px 60px var(--shadow)">
      <div style="font-size:1.05rem;font-weight:700;margin-bottom:6px"></div>
      <div style="font-size:0.85rem;color:var(--text2);line-height:1.5;margin-bottom:16px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"></div></div>`;
    const [title, msg, btns] = ov.firstElementChild.children;
    title.textContent = tr('unsaved_changes_title', 'Save changes?');
    msg.textContent = tr('unsaved_changes_msg', 'You have unsaved changes in Settings.');
    const done = v => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    const mk = (label, v, cls) => {
      const b = document.createElement('button');
      b.className = 'action-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.addEventListener('click', () => done(v));
      btns.appendChild(b);
      return b;
    };
    mk(tr('cancel', 'Cancel'), 'cancel');
    mk(tr('discard', 'Discard'), 'discard');
    const saveBtn = mk(tr('save_changes', 'Save changes'), 'save', 'primary');
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done('cancel'); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', e => { if (e.target === ov) done('cancel'); });
    document.body.appendChild(ov);
    saveBtn.focus();
  });
}
// Puts every live-previewed setting back to what is saved.
function revertSettingsPreview() {
  populateSettings(_curSettings);
  applyVisuals(_curSettings);
  applyHighContrastMode(_curSettings.highContrastMode === true);
}
let _leavingSettings = false;
async function guardLeaveSettings(name) {
  if (_leavingSettings) return false;
  _leavingSettings = true;
  try {
    const choice = await askSaveSettings();
    if (choice === 'cancel') return false;
    if (choice === 'save') { if (!await saveSettings()) return false; }
    else { revertSettingsPreview(); snapshotSettings(); }
    return true;
  } finally { _leavingSettings = false; }
}

function switchPanel(name, skipGuard) {
  // Leaving Settings with unsaved edits: ask first, then continue (or stay)
  if (!skipGuard && name !== 'settings' && document.getElementById('panel-settings')?.classList.contains('active') && settingsDirty()) {
    guardLeaveSettings(name).then(ok => { if (ok) switchPanel(name, true); });
    return;
  }
  // Lock the ignore list whenever navigating away from it
  if (name !== 'ignorelist') {
    const inner = document.getElementById('ignoreListInner');
    if (inner) {
      inner.style.display = 'none';
      delete inner.dataset.loaded; // force content re-injection on next unlock
      inner.innerHTML = '';        // clear DOM so devtools sees nothing
    }
  }

  document.querySelectorAll('.nav-item[data-panel]').forEach(b =>
  b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p =>
  p.classList.toggle('active', p.id === `panel-${name}`));
  updateCalSidebarVisibility();

  // Ignorelist: show panel then overlay modal on top (modal is position:fixed)
  if (name === 'ignorelist') { handleIgnoreListAccess(); return; }

  if (name === 'activity')  loadActivity();
  if (name === 'timespent') loadTimeSpent(curTimeDays || 15);
  if (name === 'devices')    { loadDevices(); wireDeviceSearch(); }
  if (name === 'sessions')   loadSessions();
  if (name === 'tabstorage') loadTabStorage();
  if (name === 'bookmarks') loadBookmarks();
   if (name === 'mostvisited') loadMostVisited();
  if (name === 'quickfilters') { if (window.QuickFilters) window.QuickFilters.loadPanel(); }
  if (name === 'settings') {
    _settingsSnap = null;   // not dirty-checked until the form has been filled
    Promise.all([
      send('GET_SETTINGS').then(s => { _curSettings = s; populateSettings(s); }).catch(() => {}),
      send('GET_SESSIONS').then(r => {
        const el = document.getElementById('maxSessionsInput');
        if (el && r.maxSessions) el.value = r.maxSessions;
      }).catch(() => {}),
      send('GET_AUTO_SAVE_INTERVAL').then(r => {
        const el = document.getElementById('autoSaveInput');
        if (el) el.value = r.minutes || 0;
      }).catch(() => {}),
    ]).then(snapshotSettings);
  }
}

// ══ DELETE HISTORY MODAL ═════════════════════════════════════════════════════
let _dhSelectedRange = null;

// "Last hour / 5 months…" counts back from the newest entry in the history (not from today), so a history
// that ends a while ago still has its latest period selected. The end is always "now" (nothing newer exists).
let _dhAnchor = 0, _dhAnchorFound = false, _dhAnchorErr = '';
async function dhLoadAnchor() {
  _dhAnchorFound = false; _dhAnchorErr = '';
  const now = Date.now();
  try {
    const r = await sendLong('GET_NEWEST_VISIT');
    if (r && r.found && r.time) { _dhAnchor = r.time; _dhAnchorFound = true; return _dhAnchor; }
    if (r && r.err) _dhAnchorErr = r.err;
  } catch (e) { _dhAnchorErr = String(e && e.message || e); }
  // Fallback: the list is newest-first, so the first row of an unfiltered search is the newest entry.
  try {
    const r = await sendLong('SEARCH', { query: '', mode: 'all', limit: 1, offset: 0, noTotal: true });
    const e0 = r && r.entries && r.entries[0];
    if (e0 && e0.visitTime) { _dhAnchor = Math.min(e0.visitTime, now); _dhAnchorFound = true; return _dhAnchor; }
  } catch (e) { _dhAnchorErr = (_dhAnchorErr ? _dhAnchorErr + ' / ' : '') + String(e && e.message || e); }
  console.warn('[EH] newest entry lookup failed:', _dhAnchorErr);
  _dhAnchor = now;
  return _dhAnchor;
}
function rangeToTimes(range) {
  const now = Date.now();
  const a = _dhAnchor || now;
  const span = { '1h': 3600000, '24h': 86400000, '7d': 7*86400000, '30d': 30*86400000, '5mo': 150*86400000 }[range];
  if (range === 'all') return [0, now];
  if (!span) return null;
  return [a - span, now];
}

function openDeleteHistoryModal() {
  _dhSelectedRange = null;
  document.querySelectorAll('.dh-range-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('dhConfirmBtn').disabled = true;
  document.getElementById('dhCookies').checked = false;
  document.getElementById('dhCache').checked = false;
  dhShowExceptionsView(false);
  dhLoadExceptions().then(dhUpdateExcCount);
  document.getElementById('deleteHistoryModal').classList.add('open');
}
function closeDeleteHistoryModal() {
  document.getElementById('deleteHistoryModal').classList.remove('open');
  _dhSelectedRange = null;
  const confirmBtn = document.getElementById('dhConfirmBtn');
  if (confirmBtn) { delete confirmBtn.dataset.confirmed; confirmBtn.textContent = tr('delete', 'Delete'); confirmBtn.disabled = true; }
  const warn = document.getElementById('dhConfirmWarn');
  if (warn) warn.style.display = 'none';
  dhShowExceptionsView(false);
}

// -- Delete History: domain exceptions ---------------------------------------
// Domains on this list are skipped by the time-range delete (enforced in
// background.js DELETE_HISTORY_RANGE, which reads the same storage key).
// An exception for example.com also protects every subdomain of it.
const DH_EXC_KEY = 'eh_delete_exceptions';
let _dhExceptions = [];

// Accepts "example.com", "www.Example.com", "https://example.com/path?x",
// "*.example.com", "example.com:8080" ... and returns a bare lowercase host
// (no www.), or '' when the input isn't a usable domain.
function dhNormalizeDomain(raw) {
  let v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // scheme
  v = v.replace(/^\*\./, '').replace(/^\./, '');   // "*.example.com" / ".example.com"
  v = v.split(/[\/?#]/)[0];                         // path / query / hash
  v = v.replace(/^[^@]*@/, '');                      // user:pass@
  v = v.replace(/:\d+$/, '');                       // port
  v = v.replace(/\.$/, '');                         // trailing dot
  try { v = new URL('http://' + v).hostname; } catch { return ''; }
  v = v.replace(/^www\./, '');
  const valid = /^[a-z0-9\u00a1-\uffff]([a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?(\.[a-z0-9\u00a1-\uffff]([a-z0-9\u00a1-\uffff-]*[a-z0-9\u00a1-\uffff])?)*$/.test(v);
  if (!valid) return '';
  if (!v.includes('.') && v !== 'localhost') return '';
  return v;
}

async function dhLoadExceptions() {
  try {
    const r = await chrome.storage.local.get(DH_EXC_KEY);
    _dhExceptions = Array.isArray(r[DH_EXC_KEY]) ? r[DH_EXC_KEY].filter(d => typeof d === 'string' && d) : [];
  } catch { _dhExceptions = []; }
  return _dhExceptions;
}
async function dhSaveExceptions() {
  await chrome.storage.local.set({ [DH_EXC_KEY]: _dhExceptions });
}
function dhIsExcepted(url) {
  if (!_dhExceptions.length) return false;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return false; }
  return _dhExceptions.some(d => host === d || host.endsWith('.' + d));
}
function dhUpdateExcCount() {
  const el = document.getElementById('dhExcCount');
  if (!el) return;
  el.textContent = _dhExceptions.length ? String(_dhExceptions.length) : '';
  el.classList.toggle('has', _dhExceptions.length > 0);
}
function dhRenderExceptions() {
  const list = document.getElementById('dhExcList');
  if (!list) return;
  list.textContent = '';
  if (!_dhExceptions.length) {
    const empty = document.createElement('div');
    empty.className = 'dh-exc-empty';
    empty.textContent = tr('no_exceptions_yet', 'No exceptions yet');
    list.appendChild(empty);
    return;
  }
  [..._dhExceptions].sort().forEach(domain => {
    const row = document.createElement('div');
    row.className = 'dh-exc-item';
    const name = document.createElement('span');
    name.className = 'dh-exc-dom';
    name.textContent = domain;
    name.title = domain;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'dh-exc-rm';
    rm.title = tr('remove', 'Remove');
    rm.textContent = '\u2715';
    rm.addEventListener('click', async () => {
      _dhExceptions = _dhExceptions.filter(d => d !== domain);
      await dhSaveExceptions();
      dhRenderExceptions();
      dhUpdateExcCount();
      dhResetConfirmState();
    });
    row.appendChild(name);
    row.appendChild(rm);
    list.appendChild(row);
  });
}
function dhShowExceptionsView(show) {
  const main = document.getElementById('dhMainView');
  const view = document.getElementById('dhExcView');
  if (!main || !view) return;
  main.style.display = show ? 'none' : '';
  view.style.display = show ? '' : 'none';
  if (show) {
    const err = document.getElementById('dhExcError');
    if (err) err.textContent = '';
    dhRenderExceptions();
    document.getElementById('dhExcInput')?.focus();
  }
}
// A changed exception list invalidates a pending "click Delete again" confirm.
function dhResetConfirmState() {
  const btn = document.getElementById('dhConfirmBtn');
  if (btn) delete btn.dataset.confirmed;
  const warn = document.getElementById('dhConfirmWarn');
  if (warn) warn.style.display = 'none';
}
async function dhAddException() {
  const input = document.getElementById('dhExcInput');
  const err = document.getElementById('dhExcError');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const domain = dhNormalizeDomain(raw);
  if (!domain) { if (err) err.textContent = tr('invalid_domain', 'Enter a valid domain, e.g. example.com'); return; }
  if (_dhExceptions.includes(domain)) { if (err) err.textContent = tr('domain_already_added', 'That domain is already on the list'); return; }
  _dhExceptions.push(domain);
  try { await dhSaveExceptions(); } catch (e) { _dhExceptions = _dhExceptions.filter(d => d !== domain); if (err) err.textContent = e.message; return; }
  input.value = '';
  if (err) err.textContent = '';
  dhRenderExceptions();
  dhUpdateExcCount();
  dhResetConfirmState();
  input.focus();
}

// ══ DEV MODE ═════════════════════════════════════════════════════════════
// Internal diagnostics panel: background timer stats (next history merge)
// and the live per-tab idle-time tracking state that drives auto-store.
let _devTabsVisible = false;
let _devModeWired = false;

function fmtDur(ms) {
  if (ms == null || ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0 && m === 0) return '0m';
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtWhen(ts) {
  if (!ts) return '—';
  const diff = ts - Date.now();
  const past = diff < 0;
  const label = fmtDur(Math.abs(diff));
  return past ? `${label} ago` : `in ${label}`;
}

function openDevModeModal() {
  document.getElementById('devModeModal').classList.add('open');
  loadDevStats();
  if (_devTabsVisible) loadDevTabs();
}
function closeDevModeModal() {
  document.getElementById('devModeModal').classList.remove('open');
}

async function loadDevStats() {
  const grid = document.getElementById('devStatsGrid');
  if (!grid) return;
  try {
    const s = await sendLong('GET_DEV_STATS');
    const nextFlushLabel = s.syncIntervalMins === 0
      ? 'Every visit (instant mode)'
      : s.nextFlushAt ? fmtWhen(s.nextFlushAt) : 'Due on next check (~1m)';
    const overdue = s.syncIntervalMins > 0 && s.nextFlushAt && s.nextFlushAt <= s.now;

    grid.innerHTML = '';
    const stats = [
      { label: 'Next history merge', value: nextFlushLabel, warn: overdue },
      { label: 'Last merge', value: s.lastFlushAt ? fmtWhen(s.lastFlushAt) : 'Never yet' },
      { label: 'Merge interval', value: s.syncIntervalMins === 0 ? 'Instant' : `${s.syncIntervalMins} min` },
      { label: 'Auto-store tabs', value: s.autoStoreEnabled ? `On · ${s.autoStoreHours}h idle threshold` : 'Off' },
      { label: 'Ignore-list cleanup', value: s.ignoreCleanupActive
          ? `Running… ${s.ignoreCleanupProgress.done}/${s.ignoreCleanupProgress.total}`
          : 'Idle', warn: s.ignoreCleanupActive },
    ];
    for (const st of stats) {
      const card = document.createElement('div');
      card.className = 'dev-stat';
      card.innerHTML = `<div class="dev-stat-label">${esc(st.label)}</div><div class="dev-stat-value${st.warn ? ' warn' : ''}">${esc(st.value)}</div>`;
      grid.appendChild(card);
    }
  } catch (err) {
    grid.innerHTML = `<div class="state-msg" style="grid-column:1/-1"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

async function loadDevTabs() {
  const list = document.getElementById('devTabsList');
  if (!list) return;
  list.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🗂</span>Loading…</div>';
  try {
    const r = await send('GET_DEV_TAB_IDLE');
    if (!r.tabs.length) {
      list.innerHTML = '<div class="empty-msg">No open tabs</div>';
      return;
    }
    list.innerHTML = '';
    for (const t of r.tabs) {
      const row = document.createElement('div');
      row.className = 'dev-tab-row';
      let tag;
      if (t.active) tag = 'active';
      else if (!t.trackable) tag = 'not trackable';
      else if (t.alreadyStored) tag = 'already stored';
      else tag = 'idle-tracked';
      const hot = t.trackable && !t.active && !t.alreadyStored && r.autoStoreEnabled && t.idleMs >= t.thresholdMs * 0.75;
      // Both idleMs (our accumulator) and wallIdleMs (raw lastAccessed gap)
      // have to clear the threshold before a store happens — show both
      // whenever they diverge by more than a minute so it's obvious which
      // gate, if any, is currently holding a tab back.
      const diverges = !t.active && Math.abs(t.idleMs - t.wallIdleMs) > 60000;
      const idleLabel = t.active ? '—' : fmtDur(t.idleMs);
      const wallNote = diverges ? ` <span style="color:var(--text3);font-weight:400">(wall: ${esc(fmtDur(t.wallIdleMs))})</span>` : '';
      row.innerHTML = `
        <span class="dtr-title" title="${esc(t.url)}">${esc(t.title)}</span>
        <span class="dtr-tag">${esc(tag)}</span>
        <span class="dtr-idle${hot ? ' hot' : ''}">${idleLabel}${wallNote}</span>`;
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

function wireDevMode() {
  if (_devModeWired) return;
  _devModeWired = true;

  document.getElementById('devModeBtn')?.addEventListener('click', openDevModeModal);
  document.getElementById('devModeCloseBtn')?.addEventListener('click', closeDevModeModal);
  document.getElementById('devModeModal')?.addEventListener('click', ev => {
    if (ev.target.id === 'devModeModal') closeDevModeModal();
  });
  document.getElementById('devRefreshBtn')?.addEventListener('click', () => {
    loadDevStats();
    if (_devTabsVisible) loadDevTabs();
  });
  document.getElementById('devListTabsBtn')?.addEventListener('click', () => {
    _devTabsVisible = !_devTabsVisible;
    const list = document.getElementById('devTabsList');
    if (list) list.style.display = _devTabsVisible ? 'block' : 'none';
    if (_devTabsVisible) loadDevTabs();
  });
}
// "Use as sidebar" is enabled (height doesn't apply to the sidebar panel).
function setupPopupSettingsListeners() {
  const heightInput  = document.getElementById('popupHeightInput');
  const heightVal    = document.getElementById('popupHeightVal');
  const heightRow    = document.getElementById('popupHeightRow');
  const sidebarToggle = document.getElementById('popupSidebarToggle');

  if (heightInput && heightVal) {
    heightInput.addEventListener('input', () => {
      heightVal.textContent = heightInput.value + 'px';
    });
  }
  if (sidebarToggle && heightRow) {
    sidebarToggle.addEventListener('change', () => {
      heightRow.style.opacity = sidebarToggle.checked ? '0.4' : '';
    });
  }

  const wheelToggle  = document.getElementById('datePillsWheelToggle');
  const wheelSensRow = document.getElementById('datePillsWheelSensRow');
  const wheelSensInput = document.getElementById('datePillsWheelSensInput');
  const wheelSensVal   = document.getElementById('datePillsWheelSensVal');
  if (wheelToggle && wheelSensRow) {
    wheelToggle.addEventListener('change', () => {
      wheelSensRow.style.opacity = wheelToggle.checked ? '' : '0.4';
    });
  }
  if (wheelSensInput && wheelSensVal) {
    wheelSensInput.addEventListener('input', () => {
      const n = wheelSensInput.value;
      wheelSensVal.textContent = `${n} day${n === '1' ? '' : 's'}/click`;
    });
  }

  const highContrastToggle = document.getElementById('highContrastToggle');
  if (highContrastToggle) {
    highContrastToggle.addEventListener('change', () => {
      applyHighContrastMode(highContrastToggle.checked);
    });
  }

  const roundedCornersToggle = document.getElementById('roundedCornersToggle');
  if (roundedCornersToggle) {
    roundedCornersToggle.addEventListener('change', () => {
      applyRoundedCorners(roundedCornersToggle.checked);
    });
  }

  // Live preview, like the other appearance toggles (persisted with Save)
  const navIconsToggle = document.getElementById('navIconsToggle');
  if (navIconsToggle) navIconsToggle.addEventListener('change', () => applyNavIcons(navIconsToggle.checked));
  const matchUiColorsToggle = document.getElementById('matchUiColorsToggle');
  if (matchUiColorsToggle) matchUiColorsToggle.addEventListener('change', () => applyMatchUiColors(matchUiColorsToggle.checked));
  const fadeInListToggle = document.getElementById('fadeInListToggle');
  if (fadeInListToggle) fadeInListToggle.addEventListener('change', () => { _fadeInListEnabled = fadeInListToggle.checked; });

  const calendarModeToggle = document.getElementById('calendarModeToggle');
  if (calendarModeToggle) {
    calendarModeToggle.addEventListener('change', () => {
      applyCalendarMode(calendarModeToggle.checked);
    });
  }
}

// Setup background tint event listeners
function setupBgTintListeners() {
  const toggle     = document.getElementById('bgTintToggle');
  const hue        = document.getElementById('bgTintHue');
  const opacity    = document.getElementById('bgTintOpacity');
  const hueVal     = document.getElementById('bgTintHueVal');
  const opacityVal = document.getElementById('bgTintOpacityVal');

  function syncTintToSettings() {
    _curSettings.bgTintEnabled = toggle ? toggle.checked : false;
    _curSettings.bgTintHue     = hue    ? parseInt(hue.value) : 220;
    _curSettings.bgTintOpacity = opacity ? parseInt(opacity.value) : 8;
    applyVisuals(_curSettings);
    send('SAVE_SETTINGS', { settings: {
      bgTintEnabled: _curSettings.bgTintEnabled,
      bgTintHue:     _curSettings.bgTintHue,
      bgTintOpacity: _curSettings.bgTintOpacity
    }}).catch(() => {});
  }

  if (toggle) {
    toggle.addEventListener('change', syncTintToSettings);
  }
  
  if (hue && hueVal) {
    hue.addEventListener('input', () => {
      hueVal.textContent = hue.value + '°';
      syncTintToSettings();
    });
  }
  
  if (opacity && opacityVal) {
    opacity.addEventListener('input', () => {
      opacityVal.textContent = opacity.value + '%';
      syncTintToSettings();
    });
  }
}

// ══ WALLPAPER MODE ══════════════════════════════════════════════════════════

// Apply wallpaper to the page (called on load and on change)
function applyWallpaper(wp) {
  const root = document.documentElement;
  const body = document.body;

  // Remove any previous wallpaper layer
  document.getElementById('eh-wallpaper-layer')?.remove();
  document.getElementById('eh-wallpaper-style')?.remove();
  root.classList.remove('wallpaper-mode');

  if (!wp || !wp.enabled || !wp.dataUrl) return;

  root.classList.add('wallpaper-mode');

  const overlayOpacity   = (wp.overlayOpacity ?? 40) / 100;
  const blurAmount       = wp.blurAmount ?? 10;
  const wallpaperOpacity = (wp.wallpaperOpacity ?? 60) / 100;
  const isDark            = (root.getAttribute('data-theme') || 'dark') === 'dark';

  // Glass tint for the frosted panels — black in dark mode, white in light
  // mode, matching the old overlay look.
  const glassRgba = a => isDark ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`;

  // Background layer div (fixed, behind everything). Kept crisp — no blur
  // filter here anymore. The blur + tint ("glass") now lives directly on
  // the sidebar/main/calendar surfaces via backdrop-filter below, so the
  // wallpaper stays sharp anywhere those panels aren't covering it, and the
  // panels genuinely blur what's behind them instead of everything being
  // uniformly blurred and dimmed. Wallpaper opacity (fading the photo
  // itself) is independent of the glass panel tint above.
  const layer = document.createElement('div');
  layer.id = 'eh-wallpaper-layer';
  const hueRot = (_curSettings.bgTintEnabled && _curSettings.bgTintHue !== undefined)
    ? `hue-rotate(${_curSettings.bgTintHue}deg)` : '';
  layer.style.cssText = `
    position:fixed;inset:0;z-index:-1;
    background:url(${wp.dataUrl}) center/cover no-repeat;
    ${hueRot ? `filter:${hueRot};` : ''}
    opacity:${wallpaperOpacity};
    transform:scale(1.05);
    pointer-events:none;
  `;
  body.prepend(layer);

  // Glass CSS injection
  const style = document.createElement('style');
  style.id = 'eh-wallpaper-style';
  style.textContent = `
    .bm-tree-pane, .bm-toolbar { background: transparent;}
    html.wallpaper-mode body { background: transparent !important; }

    /* Primary glass surfaces — blur amount and tint come straight from the
       wallpaper settings (Background blur / Glass color) instead of a
       fixed full-page overlay. */
    html.wallpaper-mode .sidebar,
    html.wallpaper-mode .main,
    html.wallpaper-mode .cal-sidebar {
      background: ${glassRgba(overlayOpacity)} !important;
      backdrop-filter: blur(${blurAmount}px) saturate(1.4) !important;
      -webkit-backdrop-filter: blur(${blurAmount}px) saturate(1.4) !important;
      border-color: var(--border) !important;
    }

    html.wallpaper-mode .modal-box,
    html.wallpaper-mode .s-card,
    html.wallpaper-mode .chart-card,
    html.wallpaper-mode .ctxMenu,
    html.wallpaper-mode .kpi-card,
    html.wallpaper-mode .modal-inner,
    html.wallpaper-mode .ignore-item,
    html.wallpaper-mode .session-card,
    html.wallpaper-mode .device-card,
    html.wallpaper-mode .ts-card,
    html.wallpaper-mode .mv-item,
    html.wallpaper-mode .settings-save-bar,
    .sel-bar.on{
      background: ${isDark ? 'rgba(19,19,24,0.55)' : 'rgba(255,255,255,0.55)'} !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.4) !important;
      border-color: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'} !important;
      color:var(--text2);
    }

    /* Day label bar sits ABOVE the list (outside the scroll area) so it never overlaps entries.
       The in-list labels become plain, non-sticky separators; the first one is redundant with the bar. */
    html.wallpaper-mode .day-label-bar { display: block !important; }
    html.wallpaper-mode .day-label-bar:empty { display: none !important; }
    html.wallpaper-mode .day-label{ background:none !important; }
    html.wallpaper-mode #listArea .day-label { position: static !important; }
    html.wallpaper-mode #rmListArea .day-label { position: static !important; }
    html.wallpaper-mode #listArea .day-label.dl-top { display: none !important; border:none !important }
    html.wallpaper-mode #rmListArea .day-label.dl-top { display: none !important; border:none !important }

    html.wallpaper-mode .list-area {
      background: ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'} !important;
    }
    /* Settings > Match UI colors: no tint of its own - the list shows the same
       glass as the sidebar / calendar sidebar / main panel behind it. */
    html.wallpaper-mode.match-ui-colors .list-area { background: transparent !important; }


    html.wallpaper-mode #ctxMenu {
      background: ${isDark ? 'rgba(22,22,28,0.96)' : 'rgba(252,252,255,0.96)'} !important;
      backdrop-filter: blur(20px) saturate(1.6) !important;
      -webkit-backdrop-filter: blur(20px) saturate(1.6) !important;
      border-color: ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'} !important;
    }
    html.wallpaper-mode ::placeholder , .modal-sub, .e-time , .bm-folder-label, .logo-sub{
    color:var(--text2) !important;
    }
    html.wallpaper-mode .rm-drop-desc, .rm-drop-hint, .bm-title{
    color:var(--text) !important;
    }
    html.wallpaper-mode .modal-backdrop{
    background: transparent !important;
    backdrop-filter: blur(50px);
    }
    html.wallpaper-mode  .state-msg{
    height:100%
    }
    /* .topbar has a solid background in the base stylesheet — let .main's
       own glass layer show through it instead of covering it again. */
    html.wallpaper-mode .topbar {
      background: transparent !important;
    }

    html.wallpaper-mode .entry {
      border-color: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'} !important;
    }
    html.wallpaper-mode .action-btn,
    html.wallpaper-mode .dn-pill,
    html.wallpaper-mode .chip,
    html.wallpaper-mode .nav-item,
    html.wallpaper-mode .tf-btn {
      border-color: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'} !important;
  
    }
    html.wallpaper-mode #dnLeft,#dnRight,.dn-pill, .tb-btn, .hn-pill, .sa-btn, .action-btn, .tf-btn, .chip, .wp-src-btn, .nav-arrow, .bm-sel-btn, #rmSearchMode, #rmDateFrom, #rmDateTo, #languageSelect{
      background-color: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'} !important;
      border-color: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'} !important;
      color:var(--text2) !important;
    }
    html.wallpaper-mode .dn-pill-day, input[type='date']{
    color:var(--text2) ;
    }
    html.wallpaper-mode input[type="text"],  input[type="password"], .sess-head, .dc-head{
    background:transparent !important;
    }
     html.wallpaper-mode .nav-item:hover , .bm-tree-row:hover, .ctx-item:hover{
    opacity:0.7 !important;
    }
    html.wallpaper-mode .ts-row:hover{
    background:transparent;
    backdrop-filter:opacity(0.4);
    }
    html.wallpaper-mode .hn-pill.active {
    background: color-mix(in srgb, var(--accent) 15%, transparent) !important;
    border-color: color-mix(in srgb, var(--accent) 50%, transparent) !important;
    }

    html.wallpaper-mode .action-btn.primary,
    html.wallpaper-mode .dn-pill.active,
    html.wallpaper-mode .chip.on,
    html.wallpaper-mode .nav-item.active,
    html.wallpaper-mode .tf-btn.active {
      background: var(--accent) !important;
      backdrop-filter: none !important;
      border-color: transparent !important;
      color:white !important;
      opacity: 0.9 !important;
    }
    html.wallpaper-mode input,
    html.wallpaper-mode select,
    html.wallpaper-mode textarea,
    html.wallpaper-mode .search-box {
      background-color: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'};
      border-color: ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'} !important;
    }
    html.wallpaper-mode .panel { background: transparent !important; }
    html.wallpaper-mode .panel, html.wallpaper-mode .main { position: relative; z-index: 1; }
  `;
  document.head.appendChild(style);
}

// Save wallpaper settings
async function saveWallpaper(wp) {
  try {
    await chrome.storage.local.set({ [WP_STORAGE_KEY]: wp });
  } catch(e) { toast('Failed to save wallpaper: ' + e.message, 'err'); }
}

// Load wallpaper on startup
async function loadAndApplyWallpaper() {
  try {
    const r = await chrome.storage.local.get(WP_STORAGE_KEY);
    const wp = r[WP_STORAGE_KEY];
    if (wp) {
      // Auto-randomize if using Unsplash source and flag is set
      if (wp.enabled && wp.source === 'splash' && wp.autoRandomize) {
        applyWallpaper(wp); // apply existing image immediately, then fetch new one
        _fetchAndApplySplash(wp);
        _ensureNextPrefetched();
      } else if (wp.enabled && wp.source === 'splash' && !wp.dataUrl) {
        // First open after install: no image yet, fetch one now
        _fetchAndApplySplash(wp);
      } else {
        applyWallpaper(wp);
      }
    }
    return wp;
  } catch { return null; }
}

// Fetch a new random Unsplash image and apply+save it
async function _fetchAndApplySplash(currentWp) {
  try {
    let dUrl = null;
    const r    = await chrome.storage.local.get(WP_NEXT_KEY);
    const next = r[WP_NEXT_KEY];
    if (next && next.dataUrl) {
      dUrl = next.dataUrl;
      await chrome.storage.local.remove(WP_NEXT_KEY);
    } else {
      dUrl = await _fetchRandomWallpaperDataUrl();
      if (!dUrl) return;
    }
    const newWp = { ...currentWp, dataUrl: dUrl };
    await chrome.storage.local.set({ [WP_STORAGE_KEY]: newWp });
    applyWallpaper(newWp);
    const preview = document.getElementById('wpCurrentPreview');
    if (preview) preview.src = dUrl;
    _prefetchNextWallpaper(); // queue next one silently
  } catch {}
}
// Fetch one random picsum image and return it as a dataUrl (or null on failure).
async function _fetchRandomWallpaperDataUrl() {
  try {
    const seed = Math.floor(Math.random() * 100000);
    const resp = await fetch(`https://picsum.photos/seed/${seed}/1920/1080`);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return new Promise((res) => {
      const reader = new FileReader();
      reader.onload  = () => res(reader.result);
      reader.onerror = () => res(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// Silently fetch a new random wallpaper and store it as the pre-fetched "next".
// Called in the background after applying a wallpaper so the following open is instant.
async function _prefetchNextWallpaper() {
  try {
    const dUrl = await _fetchRandomWallpaperDataUrl();
    if (dUrl) {
      await chrome.storage.local.set({ [WP_NEXT_KEY]: { dataUrl: dUrl, fetchedAt: Date.now() } });
    }
  } catch {}
}
async function _ensureNextPrefetched() {
  try {
    const r    = await chrome.storage.local.get(WP_NEXT_KEY);
    const next = r[WP_NEXT_KEY];
    const STALE = 7 * 24 * 60 * 60 * 1000;
    if (!next || !next.dataUrl || (Date.now() - (next.fetchedAt || 0)) > STALE) {
      _prefetchNextWallpaper();
    }
  } catch {}
}

function setupWallpaperListeners() {
  const toggle         = document.getElementById('wallpaperToggle');
  const controls       = document.getElementById('wallpaperControls');
  const srcBtns        = document.querySelectorAll('.wp-src-btn');
  const customPanel    = document.getElementById('wpCustomPanel');
  const splashPanel    = document.getElementById('wpSplashPanel');
  const dropZone       = document.getElementById('wpDropZone');
  const fileInput      = document.getElementById('wpFileInput');

  const splashLoadBtn  = document.getElementById('wpSplashLoadBtn');
  const splashCredit   = document.getElementById('wpSplashCredit');
  const previewWrap    = document.getElementById('wpPreviewWrap');
  const currentPreview = document.getElementById('wpCurrentPreview');
  const overlaySlider  = document.getElementById('wpOverlayOpacity');
  const overlayVal     = document.getElementById('wpOverlayVal');
  const blurSlider     = document.getElementById('wpBlurAmount');
  const blurVal        = document.getElementById('wpBlurVal');
  const clearBtn       = document.getElementById('wpClearBtn');
  const imgOpacitySlider = document.getElementById('wpImageOpacity');
  const imgOpacityVal    = document.getElementById('wpImageOpacityVal');

  if (!toggle) return;

  let _wpState = { enabled: false, dataUrl: null, overlayOpacity: 50, blurAmount: 8, wallpaperOpacity: 60, source: 'custom' };

  // Load existing wallpaper state into UI
  chrome.storage.local.get(WP_STORAGE_KEY, r => {
    const wp = r[WP_STORAGE_KEY];
    if (wp) {
      _wpState = { ..._wpState, ...wp, overlayOpacity: Math.max(40, wp.overlayOpacity ?? 40) };
      toggle.checked = wp.enabled || false;
      overlaySlider.value = _wpState.overlayOpacity;
      overlayVal.textContent = _wpState.overlayOpacity + '%';
      blurSlider.value = wp.blurAmount ?? 8;
      blurVal.textContent = (wp.blurAmount ?? 8) + 'px';
      if (imgOpacitySlider) imgOpacitySlider.value = wp.wallpaperOpacity ?? 60;
      if (imgOpacityVal)    imgOpacityVal.textContent = (wp.wallpaperOpacity ?? 60) + '%';
      if (wp.dataUrl) {
        previewWrap.style.display = 'block';
        currentPreview.src = wp.dataUrl;
      }
      // Restore auto-randomize toggle
      const autoRandToggle = document.getElementById('wpAutoRandomize');
      if (autoRandToggle) autoRandToggle.checked = wp.autoRandomize || false;
      // Switch to correct source panel
      if (wp.source === 'splash') {
        srcBtns.forEach(b => b.classList.toggle('active', b.dataset.src === 'splash'));
        customPanel.style.display = 'none';
        splashPanel.style.display = 'block';
      }
    }
  });

  // Toggle enable/disable
  toggle.addEventListener('change', async () => {
    _wpState.enabled = toggle.checked;
    applyWallpaper(_wpState);
    await saveWallpaper(_wpState);
  });

  // Source buttons
  srcBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      srcBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const src = btn.dataset.src;
      _wpState.source = src;
      customPanel.style.display = src === 'custom' ? 'block' : 'none';
      splashPanel.style.display = src === 'splash' ? 'block' : 'none';
    });
  });

  // Custom image: click drop zone
  dropZone?.addEventListener('click', () => fileInput?.click());
  dropZone?.addEventListener('dragover', ev => { ev.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
  dropZone?.addEventListener('dragleave', () => { dropZone.style.borderColor = ''; });
  dropZone?.addEventListener('drop', ev => {
    ev.preventDefault(); dropZone.style.borderColor = '';
    const f = ev.dataTransfer.files[0];
    if (f) _loadImageFile(f);
  });
  fileInput?.addEventListener('change', ev => {
    const f = ev.target.files[0];
    if (f) _loadImageFile(f);
    ev.target.value = '';
  });

  function _loadImageFile(file) {
    if (!file.type.startsWith('image/')) { toast('Please select an image file', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async e => {
      _wpState.dataUrl  = e.target.result;
      _wpState.source   = 'custom';
      _wpState.enabled  = true;
      toggle.checked    = true;
      previewWrap.style.display   = 'block';
      currentPreview.src          = _wpState.dataUrl;
      document.getElementById('wpDropLabel').innerHTML = '✓ Image loaded. Drop another to replace.';
      applyWallpaper(_wpState);
      await saveWallpaper(_wpState);
      toast('Wallpaper applied', 'ok');
    };
    reader.readAsDataURL(file);
  }

  // Unsplash random
    splashLoadBtn?.addEventListener('click', async () => {
    splashLoadBtn.textContent = '⏳ Loading…';
    splashLoadBtn.disabled    = true;
    try {
      // Use pre-fetched next if available, otherwise fetch live
      const r    = await chrome.storage.local.get(WP_NEXT_KEY);
      const next = r[WP_NEXT_KEY];
      let dUrl   = null;

      if (next && next.dataUrl) {
        dUrl = next.dataUrl;
        await chrome.storage.local.remove(WP_NEXT_KEY);
      } else {
        dUrl = await _fetchRandomWallpaperDataUrl();
        if (!dUrl) throw new Error('Failed to fetch image');
      }

      _wpState.dataUrl  = dUrl;
      _wpState.source   = 'splash';
      _wpState.enabled  = true;
      toggle.checked    = true;
      previewWrap.style.display = 'block';
      currentPreview.src        = dUrl;
      applyWallpaper(_wpState);
      await saveWallpaper(_wpState);
      toast('Wallpaper applied', 'ok');

      _prefetchNextWallpaper(); // queue the next one silently

    } catch(err) {
      toast('Could not load image: ' + err.message, 'err');
    }
    splashLoadBtn.textContent = 'Randomize';
    splashLoadBtn.disabled    = false;
  });
 // Auto-randomize toggle
  document.getElementById('wpAutoRandomize')?.addEventListener('change', async () => {
    _wpState.autoRandomize = document.getElementById('wpAutoRandomize').checked;
    _wpState.source = 'splash';
    await saveWallpaper(_wpState);
    if (_wpState.autoRandomize) _prefetchNextWallpaper(); // ← add this line
    toast(_wpState.autoRandomize ? 'Will randomize on every open' : 'Auto-randomize disabled', 'ok');
  });

  // Overlay slider
  overlaySlider?.addEventListener('input', async () => {
    _wpState.overlayOpacity = parseInt(overlaySlider.value);
    overlayVal.textContent  = _wpState.overlayOpacity + '%';
    applyWallpaper(_wpState);
    await saveWallpaper(_wpState);
  });

  // Blur slider
  blurSlider?.addEventListener('input', async () => {
    _wpState.blurAmount = parseInt(blurSlider.value);
    blurVal.textContent = _wpState.blurAmount + 'px';
    applyWallpaper(_wpState);
    await saveWallpaper(_wpState);
  });

  // Wallpaper (image) opacity — cheap direct style write while dragging so
  // it doesn't lag, full apply+save only once the user lets go.
  imgOpacitySlider?.addEventListener('input', () => {
    _wpState.wallpaperOpacity = parseInt(imgOpacitySlider.value);
    if (imgOpacityVal) imgOpacityVal.textContent = _wpState.wallpaperOpacity + '%';
    const layer = document.getElementById('eh-wallpaper-layer');
    if (layer) layer.style.opacity = _wpState.wallpaperOpacity / 100;
  });
  imgOpacitySlider?.addEventListener('change', async () => {
    await saveWallpaper(_wpState);
  });

  // Clear
  clearBtn?.addEventListener('click', async () => {
    if (!confirm('Remove the current wallpaper?')) return;
    _wpState = { enabled: false, dataUrl: null, overlayOpacity: 40, blurAmount: 10, wallpaperOpacity: 60, source: 'custom' };
    toggle.checked = false;
    previewWrap.style.display    = 'none';
    document.getElementById('wpDropLabel').innerHTML = 'Drop image here or <strong>click to browse</strong>';
    if (imgOpacitySlider) imgOpacitySlider.value = 60;
    if (imgOpacityVal)    imgOpacityVal.textContent = '60%';
    applyWallpaper(_wpState);
    await saveWallpaper(_wpState);
    toast('Wallpaper removed', 'ok');
  });
}

// ══ END WALLPAPER MODE ═══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Apply settings from chrome.storage.local directly — zero IPC latency for first paint
  const SETTINGS_KEY_LOCAL = 'eh_settings';
  try {
    const cached = await chrome.storage.local.get(SETTINGS_KEY_LOCAL);
    if (cached[SETTINGS_KEY_LOCAL]) {
      _curSettings = { ...cached[SETTINGS_KEY_LOCAL] };
      applyVisuals(_curSettings);
    }
  } catch {}

  // Also fetch via background to get merged defaults + any runtime state, update UI fully
  try {
    const s = await send('GET_SETTINGS');
    _curSettings = s;
    applyVisuals(s);
    populateSettings(s);
    loadStorageBackend();
    document.getElementById('migrateStorageBtn')?.addEventListener('click', migrateStorage);
  } catch {}

  // Theme buttons
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    setTheme((window.EhTheme ? EhTheme.effective() : document.documentElement.getAttribute('data-theme')) === 'dark' ? 'light' : 'dark');
  });
  // Follow-system toggle: previews immediately, saved with "Save Settings" (or reverted on discard)
  document.getElementById('followSystemThemeToggle')?.addEventListener('change', ev => {
    if (window.EhTheme) EhTheme.set(ev.target.checked, _curSettings.theme === 'light' ? 'light' : 'dark', false);
    applyTheme();
  });

  // Setup
  document.querySelectorAll('.nav-item[data-panel]').forEach(b =>
  b.addEventListener('click', () => switchPanel(b.dataset.panel)));

  // Delete history nav button
  document.getElementById('deleteHistoryNavBtn')?.addEventListener('click', openDeleteHistoryModal);

  // Bookmark search
  let _bmSearchTimer = null;
  document.getElementById('bmSearch')?.addEventListener('input', ev => {
    document.getElementById('bmSearchClearBtn')?.classList.toggle('visible', ev.target.value.length > 0);
    clearTimeout(_bmSearchTimer);
    _bmSearchTimer = setTimeout(() => renderBookmarksWithFilter(ev.target.value), 150);
  });

  // Build date nav with the correct number of pills based on the user's retention setting.
  // _curSettings is now fully resolved (both local cache + background merge above),
  // so retentionDays reflects the actual saved value (e.g. 5 years = 1825 days).
  buildDateNav(_curSettings.retentionDays);
  buildHourNav();
  applyDatePillsWheelScroll(_curSettings.datePillsWheelScroll === true, _curSettings.datePillsWheelSensitivity);
  applyHighContrastMode(_curSettings.highContrastMode === true);
  setupToolbar();
  setupSelActions();
  setupBgTintListeners();
  setupPopupSettingsListeners();
  wireDevMode();
  wireCalendarSidebar();
  setupWallpaperListeners();
  loadAndApplyWallpaper();
   // ── Scroll-to-bottom buttons ──────────────────────────────────────────────
  (function() {
    function setupScrollBtn(scrollEl, btnId) {
      const btn = document.getElementById(btnId);
      if (!scrollEl || !btn) return;
      const onScroll = () => {
        const atBottom = Math.ceil(scrollEl.scrollTop + scrollEl.clientHeight) >= scrollEl.scrollHeight - 4;
        btn.classList.toggle('visible', !atBottom && scrollEl.scrollHeight > scrollEl.clientHeight + 50);
      };
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
      btn.addEventListener('click', () => {
        const target = scrollEl.scrollTop + scrollEl.clientHeight;
        const max    = scrollEl.scrollHeight - scrollEl.clientHeight;
        scrollEl.scrollTo({ top: Math.min(target, max), behavior: 'smooth' });
      });
    }
    setupScrollBtn(document.getElementById('listArea'), 'histScrollBottom');
  })();

  // Default to Today — activate silently so doSearch below picks up filterDate
  //const todayKey = new Date().toLocaleDateString('en-CA');
  activateDatePill('all', true);

  doSearch();

  // Auto-focus the search input if enabled in settings (default: on)
  if (_curSettings.searchAutoFocus !== false) {
    setTimeout(() => { document.getElementById('searchInput')?.focus(); }, 120);
  }

  // Landed here from the "q" omnibox keyword with no direct history match —
  // pre-fill and run the search instead of dropping the query on the floor.
  const omniQuery = new URLSearchParams(location.search).get('q');
  if (omniQuery) {
    const si = document.getElementById('searchInput');
    if (si) { si.value = omniQuery; doSearch(); }
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // Hash routing — only switch away from history if explicitly requested; clear hash so refresh = history
  const hash = location.hash.slice(1);
  if (hash && hash !== 'history' && ['sessions','readingmode','tabstorage','devices','activity','timespent','mostvisited','bookmarks','ignorelist','quickfilters','settings','about'].includes(hash)) {
    switchPanel(hash);
  }
  history.replaceState(null, '', location.pathname);

  // Ctrl+F → search
  document.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') {
      ev.preventDefault();
      document.getElementById('searchInput').focus();
    }
    if (ev.key === 'Escape' && selMode) exitSelMode();
  });

  // Delete History Modal events (wired here, after DOM ready)
  document.getElementById('dhCancelBtn').addEventListener('click', closeDeleteHistoryModal);
  document.getElementById('deleteHistoryModal').addEventListener('click', ev => {
    if (ev.target === document.getElementById('deleteHistoryModal')) closeDeleteHistoryModal();
  });

  // Domain exceptions (list view inside the Delete History modal)
  document.getElementById('dhExceptionsBtn')?.addEventListener('click', async () => {
    await dhLoadExceptions();
    dhShowExceptionsView(true);
  });
  document.getElementById('dhExcBackBtn')?.addEventListener('click', () => dhShowExceptionsView(false));
  document.getElementById('dhExcAddBtn')?.addEventListener('click', dhAddException);
  document.getElementById('dhExcInput')?.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); dhAddException(); }
    else if (ev.key === 'Escape') { ev.stopPropagation(); dhShowExceptionsView(false); }
  });
  document.getElementById('dhExcInput')?.addEventListener('input', () => {
    const err = document.getElementById('dhExcError'); if (err) err.textContent = '';
  });

  document.getElementById('dhRangeGrid').addEventListener('click', ev => {
    const btn = ev.target.closest('.dh-range-btn');
    if (!btn) return;
    _dhSelectedRange = btn.dataset.range;
    document.querySelectorAll('.dh-range-btn').forEach(b => b.classList.toggle('active', b === btn));
    // Reset confirm state when user picks a new range
    const confirmBtn = document.getElementById('dhConfirmBtn');
    confirmBtn.disabled = false;
    delete confirmBtn.dataset.confirmed;
    const warn = document.getElementById('dhConfirmWarn');
    if (warn) warn.style.display = 'none';
  });

  document.getElementById('dhConfirmBtn').addEventListener('click', async () => {
    if (!_dhSelectedRange) return;

    // Two-step confirm: first click shows the confirm warning, second click deletes
    const btn = document.getElementById('dhConfirmBtn');
    if (!btn.dataset.confirmed) {
      // Step 1: show confirm state
      // Reuse the (already translated) label of the range button the user picked
      const activeBtn = document.querySelector('.dh-range-btn.active');
      const label = (activeBtn ? activeBtn.textContent.trim() : '') || _dhSelectedRange;
      await dhLoadExceptions();
      await dhLoadAnchor();
      const warn = document.getElementById('dhConfirmWarn');
      if (warn) {
        const tt = rangeToTimes(_dhSelectedRange);
        const when = (tt && tt[0] > 0)
          ? ` (${new Date(tt[0]).toLocaleString()} → ${tr('dh_now', 'now')}; ${_dhAnchorFound ? tr('dh_from_newest','counted from your newest entry, {0}').replace('{0}', new Date(_dhAnchor).toLocaleString()) : tr('dh_from_now', 'newest entry unknown — counted from now')})`
          : '';
        let msg = tr('dh_confirm_warn', 'This will permanently delete history for: {0}. Click Delete again to confirm.', label + when);
        if (_dhExceptions.length) msg += ' ' + tr('dh_confirm_exceptions', 'Domains on your exceptions list ({0}) will be kept.', _dhExceptions.length);
        warn.textContent = '\u26a0 ' + msg;
        warn.style.display = 'block';
      }
      btn.dataset.confirmed = '1';
      btn.style.animation = 'dhPulse 0.3s ease';
      return;
    }

    // Step 2: actually delete
    const times = rangeToTimes(_dhSelectedRange);
    if (!times) return;
    const [startTime, endTime] = times;
    const clearCookies = document.getElementById('dhCookies').checked;
    const clearCache   = document.getElementById('dhCache').checked;
    btn.disabled = true;
    btn.textContent = tr('deleting', 'Deleting…');
    try {
      await dhLoadExceptions(); // same list the background will enforce
      // Long deletes (big history) report progress from the database — show it on the button.
      const poll = setInterval(async () => {
        try {
          const p = await new Promise(res => chrome.runtime.sendMessage({ type: 'GET_DB_PROGRESS' }, x => { void chrome.runtime.lastError; res(x || {}); }));
          const base = tr('deleting', 'Deleting…');
          if (p.phase === 'deleting' && p.total) btn.textContent = base + ' ' + Math.min(99, Math.round(100 * p.done / p.total)) + '%';
          else if (p.phase === 'indexing') btn.textContent = base + ' (' + tr('updating_index', 'updating search index') + ')';
        } catch (_) {}
      }, 700);
      let r;
      try { r = await sendLong('DELETE_HISTORY_RANGE', { startTime, endTime, clearCookies, clearCache }); }
      finally { clearInterval(poll); }
      if (r?.error) { toast(r.error, 'err'); }
      else {
        toast(tr('deleted_history_entries', 'Deleted {0} history entries', fmtNum(r.deleted || 0))
          + (clearCookies ? ' + ' + tr('word_cookies', 'cookies') : '')
          + (clearCache ? ' + ' + tr('word_cache', 'cache') : ''), 'ok');
        // Keep anything on an excepted domain - it wasn't deleted.
        allResults = allResults.filter(e => !(e.visitTime >= startTime && e.visitTime <= endTime) || dhIsExcepted(e.url));
        buildVirtualList();
      }
    } catch(err) { toast(err.message, 'err'); }
    btn.textContent = tr('delete', 'Delete');
    closeDeleteHistoryModal();
  });

});

// -- Language menu (Settings > Appearance) -----------------------------------
// "auto" follows the browser language through chrome.i18n. Any other choice is
// applied by i18n-core.js (chrome.i18n itself can't be told to use a different
// language). Stored in localStorage so it can be read synchronously at load.
(function initLanguageMenu() {
  const sel = document.getElementById('languageSelect');
  if (!sel) return;
  sel.value = window._ehUiLangChoice || 'auto';
  sel.addEventListener('change', () => {
    try {
      if (sel.value === 'auto') localStorage.removeItem('eh_ui_lang');
      else localStorage.setItem('eh_ui_lang', sel.value);
    } catch {}
    // Reload so every string - including ones built in JS - is in the new language;
    // the #settings hash brings the user straight back to this panel.
    location.hash = 'settings';
    location.reload();
  });
})();

// ══ MOST VISITED START ════════════════════════════════════════════════════════════
let curMvType = 'url';     // 'url' or 'domain'
let curMvPeriod = 'all';   // '10', '30', or 'all'

async function loadMostVisited() {
  curMvType = curMvType || 'url';
  curMvPeriod = curMvPeriod || 'all';
  
  // Update filter button states
  document.querySelectorAll('#mvTypeFilter .tf-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === curMvType));
  document.querySelectorAll('#mvPeriodFilter .tf-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === curMvPeriod));
  
  // Update chart title
  const typeLabel = curMvType === 'url' ? _ehMsg("urls")  : _ehMsg("domains") ;
  const periodLabel = curMvPeriod === 'all' ? _ehMsg("all_time") : `${curMvPeriod} `+ _ehMsg("days");
  document.getElementById('mvChartTitle').textContent = _ehMsg("most_visited") +` ${typeLabel} — ${periodLabel}`;

  const el = document.getElementById('mvContent');
  el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">⏳</span><span data-i18n-key="loading">Loading…</span></div>';
  
  try {
    const data = await sendLong('GET_MOST_VISITED', { viewType: curMvType, period: curMvPeriod });
    renderMostVisited(data.items);
  } catch (err) {
    //console.error('[MostVisited] Error:', err);
    el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">⚠</span>Error loading data</div>';
  }
}

function renderMostVisited(items) {
  const el = document.getElementById('mvContent');
  
  if (!items || !items.length) {
    el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔥</span>No visits yet. Keep browsing!</div>';
    return;
  }
  
  el.innerHTML = items.map((item, idx) => {
    const rank = idx + 1;
    const isTop3 = rank <= 3;
    const domain = curMvType === 'url' ? tryDomain(item.identifier) : item.identifier;
    const displayTitle = curMvType === 'url' ? (item.title || item.identifier) : item.identifier;
    const displayUrl = curMvType === 'url' ? item.identifier : '';
    const visitLabel = item.count === 1 ? 'visit' : 'visits';
    
    return `<div class="mv-item" data-url="${esc(curMvType === 'url' ? item.identifier : `https://${item.identifier}`)}">
      <div class="mv-rank ${isTop3 ? 'top3' : ''}">${rank}</div>
      <img class="mv-favicon" src="${favUrl(domain)}" loading="lazy"/>
      <div class="mv-info">
        <div class="mv-title">${esc(displayTitle)}</div>
        ${displayUrl ? `<div class="mv-url">${esc(displayUrl)}</div>` : ''}
      </div>
      <div class="mv-count">
        <div class="mv-count-number">${fmtNum(item.count)}</div>
        <div class="mv-count-label">${visitLabel}</div>
      </div>
    </div>`;
  }).join('');
  
  // Add click handlers and favicon error handlers
  el.querySelectorAll('.mv-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });
  
  // Add favicon error handlers
  el.querySelectorAll('.mv-favicon').forEach(img => {
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  });
}

// Most Visited filter handlers
document.getElementById('mvTypeFilter')?.addEventListener('click', ev => {
  const btn = ev.target.closest('.tf-btn');
  if (btn && btn.dataset.type) {
    curMvType = btn.dataset.type;
    loadMostVisited();
  }
});

document.getElementById('mvPeriodFilter')?.addEventListener('click', ev => {
  const btn = ev.target.closest('.tf-btn');
  if (btn && btn.dataset.period) {
    curMvPeriod = btn.dataset.period;
    loadMostVisited();
  }
});
// ══ MOST VISITED END ════════════════════════════════════════════════════════════