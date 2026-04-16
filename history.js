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
    chrome.runtime.sendMessage({ type, ...extra }, r => {
      if (chrome.runtime.lastError) { rej(new Error(chrome.runtime.lastError.message)); return; }
      if (r && r.error) { rej(new Error(r.error)); return; }
      res(r);
    });
  });
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
function _b64toU8(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

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
  
  if (diff === 0) return chrome.i18n.getMessage("today") || 'Today';
  if (diff === 1) return chrome.i18n.getMessage("yesterday") || 'Yesterday';
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

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ── Theme ──────────────────────────────────────────────────────────────────
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeLight').classList.toggle('active', t === 'light');
  document.getElementById('themeDark').classList.toggle('active', t === 'dark');
  _curSettings.theme = t;
  send('SAVE_SETTINGS', { settings: { theme: t } }).catch(() => {});
  // Re-apply wallpaper so overlay color adapts to new theme
  chrome.storage.local.get(WP_STORAGE_KEY, r => { if (r[WP_STORAGE_KEY]?.enabled) applyWallpaper(r[WP_STORAGE_KEY]); });
}

// ── State ──────────────────────────────────────────────────────────────────
let allResults   = [];   // all matching entries from backend
let selected     = new Set();
let selMode      = false;
let filterDate   = null; // 'YYYY-MM-DD'
let filterHour   = null; // 0-23
let searchTimer  = null;
let _curSettings = {};

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

  if (!allResults.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span>No history found</div>`;
    return;
  }

  area.innerHTML = '';
  appendPage();          // render first page immediately
  setupScrollObserver(area);
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
      hdr.innerHTML = `${esc(dl)}<span class="day-visits"></span>`;
      area.appendChild(hdr);
      prevDay = dl;
    }

    const sel = selected.has(e.id);
    const row = document.createElement('div');
    row.className = `entry${sel ? ' sel' : ''}${selMode ? ' sel-mode-entry' : ''}`;
    row.dataset.id  = e.id;
    row.dataset.url = e.url;
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
  return { query: q, mode, startDate: fromTs, endDate: toTs };
}

async function doSearch() {
  const { query, mode, startDate, endDate } = getFilters();
  selected.clear(); selMode = false; updateSelBar();

  listArea().innerHTML = `<div class="state-msg" style="color:var(--text3);font-size:0.85rem">Loading…</div>`;

  try {
    // Fast path: If no filters and no query, show today's history immediately
    const isInitialLoad = !query && !startDate && !endDate;
    
    // (no special fast-path needed: SEARCH now merges live today + past storage in one call)
    
    // Normal path: query with filters or no today's data
    const r   = await send('SEARCH', { query, mode, startDate, endDate, limit: 10000 });
    allResults = r.entries;
    buildVirtualList();
  } catch (err) {
    listArea().innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

// ── Date nav ────────────────────────────────────────────────────────────────
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function buildDateNav() {
  const scroll = document.getElementById('dateScroll');
  const now    = Date.now();

  function addBtn(label, key, weekday) {
    const b = document.createElement('button');
    b.className    = 'dn-pill';
    b.dataset.date = key;
    if (weekday) {
      b.innerHTML = `<span class="dn-pill-label">${esc(label)}</span><span class="dn-pill-day">${esc(weekday)}</span>`;
    } else {
      b.classList.add('no-day');
      b.textContent = label;
    }
    b.addEventListener('click', () => activateDatePill(key));
    scroll.appendChild(b);
    return b;
  }

  // "All" is a static pill in HTML (outside the scroll), just wire it
  const allPill = document.getElementById('dnAllPill');
  if (allPill) allPill.addEventListener('click', () => activateDatePill('all'));

  // Date pills: today, yesterday, then remaining days — "All" is NOT in the scroll
  for (let i = 0; i < 1000; i++) {
    const d   = new Date(now - i * 86400000);
    const key = d.toLocaleDateString('en-CA');
    if (i === 0) { addBtn(chrome.i18n.getMessage('today')     || 'Today',     key, ''); continue; }
    if (i === 1) { addBtn(chrome.i18n.getMessage('yesterday') || 'Yesterday', key, ''); continue; }
    addBtn(d.toLocaleDateString(undefined, { month:'short', day:'numeric' }), key, DAYS[d.getDay()]);
  }

  // Arrow buttons: click scrolls; hold scrolls continuously
  (function setupArrows() {
    const wrap = document.getElementById('dateScrollWrap');
    let _holdTimer = null, _holdInterval = null;
    function startHold(dir) {
      stopHold();
      wrap.scrollBy({ left: dir * 220, behavior: 'smooth' });
      _holdTimer = setTimeout(() => {
        _holdInterval = setInterval(() => wrap.scrollBy({ left: dir * 120 }), 80);
      }, 400);
    }
    function stopHold() {
      clearTimeout(_holdTimer); clearInterval(_holdInterval);
      _holdTimer = null; _holdInterval = null;
    }
    const L = document.getElementById('dnLeft');
    const R = document.getElementById('dnRight');
    L.addEventListener('mousedown', () => startHold(-1));
    R.addEventListener('mousedown', () => startHold(1));
    ['mouseup','mouseleave'].forEach(ev => { L.addEventListener(ev, stopHold); R.addEventListener(ev, stopHold); });
    L.addEventListener('touchstart', (e) => { e.preventDefault(); startHold(-1); }, { passive: false });
    R.addEventListener('touchstart', (e) => { e.preventDefault(); startHold(1);  }, { passive: false });
    ['touchend','touchcancel'].forEach(ev => { L.addEventListener(ev, stopHold); R.addEventListener(ev, stopHold); });
  })();
}

function activateDatePill(key, silent) {
  filterHour = null;
  document.querySelectorAll('.hn-pill').forEach(b => b.classList.remove('active'));
  document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');

  filterDate = key === 'all' ? null : key;
  document.getElementById('dateFrom').value = filterDate || '';
  document.getElementById('dateTo').value   = filterDate || '';

  // Clear all pills in scroll + the external All pill
  document.querySelectorAll('#dateScroll .dn-pill').forEach(b => b.classList.remove('active'));
  const allPill = document.getElementById('dnAllPill');
  if (allPill) allPill.classList.remove('active');

  if (key === 'all') {
    if (allPill) allPill.classList.add('active');
  } else {
    const t = document.querySelector(`#dateScroll .dn-pill[data-date="${key}"]`);
    if (t) {
      t.classList.add('active');
      if (!silent) {
        const wrap = document.getElementById('dateScrollWrap');
        // Collect all pills and measure the combined width of up to 4 pills before
        // the active one (including their gaps), so the active pill lands with
        // 4 visible pills to its left.
        const allPills = Array.from(document.querySelectorAll('#dateScroll .dn-pill'));
        const idx = allPills.indexOf(t);
        const pillsBack = wrap.offsetWidth < 700 ? 2 : 6;
        const precedingPills = allPills.slice(Math.max(0, idx - pillsBack), idx);
        const gap = 5; // matches CSS gap: 5px on .date-scroll
        const offsetBefore = precedingPills.reduce((sum, p) => sum + p.offsetWidth + gap, 0);
        const pillLeft = t.getBoundingClientRect().left - wrap.getBoundingClientRect().left + wrap.scrollLeft;
        wrap.scrollTo({ left: pillLeft - offsetBefore, behavior: 'smooth' });
      }
    }
  }
  updateHourPillsState();
  if (!silent) doSearch();
}

// ── Hour nav ────────────────────────────────────────────────────────────────
function buildHourNav() {
  const row = document.getElementById('hourRow');

  function addPill(label, h) {
    const b = document.createElement('button');
    b.className    = 'hn-pill';
    b.textContent  = label;
    b.dataset.h    = h === null ? 'all' : h;
    b.addEventListener('click', () => {
      if (h === null) {
        filterHour = null;
        document.querySelectorAll('.hn-pill').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      } else {
        filterHour = filterHour === h ? null : h;
        document.querySelectorAll('.hn-pill').forEach(x => x.classList.remove('active'));
        if (filterHour !== null) b.classList.add('active');
        else document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');
      }
      doSearch();
    });
    row.appendChild(b);
    return b;
  }

  addPill('All', null).classList.add('active');
  for (let h = 0; h < 24; h++) {
    const lbl = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
    addPill(lbl, h);
  }
  updateHourPillsState();
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
}

// ── Toolbar ─────────────────────────────────────────────────────────────────
function setupToolbar() {
  const si       = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClearBtn');

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

  // "All time" — clears only date/hour filters, NOT the search text
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value   = '';
    filterDate = null; filterHour = null;
    document.querySelectorAll('#dateScroll .dn-pill').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.hn-pill').forEach(b => b.classList.remove('active'));
    const allPill = document.getElementById('dnAllPill');
    if (allPill) { document.querySelectorAll('#dateScroll .dn-pill').forEach(b=>b.classList.remove('active')); allPill.classList.add('active'); }
    document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');
    updateHourPillsState();
    doSearch();
  });

  document.getElementById('deleteResultsBtn').addEventListener('click', deleteMatching);
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
async function deleteSingle(id) {
  try {
    const entry = allResults.find(e => e.id === id);
    const urls = entry ? [entry.url, entry.rawUrl].filter(Boolean) : [];
    await send('DELETE_IDS', { ids: [id], urls });
    allResults = allResults.filter(e => e.id !== id);
    selected.delete(id);
    if (selected.size === 0) exitSelMode();
    else updateSelBar();
    buildVirtualList();
    toast('Deleted', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function deleteIds(ids) {
  if (!ids.length) return;
  if (!confirm(`Delete ${fmtNum(ids.length)} item${ids.length !== 1 ? 's' : ''}?`)) return;
  try {
    const idSet = new Set(ids);
    const urls = allResults
      .filter(e => idSet.has(e.id))
      .flatMap(e => [e.url, e.rawUrl].filter(Boolean));
    await send('DELETE_IDS', { ids, urls });
    const s = new Set(ids);
    allResults = allResults.filter(e => !s.has(e.id));
    exitSelMode();
    buildVirtualList();
    toast(`Deleted ${fmtNum(ids.length)} items`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function deleteMatching() {
  if (!allResults.length) { toast('No results to delete'); return; }
  const { query, mode, startDate, endDate } = getFilters();
  
  // Check if "all time" is selected (no date filters)
  const isAllTime = !startDate && !endDate;
  const confirmMsg = isAllTime 
   ? chrome.i18n.getMessage("confirm_delete_all_time", fmtNum(allResults.length))
  : chrome.i18n.getMessage("confirm_delete_filtered", fmtNum(allResults.length));
  
  if (!confirm(confirmMsg)) return;
  
  try {
    const r = await send('DELETE_MATCHING', { query, mode, startDate, endDate });
    toast(`Deleted ${fmtNum(r.deleted)} items`, 'ok');
    allResults = []; exitSelMode(); buildVirtualList();
  } catch (err) { toast(err.message, 'err'); }
}

// ══ ACTIVITY ════════════════════════════════════════════════════════════════
async function loadActivity() {
  try {
    const s    = await send('GET_STATS');
    const key  = new Date().toLocaleDateString('en-CA');
    const todayCt = s.dailyActivity?.[key] || 0;
    document.getElementById('actKpi').innerHTML = `
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="total_visits">Total visits</div><div class="kpi-val">${fmtNum(s.totalEntries)}</div></div>
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="today">Today</div><div class="kpi-val">${fmtNum(todayCt)}</div></div>
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="storage">Storage</div><div class="kpi-val sm">${s.storageMB} MB</div></div>
    <div class="kpi-card"><div class="kpi-label" data-i18n-key="since">Since</div><div class="kpi-val sm">${s.oldestEntry ? new Date(s.oldestEntry).toLocaleDateString(undefined, { month:'short', year:'numeric' }) : '—'}</div></div>
    `;
    // Reapply translations to dynamically added content
    if (typeof window.applyTranslations === 'function' && window._currentLang) {
      window.applyTranslations(window._currentLang);
    }
    drawLineChart(s.dailyActivity);
    drawBarChart(s.dailyActivity);
  } catch (err) { console.error(err); }
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

  let dots = '';
  entries.forEach(([date, v], i) => {
    if (i % 7 !== 0 && i !== entries.length - 1) return;
    dots += `<circle class="c-dot" cx="${xOf(i)}" cy="${yOf(v)}" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="2" data-d="${date}" data-v="${v}"/>`;
  });

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
  <path class="c-path" d="${path}" stroke="var(--accent)"/>
  ${dots}`;

  svg.querySelectorAll('.c-dot').forEach(dot => {
    dot.addEventListener('mousemove', ev => {
      const r = wrap.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = `${ev.clientX - r.left + 14}px`;
      tip.style.top  = `${ev.clientY - r.top  - 38}px`;
      tip.innerHTML  = `<b>${dot.dataset.d}</b> — ${dot.dataset.v} visits`;
    });
    dot.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    dot.addEventListener('click', () => { activateDatePill(dot.dataset.d); switchPanel('history'); });
  });

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

async function loadTimeSpent(days) {
  curTimeDays = days;
  document.querySelectorAll('.tf-btn').forEach(b =>
  b.classList.toggle('active', parseInt(b.dataset.days) === days));
  try {
    await send('FLUSH_TIME');
    const r = await send('GET_TIME_DATA', { days });
    drawTimeChart(r.dailyMap, days);
    renderHbars(r.topSites);
    drawPie(r.topSites);
  } catch (err) { console.error(err); }
}

document.getElementById('timeFilters').addEventListener('click', ev => {
  if (ev.target.classList.contains('tf-btn')) loadTimeSpent(parseInt(ev.target.dataset.days));
});

function drawTimeChart(dailyMap, days) {
  const svg  = document.getElementById('timeSvg');
  const tip  = document.getElementById('timeTip');
  const wrap = svg.parentElement;
  const W    = wrap.clientWidth || 860;
  const H    = 130;
  const p    = { t: 12, r: 12, b: 4, l: 46 };
  const iW   = W - p.l - p.r, iH = H - p.t - p.b;

  const now   = Date.now();
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

  let dots = '';
  const gap = days <= 15 ? 2 : days <= 30 ? 4 : 9;
  dates.forEach((d, i) => {
    if (i % gap !== 0 && i !== dates.length - 1) return;
    const v = vals[i], lbl = v >= 60 ? `${(v/60).toFixed(1)}h` : `${v}m`;
    dots += `<circle class="c-dot" cx="${xOf(i)}" cy="${yOf(v)}" r="3.5" fill="var(--accent2)" stroke="var(--bg)" stroke-width="2" data-d="${d}" data-lbl="${lbl}"/>`;
  });

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
  ${path ? `<path class="c-path" d="${path}" stroke="var(--accent2)"/>` : `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12" fill="var(--text3)" font-family="var(--font-mono)">No time data yet</text>`}
  ${dots}`;

  svg.querySelectorAll('.c-dot').forEach(dot => {
    dot.addEventListener('mousemove', ev => {
      const r = wrap.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = `${ev.clientX - r.left + 14}px`;
      tip.style.top  = `${ev.clientY - r.top  - 38}px`;
      tip.innerHTML  = `<b>${dot.dataset.d}</b> — ${dot.dataset.lbl}`;
    });
    dot.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });

  const lblEl = document.getElementById('timeLabels');
  lblEl.innerHTML = dates.map((d, i) => {
    const lbl = (i % gap === 0) ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '';
    return `<div style="flex:1;text-align:center;font-size:0.57rem;color:var(--text3);font-family:var(--font-mono);overflow:hidden">${lbl}</div>`;
  }).join('');
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

    function buildSessionCard(dateLabel, badgeText, tabsArr) {
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
      tabCount.textContent = `${tabsArr.length} tabs`;

      const exportBtn = document.createElement('button');
      exportBtn.className   = 'tb-btn';
      exportBtn.textContent = '⬇ Export';
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
        restoreBtn.textContent = '↺ ' + (chrome.i18n.getMessage('restore') || 'Restore');
        restoreBtn.setAttribute('data-i18n-key', 'restore');
        restoreBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;flex-shrink:0;margin-right:4px;color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)';
        restoreBtn.addEventListener('click', async ev => {
          ev.stopPropagation();
          const urls = tabsArr.filter(t => t.url).map(t => t.url);
          if (urls.length > 20 && !confirm(`Restore ${urls.length} tabs?`)) return;
          try {
            await send('RESTORE_SESSION', { tabs: tabsArr });
            toast(`Restored ${urls.length} tabs`, 'ok');
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

      card.appendChild(head);
      card.appendChild(tabsEl);
      return card;
    }

    if (current) {
      const dur = fmtDuration(Date.now() - current.start);
      el.appendChild(buildSessionCard(
        { main: chrome.i18n.getMessage("current_session"), sub: `Started ${timeAgo(current.start)} · ${dur}` },
                                      chrome.i18n.getMessage("active"), current.tabs
      ));
    }
    
    sessions.forEach(sess => {
      const dur  = fmtDuration(sess.end - sess.start);
      const date = new Date(sess.start).toLocaleString(undefined, { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      el.appendChild(buildSessionCard(
        { main: date, sub: `${dur} · ${sess.tabCount} unique tabs` },
        null, sess.tabs
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
  img.src       = favUrl(dom);
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
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📑</span>No stored tabs yet.<br><small style="color:var(--text3)">Right-click any page → Extended History → Store this tab</small></div>';
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
    clearBtn.textContent = '🗑 Clear all';
    clearBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,transparent)';
    clearBtn.addEventListener('click', async () => {
      if (!confirm(`Clear all ${entries.length} stored tabs?`)) return;
      await send('CLEAR_TAB_STORAGE');
      toast('Tab storage cleared', 'ok');
      loadTabStorage();
    });
    header.appendChild(countEl);
    header.appendChild(clearBtn);
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
      fav.src = favUrl(dom);
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
        await send('REMOVE_TAB_STORAGE_ENTRY', { id: entry.id });
        loadTabStorage();
      });
      row.addEventListener('click', async () => {
        chrome.tabs.create({ url: entry.url, active: false });
        await send('REMOVE_TAB_STORAGE_ENTRY', { id: entry.id });
        loadTabStorage();
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
  el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📡</span>Loading…</div>';
  try {
    const { devices } = await send('GET_DEVICES');
    if (!devices?.length) {
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📡</span>No synced devices found.<br><small style="color:var(--text3)">Sign in to Chrome and enable Sync.</small></div>';
      return;
    }

    el.innerHTML = '';
    devices.forEach(dev => {
      const icon = /phone|mobile|android|ios/i.test(dev.deviceName || '') ? '📱' : '💻';
      const tabs = dev.sessions?.flatMap(s => s.window?.tabs || []) || [];

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

      const toggle = document.createElement('span');
      toggle.className = 'dc-toggle';
      toggle.textContent = '▶';

      head.appendChild(headLeft);
      head.appendChild(toggle);
      card.appendChild(head);

      // ── Tab list (collapsed by default) ──
      const tabsEl = document.createElement('div');
      tabsEl.className = 'dc-tabs-list';

      tabs.slice(0, 50).forEach(t => {
        const dom = tryDomain(t.url || '');
        const row = document.createElement('div');
        row.className = 'dc-row';
        row.addEventListener('click', () => chrome.tabs.create({ url: t.url, active: false }));

        const img = document.createElement('img');
        img.className = 'dc-rfav';
        img.src       = favUrl(dom);
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
      });

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
  } catch (err) {
    el.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

// ══ BOOKMARKS — split-pane tree + list ══════════════════════════════════════
let _bmTree        = null;   // full Chrome bookmark tree
let _bmActiveNode  = null;   // currently selected folder node (null = root)
let _bmItems       = [];     // flat list of bookmark items for current view
let _bmOffset      = 0;      // pagination offset
let _bmLoading     = false;  // pagination in-flight guard
const BM_PAGE      = 80;     // bookmarks per page
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
  listPane.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔖</span>Loading…</div>';
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

// Render the left folder tree pane
function renderBmTree() {
  const pane = document.getElementById('bmTreePane');
  if (!pane) return;
  pane.innerHTML = '';

  // "All bookmarks" root entry
  const rootRow = document.createElement('div');
  rootRow.className = 'bm-tree-row' + (_bmActiveNode === null ? ' active' : '');
  rootRow.innerHTML = '<span class="bm-tr-icon">📚</span><span class="bm-tr-label">All Bookmarks</span>';
  rootRow.addEventListener('click', () => { _bmActiveNode = null; renderBmTree(); renderBmItems(null); });
  pane.appendChild(rootRow);

  // ── Delegated drag-and-drop for entire tree pane ──────────────────────────
  // Using a SINGLE dragover/dragleave/drop listener on the pane instead of one
  // per row eliminates the per-row overhead that caused lag in large trees.
  let _lastDropRow = null;
  const _rowNodeMap = new WeakMap(); // maps DOM row → bookmark node (or null for root)

  function clearDropHighlight() {
    if (_lastDropRow) {
      _lastDropRow.classList.remove('bm-drop-target', 'bm-folder-drop-into', 'bm-folder-drop-above', 'bm-folder-drop-below');
      _lastDropRow = null;
    }
  }

  // Attach delegated listeners once on the pane
  // ev.preventDefault() must be called synchronously (browser requirement for drop to work),
  // but the highlight DOM update is deferred via rAF so it runs at most once per frame.
  let _rafPending = false;
  let _pendingRow = null;
  pane.addEventListener('dragover', ev => {
    if (!_bmDragId && !_bmFolderDragId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    _pendingRow = ev.target.closest('.bm-tree-row');
    if (!_rafPending) {
      _rafPending = true;
      requestAnimationFrame(() => {
        _rafPending = false;
        const row = _pendingRow;
        if (row && row !== _lastDropRow) {
          clearDropHighlight();
          if (_bmFolderDragId) {
            // Folder-drag: highlight as drop-into target
            if (row !== document.querySelector('.bm-tree-row.bm-folder-dragging')) {
              row.classList.add('bm-folder-drop-into');
              _lastDropRow = row;
            }
          } else if (_rowNodeMap.has(row)) {
            // Bookmark-item drag: existing highlight
            row.classList.add('bm-drop-target');
            _lastDropRow = row;
          }
        }
      });
    }
  });

  pane.addEventListener('dragleave', ev => {
    if (_lastDropRow && !pane.contains(ev.relatedTarget)) {
      clearDropHighlight();
    } else if (_lastDropRow && ev.target === _lastDropRow && !_lastDropRow.contains(ev.relatedTarget)) {
      clearDropHighlight();
    }
  });

  pane.addEventListener('drop', async ev => {
    ev.preventDefault();
    const row = ev.target.closest('.bm-tree-row');
    const targetNode = row ? _rowNodeMap.get(row) : undefined;
    clearDropHighlight();

    // ── Folder drag: move folder into target folder ──────────────────────────
    if (_bmFolderDragId) {
      const folderId = _bmFolderDragId;
      _bmFolderDragId = null;
      if (!row) return; // dropped on no target
      // Resolve target: use _rowNodeMap if available, or data attribute
      let parentId;
      if (targetNode !== undefined) {
        parentId = targetNode ? targetNode.id : '1'; // null targetNode = root
      } else {
        // targetNode not in map (could be root row)
        parentId = row.dataset.folderId || '1';
      }
      if (parentId === folderId) return; // can't move into itself
      const r = await send('MOVE_BOOKMARK', { id: folderId, parentId });
      if (r?.error) toast(r.error, 'err');
      else { toast('Folder moved', 'ok'); await reloadBookmarksKeepState(); }
      return;
    }

    // ── Bookmark-item drag: existing logic ───────────────────────────────────
    if (!_bmDragId || targetNode === undefined) return;
    const dragId = _bmDragId;
    _bmDragId = null;
    const parentId = targetNode ? targetNode.id : '1';
    const r = await send('MOVE_BOOKMARK', { id: dragId, parentId });
    if (r?.error) toast(r.error, 'err');
    else { toast('Bookmark moved', 'ok'); await reloadBookmarksKeepState(); }
  });

  // Register a row as a drop target (just records it in the map)
  function makeDropTarget(row, targetNode) {
    _rowNodeMap.set(row, targetNode);
  }

  // Folder right-click context menu
  function addFolderCtx(row, n) {
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault(); ev.stopPropagation();
      showBmFolderCtxMenu(ev.clientX, ev.clientY, n);
    });
  }

  makeDropTarget(rootRow, null);

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

      // Drop target (for bookmark items dragged from right pane)
      makeDropTarget(row, n);

      // ── Folder drag-and-drop (move folder into another folder) ──────────────
      row.draggable = true;
      row.dataset.folderId = n.id;

      row.addEventListener('dragstart', ev => {
        // Don't interfere with bookmark-item drags
        if (_bmDragId) { ev.preventDefault(); return; }
        _bmFolderDragId = n.id;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', 'folder:' + n.id);
        setTimeout(() => {
          row.classList.add('bm-folder-dragging');
          // Canvas snapshot of the bookmarks list (right pane) — same as bookmark-item drag
          _bmSnapshotCanvas(document.getElementById('bookmarksContent'));
        }, 0);
      });

      row.addEventListener('dragend', () => {
        _bmFolderDragId = null;
        document.querySelectorAll('.bm-folder-dragging,.bm-folder-drop-into,.bm-folder-drop-above,.bm-folder-drop-below')
          .forEach(el => el.classList.remove('bm-folder-dragging','bm-folder-drop-into','bm-folder-drop-above','bm-folder-drop-below'));
        _bmTeardownCanvas(document.getElementById('bookmarksContent'));
      });
      // ────────────────────────────────────────────────────────────────────────

      pane.appendChild(row);

      if (hasSubFolders && n._expanded) {
        walkFolders(n.children, depth + 1);
      }
    }
  }

  walkFolders(bmRootChildren(), 0);
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
function _bmSnapshotCanvas(itemsPane) {
  if (itemsPane._dragCanvas) return; // already live
  const W = itemsPane.clientWidth, H = itemsPane.clientHeight;
  const dpr = devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width  = W * dpr; canvas.height = H * dpr;
  canvas.style.cssText = `position:absolute;inset:0;width:${W}px;height:${H}px;pointer-events:none;z-index:222;display:block`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const cs      = getComputedStyle(document.documentElement);
  const bgColor = cs.getPropertyValue('--surf0').trim()  || '#18181f';
  const textCol = cs.getPropertyValue('--text').trim()   || '#f0eee8';
  const sepCol  = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.08)';
  const text3   = cs.getPropertyValue('--text3').trim()  || '#5a5870';
  const accentC = cs.getPropertyValue('--accent').trim() || '#3b9eff';
  ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H);
  const scrollTop = itemsPane.scrollTop;
  const paneRect  = itemsPane.getBoundingClientRect();
  const rows = Array.from(itemsPane.querySelectorAll('.bm-item'));
  ctx.font = `13px system-ui,-apple-system,'Segoe UI',sans-serif`;
  ctx.textBaseline = 'middle';
  rows.forEach(r => {
    const rRect = r.getBoundingClientRect();
    const y = rRect.top - paneRect.top;
    const rowH = rRect.height || 34;
    if (y + rowH < 0 || y > H) return;
    const isChecked = r.classList.contains('bm-checked');
    ctx.fillStyle = isChecked ? `color-mix(in srgb, ${accentC} 8%, ${bgColor})` : bgColor;
    ctx.fillRect(0, y, W, rowH);
    // checkbox circle
    if (_bmSelMode) {
      ctx.beginPath(); ctx.arc(22, y + rowH / 2, 7, 0, Math.PI * 2);
      if (isChecked) { ctx.fillStyle = accentC; ctx.fill(); ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.fillText('✓', 18, y + rowH / 2 + 1); ctx.font = `13px system-ui,-apple-system,'Segoe UI',sans-serif`; }
      else { ctx.strokeStyle = text3; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
    const favX = _bmSelMode ? 38 : 32;
    const img = r.querySelector('img');
    if (img && img.complete && img.naturalWidth > 0) {
      try { ctx.globalAlpha = 0.8; ctx.drawImage(img, favX, y + (rowH - 15) / 2, 15, 15); ctx.globalAlpha = 1; } catch {}
    } else {
      ctx.fillStyle = text3; ctx.beginPath(); ctx.arc(favX + 7, y + rowH / 2, 5, 0, Math.PI * 2); ctx.fill();
    }
    const titleEl = r.querySelector('.bm-title');
    if (titleEl) { ctx.fillStyle = textCol; ctx.fillText(titleEl.textContent, favX + 22, y + rowH / 2, W - favX - 30); }
    ctx.fillStyle = sepCol; ctx.fillRect(0, y + rowH - 1, W, 1);
  });
  itemsPane.style.position = 'relative';
  itemsPane._dragScrollTop = scrollTop;
  // Zero the spacer height before moving to fragment — avoids phantom empty
  // space being restored on dragend (spacer height is stale after full render)
  const spacer = itemsPane.querySelector('.bm-spacer');
  if (spacer) spacer.style.height = '0';
  const frag = document.createDocumentFragment();
  while (itemsPane.firstChild) frag.appendChild(itemsPane.firstChild);
  itemsPane._dragFragment = frag;
  itemsPane._dragCanvas   = canvas;
  itemsPane.appendChild(canvas);
}

function _bmTeardownCanvas(itemsPane) {
  if (!itemsPane || !itemsPane._dragCanvas) return;
  itemsPane._dragCanvas.remove();
  itemsPane._dragCanvas = null;
  const savedScroll = itemsPane._dragScrollTop || 0;
  itemsPane.appendChild(itemsPane._dragFragment);
  itemsPane._dragFragment = null;
  itemsPane._dragScrollTop = null;
  itemsPane.style.position = '';
  itemsPane.scrollTop = savedScroll;
}

function _updateBmSelBar() {
  const bar     = document.getElementById('bmSelBar');
  const toolbar = document.getElementById('bmToolbar');
  const count   = document.getElementById('bmSelCount');
  if (bar)     bar.style.display     = _bmSelMode ? 'flex' : 'none';
  if (toolbar) toolbar.style.display = _bmSelMode ? 'none' : 'flex';
  if (count) count.textContent = `${_bmSelected.size} selected`;
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
  if (_bmSelected.size === 0) _exitBmSelMode();
  else _updateBmSelBar();
}

// Build a single bookmark row DOM element (shared by both render paths)
function _buildBmRow(n) {
  const dom = tryDomain(n.url || '');
  const row = document.createElement('div');
  row.className = 'bm-item';
  row.dataset.url = n.url;
  row.dataset.bmId = n.id;
  row.draggable = true;
  row.style.userSelect = 'none';

  const check = document.createElement('span');
  check.className = 'bm-item-check';
  check.textContent = '✓';

  const handle = document.createElement('span');
  handle.className = 'bm-drag-handle';
  handle.title = 'Drag to move to folder';
  handle.textContent = '⠿';

  const fav = document.createElement('img');
  fav.className = 'bm-fav';
  fav.src = favUrl(dom);
  fav.loading = 'lazy';
  fav.addEventListener('error', function(){ this.style.opacity='0'; });

  const title = document.createElement('div');
  title.className = 'bm-title';
  title.textContent = n.title || n.url;

  // Secondary label — folder name during search, date added otherwise
  const folderLabel = document.createElement('span');
  folderLabel.className = 'bm-folder-label';
  if (_bmIsSearch) {
    // Show parent folder name (skip top-level Chrome root folders)
    const parentNode = n.parentId ? _bmNodeMap.get(n.parentId) : null;
    const isTopLevelRoot = !parentNode || parentNode.parentId === '0' || !parentNode.parentId;
    const folderName = (!isTopLevelRoot && parentNode) ? (parentNode.title || '') : '';
    folderLabel.textContent = folderName;
    folderLabel.style.display = folderName ? '' : 'none';
  } else {
    // Show date added
    const dateText = n.dateAdded
      ? new Date(n.dateAdded).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    folderLabel.textContent = dateText;
    folderLabel.style.display = dateText ? '' : 'none';
  }

  row.appendChild(check);
  row.appendChild(handle);
  row.appendChild(fav);
  row.appendChild(title);
  row.appendChild(folderLabel);

  // Long-press (150ms) enters selection mode. If the user starts dragging before
  // the timer fires, the drag takes priority and selection mode is NOT entered.
  let _lpTimer = null;
  let _lpDragging = false;
  let _lpJustSelected = false; // swallow the click that fires right after long-press
  let _lpStartX = 0, _lpStartY = 0;
  row.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    _lpDragging = false;
    _lpJustSelected = false;
    _lpStartX = ev.clientX; _lpStartY = ev.clientY;
    _lpTimer = setTimeout(() => {
      _lpTimer = null;
      if (_lpDragging) return;
      _lpJustSelected = true;
      if (!_bmSelMode) _enterBmSelMode(n.id);
      else _toggleBmItem(n.id, row);
      row.classList.toggle('bm-checked', _bmSelected.has(n.id));
    }, 150);
  });
  row.addEventListener('pointermove', ev => {
    // Only cancel if moved more than 5px (avoids cancelling on tiny jitter)
    if (_lpTimer) {
      const dx = ev.clientX - _lpStartX, dy = ev.clientY - _lpStartY;
      if (dx * dx + dy * dy > 25) { clearTimeout(_lpTimer); _lpTimer = null; }
    }
  });
  row.addEventListener('pointerup',    () => { clearTimeout(_lpTimer); _lpTimer = null; });
  row.addEventListener('pointercancel',() => { clearTimeout(_lpTimer); _lpTimer = null; _lpJustSelected = false; });

  // Click: select if in sel mode, else open
  row.addEventListener('click', ev => {
    if (_lpJustSelected) { _lpJustSelected = false; return; } // swallow post-long-press click
    if (_bmSelMode) {
      ev.preventDefault();
      _toggleBmItem(n.id, row);
      row.classList.toggle('bm-checked', _bmSelected.has(n.id));
    } else {
      // Open in background tab — keep focus on extension page
      chrome.tabs.create({ url: n.url, active: false });
    }
  });

  row.addEventListener('contextmenu', ev => {
    ev.preventDefault(); ev.stopPropagation();
    if (_bmSelMode) return; // suppress ctx menu in sel mode
    showCtxMenu(ev.clientX, ev.clientY, { url: n.url, title: n.title, bmId: n.id });
  });

  // Drag-to-folder (only when NOT in sel mode)
  row.addEventListener('dragstart', ev => {
    if (_bmSelMode) { ev.preventDefault(); return; }
    // Cancel any pending long-press — user is dragging, not holding to select
    _lpDragging = true;
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    _bmDragId = n.id;
    window._bmReorderSetDrag && window._bmReorderSetDrag(n.id);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', n.id);
    setTimeout(() => {
      row.classList.add('bm-dragging');
      document.getElementById('panel-bookmarks')?.classList.add('bm-dragging-active');
      _bmSnapshotCanvas(document.getElementById('bookmarksContent'));
    }, 0);
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('bm-dragging');
    _bmDragId = null;
    window._bmReorderClearDrag && window._bmReorderClearDrag();
    document.getElementById('panel-bookmarks')?.classList.remove('bm-dragging-active');
    document.querySelectorAll('.bm-drop-target').forEach(el => el.classList.remove('bm-drop-target'));
    _bmTeardownCanvas(document.getElementById('bookmarksContent'));
  });

  return row;
}

// Append next batch of _bmItems — called repeatedly via setTimeout until done
function _bmAppendPage() {
  if (_bmOffset >= _bmItems.length) return;
  const pane = document.getElementById('bookmarksContent');
  if (!pane) return;
  const slice = _bmItems.slice(_bmOffset, _bmOffset + BM_PAGE);
  const frag = document.createDocumentFragment();
  for (const n of slice) frag.appendChild(_buildBmRow(n));
  // Insert before spacer so total scrollHeight stays stable
  const spacer = pane.querySelector('.bm-spacer');
  if (spacer) pane.insertBefore(frag, spacer);
  else pane.appendChild(frag);
  _bmOffset += slice.length;
  // Shrink spacer to match remaining unrendered rows
  if (spacer) spacer.style.height = Math.max(0, (_bmItems.length - _bmOffset) * 34) + 'px';
  // Schedule next batch if more remain
  if (_bmOffset < _bmItems.length) setTimeout(_bmAppendPage, 0);
}

function _bmInitList(items) {
  // Exit select mode when navigating to a different folder
  if (_bmSelMode) _exitBmSelMode();
  const pane = document.getElementById('bookmarksContent');
  pane.innerHTML = '';
  pane.onscroll = null;
  pane.scrollTop = 0;
  _bmItems = items;
  _bmOffset = 0;

  if (!items.length) {
    pane.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔖</span>No bookmarks here</div>';
    return;
  }

  // Pre-size with a spacer so scrollbar thumb stays constant during batch rendering
  const spacer = document.createElement('div');
  spacer.className = 'bm-spacer';
  spacer.style.height = (items.length * 34) + 'px';
  spacer.style.pointerEvents = 'none';
  pane.appendChild(spacer);

  // Render first batch immediately, rest async
  _bmAppendPage();
}

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

// Search: flat list across all bookmarks — uses precomputed _bmFlat index for speed
function renderBookmarksWithFilter(query) {
  const q = query.trim().toLowerCase();
  if (!_bmTree) return;
  if (!q) { _bmIsSearch = false; renderBmItems(_bmActiveNode); return; }

  // Multi-word: every word must appear in title, url, or folder name
  const words = q.split(/\s+/).filter(Boolean);
  const results = _bmFlat.filter(({ _title, _url, _folder }) =>
    words.every(w => _title.includes(w) || _url.includes(w) || _folder.includes(w))
  ).map(e => e.node);

  const pane = document.getElementById('bookmarksContent');
  if (!results.length) {
    _bmItems  = [];
    _bmOffset = 0;
    _bmIsSearch = true;
    pane.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔖</span>No matching bookmarks</div>';
    return;
  }

  _bmIsSearch = true;

  // Render synchronously — search result sets are small, no need for batched pagination
  if (_bmSelMode) _exitBmSelMode();
  _bmItems  = results;
  _bmOffset = results.length;
  pane.onscroll  = null;
  pane.scrollTop = 0;

  const frag = document.createDocumentFragment();
  for (const n of results) frag.appendChild(_buildBmRow(n));
  pane.innerHTML = '';
  pane.appendChild(frag);
}
// ── Bookmark multiselect bar buttons ────────────────────────────────────────
document.getElementById('bmSelModeBtn')?.addEventListener('click', () => {
  if (_bmSelMode) _exitBmSelMode();
  else _enterBmSelMode(null);
});

document.getElementById('bmSelCancelBtn')?.addEventListener('click', () => _exitBmSelMode());

document.getElementById('bmSelCopyBtn')?.addEventListener('click', async () => {
  if (!_bmSelected.size) return;
  // Collect URLs preserving order from _bmItems (covers both rendered and virtual-scroll items)
  const urls = [];
  const seen = new Set();
  for (const item of _bmItems) {
    if (_bmSelected.has(item.id) && item.url && !seen.has(item.id)) {
      urls.push(item.url);
      seen.add(item.id);
    }
  }
  // Fallback: pick up any rendered rows whose IDs weren't in _bmItems
  document.querySelectorAll('#bookmarksContent .bm-item').forEach(r => {
    if (_bmSelected.has(r.dataset.bmId) && r.dataset.url && !seen.has(r.dataset.bmId)) {
      urls.push(r.dataset.url);
      seen.add(r.dataset.bmId);
    }
  });
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
  function walk(nodes, depth) {
    let s = '';
    for (const n of nodes) {
      if (n.url) {
        s += `${'    '.repeat(depth)}<DT><A HREF="${esc(n.url)}" ADD_DATE="${Math.floor((n.dateAdded||Date.now())/1000)}">${esc(n.title||n.url)}</A>\n`;
      } else if (n.children) {
        if (!n.title && depth === 0) { s += walk(n.children, depth); continue; }
        s += `${'    '.repeat(depth)}<DT><H3>${esc(n.title||'')}</H3>\n`;
        s += `${'    '.repeat(depth)}<DL><p>\n`;
        s += walk(n.children, depth + 1);
        s += `${'    '.repeat(depth)}</DL><p>\n`;
      }
    }
    return s;
  }
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<!-- Exported by Extended History -->\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${walk(tree, 1)}</DL><p>`;
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
    const bookmarks = parseNetscapeBookmarks(text);
    if (!bookmarks.length) { toast('No bookmarks found in file', 'err'); return; }
    const r = await send('IMPORT_BOOKMARKS', { bookmarks });
    toast(`Imported ${fmtNum(r.imported)} bookmarks`, 'ok');
    loadBookmarks();
    ev.target.value = '';
  } catch (err) { toast(err.message, 'err'); }
});

function parseNetscapeBookmarks(html) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(html, 'text/html');
  const links  = doc.querySelectorAll('a');
  const result = [];
  links.forEach(a => {
    if (a.href) result.push({ title: a.textContent.trim(), url: a.href });
  });
  return result;
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
  if (popupSearchToggle) popupSearchToggle.checked = s.popupShowSearch !== false;
  if (popupTabsToggle)   popupTabsToggle.checked   = s.popupShowTabs   !== false;
  if (popupURLsToggle)   popupURLsToggle.checked   = s.popupShowUrl   !== false;
  if (popupHeightInput)  popupHeightInput.value     = s.popupHeight     || 320;

  // Populate UI settings
  const faviconSel = document.getElementById('faviconResolverSel');
  if (faviconSel) faviconSel.value = s.faviconResolver || 'google';
  const autoFocusTgl = document.getElementById('searchAutoFocusToggle');
  if (autoFocusTgl) autoFocusTgl.checked = s.searchAutoFocus !== false;

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

function applyVisuals(s) {
  const r = document.documentElement;
  if (s.accentColor)  r.style.setProperty('--accent',  s.accentColor);
  if (s.accentColor2) r.style.setProperty('--accent2', s.accentColor2);
  if (s.fontSize)     r.style.setProperty('--fsize',   s.fontSize + 'px');
  if (s.font)         r.style.setProperty('--font',    s.font);
  if (s.theme)        setTheme(s.theme);
  
  // Apply background tint: hue-rotate filter on the wallpaper layer
  const wpLayer = document.getElementById('eh-wallpaper-layer');
  if (s.bgTintEnabled && s.bgTintHue !== undefined) {
    const blurAmt = s.blurAmount ?? s.bgTintBlur ?? 8;
    const hueRot  = s.bgTintHue;
    if (wpLayer) {
      wpLayer.style.filter = `blur(${blurAmt}px) hue-rotate(${hueRot}deg)`;
    }
    r.style.setProperty('--bg-tint-hue', hueRot + 'deg');
  } else {
    if (wpLayer) {
      const blurAmt = s.blurAmount ?? 8;
      wpLayer.style.filter = `blur(${blurAmt}px)`;
    }
    r.style.removeProperty('--bg-tint-hue');
  }
}
// ── Storage backend migration ─────────────────────────────────────────────────
async function loadStorageBackend() {
  try {
    const r = await send('GET_STORAGE_BACKEND');
    const backend = r.backend || 'local';
    const sel = document.getElementById('storageBackendSel');
    const lbl = document.getElementById('storageBackendLabel');
    if (sel) sel.value = backend;
    if (lbl) lbl.textContent = backend === 'idb' ? 'IndexedDB' : 'Local Storage';
  } catch {}
}

async function migrateStorage() {
  const sel    = document.getElementById('storageBackendSel');
  const status = document.getElementById('migrateStorageStatus');
  const btn    = document.getElementById('migrateStorageBtn');
  const lbl    = document.getElementById('storageBackendLabel');
  if (!sel) return;

  const target = sel.value;
  const current = lbl?.textContent;
  const currentBackend = current?.includes('IndexedDB') ? 'idb' : 'local';

  if (target === currentBackend) {
    toast('Already using ' + (target === 'idb' ? 'IndexedDB' : 'Local Storage'), 'ok');
    return;
  }

  if (!confirm(
    target === 'idb'
      ? 'Migrate history to IndexedDB? This may take a moment for large histories.'
      : 'Migrate history back to Local Storage? This may take a moment for large histories.'
  )) return;

  btn.disabled = true;
  btn.textContent = 'Migrating…';
  if (status) status.textContent = 'Please wait…';

  try {
    const type = target === 'idb' ? 'MIGRATE_TO_IDB' : 'MIGRATE_TO_LOCAL';
    const r = await send(type);
    if (r.error) throw new Error(r.error);
    if (lbl) lbl.textContent = target === 'idb' ? 'IndexedDB' : 'Local Storage';
    if (status) status.textContent = `✓ Migrated ${fmtNum(r.migrated)} entries`;
    toast(`Migrated to ${target === 'idb' ? 'IndexedDB' : 'Local Storage'}`, 'ok');
  } catch(err) {
    if (status) status.textContent = '✗ Migration failed: ' + err.message;
    toast('Migration failed: ' + err.message, 'err');
    // Revert select to current
    if (sel) sel.value = currentBackend;
  }

  btn.disabled = false;
  btn.textContent = 'Apply & Migrate';
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const days    = parseInt(document.getElementById('retDays').value);
  const c1      = document.getElementById('cp1').value;
  const c2      = document.getElementById('cp2').value;
  const font    = document.getElementById('fontSel').value;
  const sz      = parseInt(document.getElementById('fontSzInput').value);
  const maxSess = parseInt(document.getElementById('maxSessionsInput')?.value || '4');
  const lang    = document.getElementById('languageSelect')?.value || window._currentLang || 'en';
  const bgTintEnabled = document.getElementById('bgTintToggle')?.checked || false;
  const bgTintHue = parseInt(document.getElementById('bgTintHue')?.value || '220');
  const bgTintOpacity = parseInt(document.getElementById('bgTintOpacity')?.value || '8');
  const popupShowSearch = document.getElementById('popupSearchToggle')?.checked !== false;
  const popupShowTabs   = document.getElementById('popupTabsToggle')?.checked   !== false;
  const popupShowUrl   = document.getElementById('popupURLsToggle')?.checked   !== false;
  const popupHeight     = parseInt(document.getElementById('popupHeightInput')?.value || '320');
  const faviconResolver = document.getElementById('faviconResolverSel')?.value || 'google';
  const searchAutoFocus = document.getElementById('searchAutoFocusToggle')?.checked !== false;
  
  if (!days || days < 1) { toast('Invalid retention', 'err'); return; }
  try {
    const r = await send('SAVE_SETTINGS', { 
      settings: { 
        retentionDays: days, 
        accentColor: c1, 
        accentColor2: c2, 
        font, 
        fontSize: sz, 
        theme: _curSettings.theme || 'dark',
        language: lang,
        bgTintEnabled,
        bgTintHue,
        bgTintOpacity,
        popupShowSearch,
        popupShowTabs,
        popupShowUrl,
        popupHeight,
        faviconResolver,
        searchAutoFocus,
        timeTrackingEnabled: document.getElementById('timeTrackingToggle')?.checked !== false,
        syncInterval: Math.max(1, Math.min(1440, parseInt(document.getElementById('syncIntervalInput')?.value || '30') || 30)),
        autoStoreEnabled: document.getElementById('autoStoreToggle')?.checked === true,
        autoStoreHours: Math.max(1, Math.min(168, parseInt(document.getElementById('autoStoreHoursInput')?.value || '6') || 6))
      } 
    });
    _curSettings = r.settings;
    // Save max sessions separately
    if (maxSess >= 1 && maxSess <= 20) await send('SET_MAX_SESSIONS', { value: maxSess });
    // Save auto-save interval
    const autoSaveMins = parseInt(document.getElementById('autoSaveInput')?.value || '0');
    await send('SET_AUTO_SAVE_INTERVAL', { minutes: autoSaveMins });
    toast('Settings saved', 'ok');
  } catch (err) { toast(err.message, 'err'); }
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

// SW sends the session HTML — use anchor click (bypasses browser "ask where to save")
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'AUTO_SAVE_DOWNLOAD') return;
  const blob = new Blob([msg.html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: msg.filename || 'extended-history-session.html', target:"_blank",
  });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
});

document.getElementById('exportDataBtn').addEventListener('click', async () => {
  try {
    const data = await send('EXPORT');
    const useEncrypt = confirm('Encrypt export with a password?\n\nClick OK to encrypt, Cancel to export as plain JSON.');
    let blob, filename;
    if (useEncrypt) {
      const pw = prompt('Enter encryption password:');
      if (!pw) { toast('Export cancelled', 'err'); return; }
      const pw2 = prompt('Confirm password:');
      if (pw !== pw2) { toast('Passwords do not match', 'err'); return; }
      const encrypted = await ehEncrypt(JSON.stringify(data), pw);
      blob = new Blob([JSON.stringify({ __eh_encrypted: true, ...encrypted })], { type: 'application/json' });
      filename = `extended-history_${new Date().toISOString().slice(0,10)}_enc.json`;
      toast(`Exported ${fmtNum(data.totalEntries)} entries (encrypted)`, 'ok');
    } else {
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      filename = `extended-history_${new Date().toISOString().slice(0,10)}.json`;
      toast(`Exported ${fmtNum(data.totalEntries)} entries`, 'ok');
    }
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename }).click();
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('importDataBtn')?.addEventListener('click', () => {
  document.getElementById('importDataFile')?.click();
});
document.getElementById('importDataFile')?.addEventListener('change', async ev => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    let data = raw;
    if (raw.__eh_encrypted) {
      const pw = prompt('This file is encrypted. Enter the password to decrypt:');
      if (!pw) { toast('Import cancelled', 'err'); ev.target.value = ''; return; }
      try {
        const decrypted = await ehDecrypt(raw, pw);
        data = JSON.parse(decrypted);
      } catch {
        toast('Wrong password or corrupted file', 'err');
        ev.target.value = '';
        return;
      }
    }
    const entries = data.entries || (Array.isArray(data) ? data : null);
    if (!entries) { toast('Invalid file format', 'err'); return; }
    const r = await send('IMPORT_HISTORY', { entries });
    toast(`Imported ${fmtNum(r.imported)} new entries`, 'ok');
    doSearch();
    ev.target.value = '';
  } catch (err) { toast(err.message || 'Import failed', 'err'); }
});

document.getElementById('reBackfillBtn')?.addEventListener('click', async () => {
  if (!confirm('Re-import all available Chrome native history? New entries will be merged in.')) return;
  toast('Importing from Chrome history…');
  try {
    const r = await send('RE_BACKFILL');
    if (r?.error) { toast(r.error, 'err'); return; }
    toast(`Imported ${fmtNum(r.imported)} new entries from Chrome history`, 'ok');
    doSearch();
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL history permanently? Cannot be undone.')) return;
  try {
    await send('CLEAR_ALL');
    allResults = []; exitSelMode(); buildVirtualList();
    toast('All history cleared', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('clearTimeBtn')?.addEventListener('click', async () => {
  if (!confirm('Clear all time-spent data? This will not affect history. Cannot be undone.')) return;
  try {
    await send('CLEAR_TIME_DATA');
    toast('Time data cleared', 'ok');
    loadTimeSpent(curTimeDays || 15);
  } catch (err) { toast(err.message, 'err'); }
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
  const bmRemove   = document.getElementById('ctx-remove-bookmark');
  const bmRemoveSep= document.getElementById('ctx-bm-remove-sep');
  const hasId   = !!entry.id;
  const hasDate = !!entry.visitTime;
  const hasBmId = !!entry.bmId;
  if (delEl)        delEl.style.display        = hasId   ? '' : 'none';
  if (delSep)       delSep.style.display       = hasId   ? '' : 'none';
  if (jumpEl)       jumpEl.style.display       = hasDate ? '' : 'none';
  if (jumpSep)      jumpSep.style.display      = hasDate ? '' : 'none';
  if (bmRemove)     bmRemove.style.display     = hasBmId ? '' : 'none';
  if (bmRemoveSep)  bmRemoveSep.style.display  = hasBmId ? '' : 'none';
  menu.style.display = 'block';
  const mw = 210, mh = 240;
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
  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    let data = raw;

    // Auto-detect encrypted export
    if (raw.__eh_encrypted) {
      const pw = prompt('This file is encrypted. Enter the password to decrypt:');
      if (!pw) { toast('Cancelled', 'err'); return; }
      try {
        const decrypted = await ehDecrypt(raw, pw);
        data = JSON.parse(decrypted);
      } catch {
        toast('Wrong password or corrupted file', 'err');
        return;
      }
    }

    // Support both raw array and {entries:[...]} exports
    const entries = Array.isArray(data) ? data : (data.entries || []);
    if (!entries.length) { toast('No entries found in file', 'err'); return; }

    _rmEntries = entries.sort((a, b) => b.visitTime - a.visitTime);
    _rmFilterDate = null;
    _rmSearchVal  = '';

    document.getElementById('rm-filename').textContent   = file.name;
    document.getElementById('rm-entrycount').textContent = `${fmtNum(_rmEntries.length)} entries`;
    document.getElementById('rm-dropzone').style.display = 'none';
    document.getElementById('rm-reader').style.display   = 'flex';    document.getElementById('rmSearchInput').value = '';
    document.getElementById('rmSearchClearBtn')?.classList.remove('visible');

    rmBuildDateNav();
    rmDoFilter();
  } catch (err) {
    toast('Could not read file: ' + err.message, 'err');
  }
}

function rmUnload() {
  _rmEntries = []; _rmFiltered = []; _rmFilterDate = null; _rmSearchVal = '';
  document.getElementById('rm-dropzone').style.display = 'flex';
  document.getElementById('rm-reader').style.display   = 'none';
  document.getElementById('rmDateScroll').innerHTML    = '';
  if (rmListArea()) rmListArea().innerHTML             = '';
}

// ── Date nav ─────────────────────────────────────────────────────────────────
function rmBuildDateNav() {
  const scroll = document.getElementById('rmDateScroll');
  scroll.innerHTML = '';

  // "All" is a static pill in HTML (outside the scroll), just wire it once
  const allPill = document.getElementById('rmAllPill');
  if (allPill) {
    // Replace listener by cloning to avoid duplicates on reload
    const fresh = allPill.cloneNode(true);
    allPill.parentNode.replaceChild(fresh, allPill);
    fresh.addEventListener('click', () => rmActivateDatePill('all'));
  }

  // Collect unique dates in the file, newest first — no "All" in scroll
  const dateSet = new Set(_rmEntries.map(e => new Date(e.visitTime).toLocaleDateString('en-CA')));
  const dates   = [...dateSet].sort((a, b) => b.localeCompare(a));

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (const key of dates) {
    const d   = new Date(key + 'T12:00:00');
    const lbl = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const sub = DAYS[d.getDay()];
    const b = document.createElement('button');
    b.className = 'dn-pill';
    b.dataset.date = key;
    b.innerHTML = `<span class="dn-pill-label">${esc(lbl)}</span><span class="dn-pill-day">${esc(sub)}</span>`;
    b.addEventListener('click', () => rmActivateDatePill(key));
    scroll.appendChild(b);
  }

  rmActivateDatePill('all', true);

  // Arrow hold-scroll
  (function() {
    const wrap = document.getElementById('rmDateScrollWrap');
    let _t = null, _i = null;
    function startH(dir) { stopH(); wrap.scrollBy({left:dir*220,behavior:'smooth'}); _t=setTimeout(()=>{_i=setInterval(()=>wrap.scrollBy({left:dir*120}),80);},400); }
    function stopH()  { clearTimeout(_t); clearInterval(_i); _t=_i=null; }
    const L = document.getElementById('rmDnLeft');
    const R = document.getElementById('rmDnRight');
    L.addEventListener('mousedown',()=>startH(-1)); R.addEventListener('mousedown',()=>startH(1));
    ['mouseup','mouseleave'].forEach(ev=>{L.addEventListener(ev,stopH);R.addEventListener(ev,stopH);});
  })();
}

function rmActivateDatePill(key, silent) {
  _rmFilterDate = key === 'all' ? null : key;
  const fromEl = document.getElementById('rmDateFrom');
  const toEl   = document.getElementById('rmDateTo');
  if (fromEl) fromEl.value = _rmFilterDate || '';
  if (toEl)   toEl.value   = _rmFilterDate || '';
  // Clear scroll pills + external All pill
  document.querySelectorAll('#rmDateScroll .dn-pill').forEach(b => b.classList.remove('active'));
  const rmAllPill = document.getElementById('rmAllPill');
  if (rmAllPill) rmAllPill.classList.remove('active');

  if (key === 'all') {
    if (rmAllPill) rmAllPill.classList.add('active');
  } else {
    const t = document.querySelector(`#rmDateScroll .dn-pill[data-date="${key}"]`);
    if (t) {
      t.classList.add('active');
      if (!silent) {
        const wrap = document.getElementById('rmDateScrollWrap');
        const allPills = Array.from(document.querySelectorAll('#rmDateScroll .dn-pill'));
        const idx = allPills.indexOf(t);
        const pillsBack = wrap.offsetWidth < 700 ? 2 : 6;
        const precedingPills = allPills.slice(Math.max(0, idx - pillsBack), idx);
        const gap = 5;
        const offsetBefore = precedingPills.reduce((sum, p) => sum + p.offsetWidth + gap, 0);
        const pillLeft = t.getBoundingClientRect().left - wrap.getBoundingClientRect().left + wrap.scrollLeft;
        wrap.scrollTo({ left: pillLeft - offsetBefore, behavior: 'smooth' });
      }
    }
  }
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

  _rmFiltered = _rmEntries.filter(e => {
    if (_rmFilterDate) {
      const eDate = new Date(e.visitTime).toLocaleDateString('en-CA');
      if (eDate !== _rmFilterDate) return false;
    } else if (fromTs || toTs) {
      if (fromTs && e.visitTime < fromTs) return false;
      if (toTs   && e.visitTime > toTs)   return false;
    }
    if (words.length) {
      const dom = e.domain || tryDomain(e.url);
      let hay;
      if      (mode === 'title')  hay = (e.title || '').toLowerCase();
      else if (mode === 'url')    hay = (e.url   || '').toLowerCase();
      else if (mode === 'domain') hay = dom.toLowerCase();
      else                        hay = [e.url, e.title||'', dom].join(' ').toLowerCase();
      if (!words.every(w => hay.includes(w))) return false;
    }
    return true;
  });

  _rmVsOffset = 0; _rmVsLoading = false;
  const area = rmListArea();
  if (!_rmFiltered.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span>No entries found</div>`;
    return;
  }
  area.innerHTML = '';
  rmAppendPage();
  area.onscroll = () => {
    if (area.scrollTop + area.clientHeight >= area.scrollHeight - 400) rmAppendPage();
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
      hdr.innerHTML = `${esc(dl)}<span class="day-visits"></span>`;
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
    rmDoFilter();
  });
  document.getElementById('rmDateTo')?.addEventListener('change', () => {
    _rmFilterDate = null;
    document.querySelectorAll('#rmDateScroll .dn-pill').forEach(b => b.classList.remove('active'));
    document.getElementById('rmAllPill')?.classList.remove('active');
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
      title.textContent = '🔒 Set Up Ignore List';
      desc.textContent  = 'No password is set yet. Create a master password to protect your ignore list.';
      resetBtn.style.display = 'none';
      okBtn.textContent = 'Create Password';
    } else if (m === 'unlock') {
      title.textContent = '🔒 Ignore List Access';
      desc.textContent  = 'Enter your master password to view the ignore list.';
      resetBtn.style.display = '';
      okBtn.textContent = 'OK';
    } else if (m === 'reset-new') {
      title.textContent = '🔑 Reset Ignore List';
      desc.textContent  = 'Ignore list has been cleared. Enter a new master password to continue.';
      resetBtn.style.display = 'none';
      okBtn.textContent = 'Set New Password';
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
    if (!pw) { errEl.textContent = 'Please enter a password.'; errEl.style.display = ''; return; }

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
    if (!confirm('This will clear your entire ignore list and remove the password. Continue?')) return;
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
        <div class="panel-heading">🚫 Ignored Domains</div>
        <p style="color:var(--text2);font-size:0.9rem;margin-bottom:20px;line-height:1.5;max-width:600px">
          Domains added here will not be saved in history. Existing entries will be removed automatically.
          Words without a dot are treated as <strong>keywords</strong> — they match any URL or page title containing that word.
        </p>
        <div class="ignore-toggle-wrapper">
          <label class="toggle-switch">
            <input type="checkbox" id="ignoreListToggle" checked>
            <span class="toggle-slider"></span>
          </label>
          <label class="ignore-toggle-label" for="ignoreListToggle">
            <div class="ignore-toggle-text">
              <div class="ignore-toggle-title">Enable Ignore List</div>
              <div class="ignore-toggle-subtitle">Filter URLs matching patterns below</div>
            </div>
          </label>
        </div>
        <div class="ignore-add">
          <input type="text" id="ignorePatternInput" placeholder="example.com or keyword" spellcheck="false">
          <button id="addIgnoreBtn">Add Pattern</button>
        </div>
        <div class="pattern-guide-toggle">
          <button id="patternGuideToggle">▼ URL Pattern Guide</button>
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
  if (typeof window.applyTranslations === 'function' && window._currentLang) {
    window.applyTranslations(window._currentLang);
  }
}

function switchPanel(name) {
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

  // Ignorelist: show panel then overlay modal on top (modal is position:fixed)
  if (name === 'ignorelist') { handleIgnoreListAccess(); return; }

  if (name === 'activity')  loadActivity();
  if (name === 'timespent') loadTimeSpent(curTimeDays || 15);
  if (name === 'devices')    loadDevices();
  if (name === 'sessions')   loadSessions();
  if (name === 'tabstorage') loadTabStorage();
  if (name === 'bookmarks') loadBookmarks();
   if (name === 'mostvisited') loadMostVisited();
  if (name === 'settings') {
    send('GET_SETTINGS').then(s => { _curSettings = s; populateSettings(s); }).catch(() => {});
    send('GET_SESSIONS').then(r => {
      const el = document.getElementById('maxSessionsInput');
      if (el && r.maxSessions) el.value = r.maxSessions;
    }).catch(() => {});
    send('GET_AUTO_SAVE_INTERVAL').then(r => {
      const el = document.getElementById('autoSaveInput');
      if (el) el.value = r.minutes || 0;
    }).catch(() => {});
  }
}

// ══ DELETE HISTORY MODAL ═════════════════════════════════════════════════════
let _dhSelectedRange = null;

function rangeToTimes(range) {
  const now = Date.now();
  const map = {
    '1h':  [now - 3600000,       now],
    '24h': [now - 86400000,      now],
    '7d':  [now - 7*86400000,    now],
    '30d': [now - 30*86400000,   now],
    '5mo': [now - 150*86400000,  now],
    'all': [0,                   now],
  };
  return map[range] || null;
}

function openDeleteHistoryModal() {
  _dhSelectedRange = null;
  document.querySelectorAll('.dh-range-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('dhConfirmBtn').disabled = true;
  document.getElementById('dhCookies').checked = false;
  document.getElementById('dhCache').checked = false;
  document.getElementById('deleteHistoryModal').classList.add('open');
}
function closeDeleteHistoryModal() {
  document.getElementById('deleteHistoryModal').classList.remove('open');
  _dhSelectedRange = null;
  const confirmBtn = document.getElementById('dhConfirmBtn');
  if (confirmBtn) { delete confirmBtn.dataset.confirmed; confirmBtn.textContent = 'Delete'; confirmBtn.disabled = true; }
  const warn = document.getElementById('dhConfirmWarn');
  if (warn) warn.style.display = 'none';
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

  const overlayOpacity = (wp.overlayOpacity ?? 60) / 100;
  const blurAmount     = wp.blurAmount ?? 8;
  const isDark         = (root.getAttribute('data-theme') || 'dark') === 'dark';
  const overlayColor   = isDark
    ? `rgba(0,0,0,${overlayOpacity})`
    : `rgba(255,255,255,${overlayOpacity})`;

  // Background layer div (fixed, behind everything)
  const layer = document.createElement('div');
  layer.id = 'eh-wallpaper-layer';
  const hueRot = (_curSettings.bgTintEnabled && _curSettings.bgTintHue !== undefined)
    ? ` hue-rotate(${_curSettings.bgTintHue}deg)` : '';
  layer.style.cssText = `
    position:fixed;inset:0;z-index:-1;
    background:url(${wp.dataUrl}) center/cover no-repeat;
    filter:blur(${blurAmount}px)${hueRot};
    transform:scale(1.05);
    pointer-events:none;
  `;
  body.prepend(layer);

  // Overlay + glass CSS injection
  const style = document.createElement('style');
  style.id = 'eh-wallpaper-style';
  style.textContent = `
    html.wallpaper-mode body { background: transparent !important; }
    html.wallpaper-mode body::before {
      content:''; position:fixed; inset:0; z-index:0;
      background:${overlayColor};
      pointer-events:none;
    }
    html.wallpaper-mode .sidebar,
    html.wallpaper-mode .modal-box,
    html.wallpaper-mode .topbar,
    html.wallpaper-mode .s-card,
    html.wallpaper-mode .chart-card,
    html.wallpaper-mode .ctxMenu,
    html.wallpaper-mode .kpi-card,
    html.wallpaper-mode .entry,
    html.wallpaper-mode .modal-inner,
    html.wallpaper-mode .ignore-add,
    html.wallpaper-mode .panel-scroll,
    html.wallpaper-mode .ignore-item,
    html.wallpaper-mode .session-card,
    html.wallpaper-mode .device-card,
    html.wallpaper-mode .ts-card,
    html.wallpaper-mode .bm-item,
    html.wallpaper-mode .mv-item,
    html.wallpaper-mode .day-label, .bm-tree-pane, .bm-toolbar, .sel-bar.on{
      background: ${isDark ? 'rgba(19,19,24,0.55)' : 'rgba(255,255,255,0.55)'} !important;
      backdrop-filter: saturate(1.4) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.4) !important;
      border-color: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'} !important;
      color:var(--text2);
    }
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
    background: ${isDark ? 'rgba(19,19,24,0.55)' : 'rgba(255,255,255,0.55)'} !important;
    height:100%
    }
    html.wallpaper-mode .sidebar {
      background: ${isDark ? 'rgba(13,13,18,0.65)' : 'rgba(245,245,247,0.65)'} !important;
    }
    html.wallpaper-mode .topbar {
      background: ${isDark ? 'rgba(19,19,24,0.6)' : 'rgba(255,255,255,0.6)'} !important;
    }
    html.wallpaper-mode .action-btn,
    html.wallpaper-mode .dn-pill,
    html.wallpaper-mode .chip,
    html.wallpaper-mode .nav-item,
    html.wallpaper-mode .tf-btn {
      border-color: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'} !important;
  
    }
    html.wallpaper-mode #dnLeft,#dnRight,.dn-pill, .tb-btn, .hn-pill, .sa-btn, .action-btn, .tf-btn, .nav-arrow, #rmSearchMode, #rmDateFrom, #rmDateTo, #languageSelect{
      background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'} !important;
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
      background: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'};
      border-color: ${isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'} !important;
    }
    html.wallpaper-mode .panel { background: transparent !important; }
    html.wallpaper-mode .panel, html.wallpaper-mode #main { position: relative; z-index: 1; }
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

  if (!toggle) return;

  let _wpState = { enabled: false, dataUrl: null, overlayOpacity: 60, blurAmount: 8, source: 'custom' };

  // Load existing wallpaper state into UI
  chrome.storage.local.get(WP_STORAGE_KEY, r => {
    const wp = r[WP_STORAGE_KEY];
    if (wp) {
      _wpState = { ..._wpState, ...wp };
      toggle.checked = wp.enabled || false;
      overlaySlider.value = wp.overlayOpacity ?? 60;
      overlayVal.textContent = (wp.overlayOpacity ?? 60) + '%';
      blurSlider.value = wp.blurAmount ?? 8;
      blurVal.textContent = (wp.blurAmount ?? 8) + 'px';
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

  // Clear
  clearBtn?.addEventListener('click', async () => {
    if (!confirm('Remove the current wallpaper?')) return;
    _wpState = { enabled: false, dataUrl: null, overlayOpacity: 60, blurAmount: 8, source: 'custom' };
    toggle.checked = false;
    previewWrap.style.display    = 'none';
    document.getElementById('wpDropLabel').innerHTML = 'Drop image here or <strong>click to browse</strong>';
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
  document.getElementById('themeLight').addEventListener('click', () => setTheme('light'));
  document.getElementById('themeDark').addEventListener('click', () => setTheme('dark'));

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

  buildDateNav();
  buildHourNav();
  setupToolbar();
  setupSelActions();
  setupBgTintListeners();
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

  // Hash routing — only switch away from history if explicitly requested; clear hash so refresh = history
  const hash = location.hash.slice(1);
  if (hash && hash !== 'history' && ['sessions','readingmode','tabstorage','devices','activity','timespent','mostvisited','bookmarks','ignorelist','settings','about'].includes(hash)) {
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
      const rangeLabels = { '1h':'last 1 hour','24h':'last 24 hours','7d':'last 7 days','30d':'last 30 days','5mo':'last 5 months','all':'ALL TIME' };
      const label = rangeLabels[_dhSelectedRange] || _dhSelectedRange;
      const warn = document.getElementById('dhConfirmWarn');
      if (warn) { warn.textContent = `⚠ This will permanently delete history for the ${label}. Click Delete again to confirm.`; warn.style.display = 'block'; }
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
    btn.textContent = 'Deleting…';
    try {
      const r = await send('DELETE_HISTORY_RANGE', { startTime, endTime, clearCookies, clearCache });
      if (r?.error) { toast(r.error, 'err'); }
      else {
        toast(`Deleted ${fmtNum(r.deleted || 0)} history entries${clearCookies ? ' + cookies' : ''}${clearCache ? ' + cache' : ''}`, 'ok');
        allResults = allResults.filter(e => !(e.visitTime >= startTime && e.visitTime <= endTime));
        buildVirtualList();
      }
    } catch(err) { toast(err.message, 'err'); }
    btn.textContent = 'Delete';
    closeDeleteHistoryModal();
  });

});

// ══ LANGUAGE SUPPORT ════════════════════════════════════════════════════════
async function initLanguage() {
  try {
    //console.log('[EH] initLanguage: Loading settings...');
    const settings = await send('GET_SETTINGS');
    //console.log('[EH] initLanguage: Settings received:', settings);
    window._currentLang = settings.language || 'en';
    const langSelect = document.getElementById('languageSelect');
    if (langSelect) {
      langSelect.value = window._currentLang;
      //console.log('[EH] initLanguage: Language selector set to:', window._currentLang);
    } else {
      //console.warn('[EH] initLanguage: Language selector not found!');
    }
    
    // Apply translations to UI
    if (typeof window.applyTranslations === 'function') {
      window.applyTranslations(window._currentLang);
    }
  } catch (err) {
    //console.error('[EH] initLanguage: Failed to load language:', err);
    window._currentLang = 'en';
  }
}

document.getElementById('languageSelect')?.addEventListener('change', async (e) => {
  const newLang = e.target.value;
  //console.log('[EH] Language change requested:', newLang);
  try {
    // Update language in settings
    const result = await send('SAVE_SETTINGS', { settings: { language: newLang } });
    //console.log('[EH] Save result:', result);
    
    // Verify it was saved
    const verifySettings = await send('GET_SETTINGS');
    //console.log('[EH] Settings after save (verification):', verifySettings);
    
    window._currentLang = newLang;
    
    // Apply translations to UI immediately
    if (typeof window.applyTranslations === 'function') {
      window.applyTranslations(newLang);
    }
    
    // Get language name
    const langNames = {
      en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français',
      ru: 'Русский', zh: '中文', uk: 'Українська', tr: 'Türkçe',
      it: 'Italiano', hi: 'हिन्दी', no: 'Norsk', he: 'עברית'
    };
    
    toast(`Language changed to ${langNames[newLang] || newLang}`, 'ok');
  } catch (err) {
    //console.error('[EH] Language change failed:', err);
    toast('Error: ' + err.message, 'err');
  }
});

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
  const typeLabel = curMvType === 'url' ? chrome.i18n.getMessage("urls")  : chrome.i18n.getMessage("domains") ;
  const periodLabel = curMvPeriod === 'all' ? chrome.i18n.getMessage("all_time") : `${curMvPeriod} `+ chrome.i18n.getMessage("days");
  document.getElementById('mvChartTitle').textContent = chrome.i18n.getMessage("most_visited") +` ${typeLabel} — ${periodLabel}`;

  const el = document.getElementById('mvContent');
  el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">⏳</span><span data-i18n-key="loading">Loading…</span></div>';
  
  try {
    const data = await send('GET_MOST_VISITED', { viewType: curMvType, period: curMvPeriod });
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

// Call initLanguage after a short delay to ensure DOM is ready
setTimeout(initLanguage, 100);