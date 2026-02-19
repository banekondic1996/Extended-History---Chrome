/**
 * Extended History — history.js v3
 * Virtual scroll, click-to-open / checkbox-to-select, sessions, bookmarks,
 * dark/light mode, local fonts only.
 */

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

// ── Utils ──────────────────────────────────────────────────────────────────
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
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
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
    <img class="e-fav" src="${favUrl(dom)}" loading="lazy" onerror="this.style.opacity='0'"/>
    <div class="e-body">
    <div class="e-title">${esc(e.title || e.url)}</div>
    <div class="e-url">${esc(e.url)}</div>
    </div>
    <div class="e-time">${fmtTime(e.visitTime)}</div>
    <button class="e-del-btn" data-id="${esc(e.id)}" title="Delete">✕</button>`;

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

  addBtn('All time', 'all', '');
  for (let i = 0; i < 60; i++) {
    const d   = new Date(now - i * 86400000);
    const key = d.toLocaleDateString('en-CA');
    if (i === 0) { addBtn('Today',     key, ''); continue; }
    if (i === 1) { addBtn('Yesterday', key, ''); continue; }
    addBtn(d.toLocaleDateString(undefined, { month:'short', day:'numeric' }), key, DAYS[d.getDay()]);
  }

  document.getElementById('dnLeft').addEventListener('click', () => {
    document.getElementById('dateScrollWrap').scrollBy({ left: -240, behavior: 'smooth' });
  });
  document.getElementById('dnRight').addEventListener('click', () => {
    document.getElementById('dateScrollWrap').scrollBy({ left: 240, behavior: 'smooth' });
  });
}

function activateDatePill(key, silent) {
  filterHour = null;
  document.querySelectorAll('.hn-pill').forEach(b => b.classList.remove('active'));
  document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');

  filterDate = key === 'all' ? null : key;
  // Sync date inputs but never clear search text
  document.getElementById('dateFrom').value = filterDate || '';
  document.getElementById('dateTo').value   = filterDate || '';

  document.querySelectorAll('.dn-pill').forEach(b => b.classList.remove('active'));
  const t = document.querySelector(`.dn-pill[data-date="${key}"]`);
  if (t) {
    t.classList.add('active');
    if (!silent) {
      const wrap = document.getElementById('dateScrollWrap');
      wrap.scrollTo({ left: t.offsetLeft - wrap.offsetWidth / 2 + t.offsetWidth / 2, behavior: 'smooth' });
    }
  }
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
  document.getElementById('dateFrom').addEventListener('change', () => { filterDate = null; doSearch(); });
  document.getElementById('dateTo').addEventListener('change', () => { filterDate = null; doSearch(); });

  // "All time" — clears only date/hour filters, NOT the search text
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.getElementById('dateFrom').value = '';
    document.getElementById('dateTo').value   = '';
    filterDate = null; filterHour = null;
    document.querySelectorAll('.dn-pill').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.hn-pill').forEach(b => b.classList.remove('active'));
    document.querySelector('.dn-pill[data-date="all"]')?.classList.add('active');
    document.querySelector('.hn-pill[data-h="all"]')?.classList.add('active');
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
    await send('DELETE_IDS', { ids: [id] });
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
    await send('DELETE_IDS', { ids });
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
  if (!confirm(`Delete all ${fmtNum(allResults.length)} matching results?`)) return;
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
    <div class="kpi-card"><div class="kpi-label">Total visits</div><div class="kpi-val">${fmtNum(s.totalEntries)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Today</div><div class="kpi-val">${fmtNum(todayCt)}</div></div>
    <div class="kpi-card"><div class="kpi-label">Storage</div><div class="kpi-val sm">${s.storageMB} MB</div></div>
    <div class="kpi-card"><div class="kpi-label">Since</div><div class="kpi-val sm">${s.oldestEntry ? new Date(s.oldestEntry).toLocaleDateString(undefined, { month:'short', year:'numeric' }) : '—'}</div></div>
    `;
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
  const maxV    = Math.max(...vals, 1);

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
  const maxV    = Math.max(...vals, 1);

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
  el.innerHTML = '<div class="state-msg" style="color:var(--text3);font-size:0.85rem">Loading…</div>';
  try {
    const { sessions, current } = await send('GET_SESSIONS');

    if (!sessions.length && !current) {
      el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">📋</span>No sessions recorded yet</div>';
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
      exportBtn.style.cssText = 'font-size:0.72rem;padding:4px 10px;flex-shrink:0;margin-right:4px';
      exportBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        exportSessionAsHtml(dateLabel.main, tabsArr);
      });

      const toggle = document.createElement('span');
      toggle.className   = 'sess-toggle';
      toggle.textContent = '▶';

      head.appendChild(headLeft);
      head.appendChild(tabCount);
      head.appendChild(exportBtn);
      head.appendChild(toggle);

      const tabsEl = document.createElement('div');
      tabsEl.className = 'sess-tabs';
      tabsArr.slice(0, 200).forEach(t => tabsEl.appendChild(buildSessTabEl(t)));

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
        { main: 'Current session', sub: `Started ${timeAgo(current.start)} · ${dur}` },
                                      'Active', current.tabs
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
  const dur = (t.closed && t.opened) ? fmtDuration(t.closed - t.opened) : '';

  const row = document.createElement('div');
  row.className = 'sess-tab-row';
  row.addEventListener('click', () => window.open(t.url, '_blank'));

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

  if (dur) {
    const time = document.createElement('div');
    time.className   = 'sess-ttime';
    time.textContent = dur;
    row.appendChild(time);
  }
  return row;
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

      const head = document.createElement('div');
      head.className = 'dc-head';
      head.innerHTML = `<span class="dc-icon">${icon}</span>`;
      const nameWrap = document.createElement('div');
      const nameEl   = document.createElement('div');
      nameEl.className   = 'dc-name';
      nameEl.textContent = dev.deviceName || 'Unknown';
      const subEl    = document.createElement('div');
      subEl.className   = 'dc-sub';
      subEl.textContent = `${tabs.length} recent tabs`;
      nameWrap.appendChild(nameEl);
      nameWrap.appendChild(subEl);
      head.appendChild(nameWrap);
      card.appendChild(head);

      tabs.slice(0, 30).forEach(t => {
        const dom = tryDomain(t.url || '');
        const row = document.createElement('div');
        row.className = 'dc-row';
        row.addEventListener('click', () => window.open(t.url, '_blank'));

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
        const urlEl   = document.createElement('div');
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
        card.appendChild(row);
      });

      if (!tabs.length) {
        const empty = document.createElement('div');
        empty.className   = 'dc-empty';
        empty.textContent = 'No recent tabs';
        card.appendChild(empty);
      }

      el.appendChild(card);
    });
  } catch (err) {
    el.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

// ══ BOOKMARKS ═══════════════════════════════════════════════════════════════
async function loadBookmarks() {
  const el = document.getElementById('bookmarksContent');
  el.innerHTML = '<div class="state-msg"><span class="state-msg-icon">🔖</span>Loading…</div>';
  try {
    const { tree } = await send('GET_BOOKMARKS');
    el.innerHTML = renderBmTree(tree);

    el.querySelectorAll('.bm-fav-img').forEach(img => {
      img.addEventListener('error', () => { img.style.opacity = '0'; });
    });

    el.querySelectorAll('.bm-folder-head').forEach(h => {
      h.addEventListener('click', () => {
        const items  = h.nextElementSibling;
        const toggle = h.querySelector('.bm-folder-toggle');
        const open   = items.classList.toggle('open');
        if (toggle) toggle.classList.toggle('open', open);
      });
    });
    el.querySelectorAll('.bm-item').forEach(item => {
      item.addEventListener('click', () => {
        const url = item.dataset.url;
        if (url) window.open(url, '_blank');
      });
        item.addEventListener('contextmenu', ev => {
          if (!item.dataset.url) return;
          ev.preventDefault(); ev.stopPropagation();
          showCtxMenu(ev.clientX, ev.clientY, { url: item.dataset.url, title: item.querySelector('.bm-title')?.textContent });
        });
    });
  } catch (err) {
    el.innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
}

function renderBmTree(nodes) {
  let html = '';
  for (const node of nodes) {
    if (node.children) {
      if (!node.children.length) continue;
      html += `<div class="bm-folder">
      <div class="bm-folder-head">
      📁 ${esc(node.title || 'Folder')}
      <span class="bm-folder-toggle">▶</span>
      </div>
      <div class="bm-items">
      ${renderBmItems(node.children)}
      </div>
      </div>`;
    }
  }
  return html || '<div class="state-msg"><span class="state-msg-icon">🔖</span>No bookmarks found</div>';
}

function renderBmItems(nodes) {
  let html = '';
  for (const n of nodes) {
    if (n.url) {
      const dom = tryDomain(n.url);
      html += `<div class="bm-item" data-url="${esc(n.url)}">
      <img class="bm-fav bm-fav-img" src="${favUrl(dom)}" loading="lazy"/>
      <div class="bm-title">${esc(n.title || n.url)}</div>
      <div class="bm-url">${esc(n.url)}</div>
      </div>`;
    } else if (n.children?.length) {
      html += `<div class="bm-item" style="cursor:default;opacity:0.6">
      📁 ${esc(n.title || 'Subfolder')}
      </div>`;
      html += renderBmItems(n.children);
    }
  }
  return html;
}

// Bookmark export (HTML format compatible with browsers)
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
}

function applyVisuals(s) {
  const r = document.documentElement;
  if (s.accentColor)  r.style.setProperty('--accent',  s.accentColor);
  if (s.accentColor2) r.style.setProperty('--accent2', s.accentColor2);
  if (s.fontSize)     r.style.setProperty('--fsize',   s.fontSize + 'px');
  if (s.font)         r.style.setProperty('--font',    s.font);
  if (s.theme)        setTheme(s.theme);
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const days = parseInt(document.getElementById('retDays').value);
  const c1   = document.getElementById('cp1').value;
  const c2   = document.getElementById('cp2').value;
  const font = document.getElementById('fontSel').value;
  const sz   = parseInt(document.getElementById('fontSzInput').value);
  if (!days || days < 1) { toast('Invalid retention', 'err'); return; }
  try {
    const r = await send('SAVE_SETTINGS', { settings: { retentionDays: days, accentColor: c1, accentColor2: c2, font, fontSize: sz, theme: _curSettings.theme || 'dark' } });
    _curSettings = r.settings;
    toast('Settings saved', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('exportDataBtn').addEventListener('click', async () => {
  try {
    const data = await send('EXPORT');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `extended-history_${new Date().toISOString().slice(0,10)}.json` }).click();
    toast(`Exported ${fmtNum(data.totalEntries)} entries`, 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('importDataBtn')?.addEventListener('click', () => {
  document.getElementById('importDataFile')?.click();
});
document.getElementById('importDataFile')?.addEventListener('change', async ev => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data    = JSON.parse(await file.text());
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

// ── Context menu ──────────────────────────────────────────────────────────────
let _ctxEntry = null;

function showCtxMenu(x, y, entry) {
  _ctxEntry = entry;
  const menu   = document.getElementById('ctxMenu');
  const delEl  = document.getElementById('ctx-delete');
  const delSep = document.getElementById('ctx-del-sep');
  const hasId  = !!entry.id;
  if (delEl)  delEl.style.display  = hasId ? '' : 'none';
  if (delSep) delSep.style.display = hasId ? '' : 'none';
  menu.style.display = 'block';
  const mw = 210, mh = 180;
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
  if (_ctxEntry?.url) window.open(_ctxEntry.url, '_blank'); hideCtxMenu();
});
document.getElementById('ctx-open-incognito').addEventListener('click', () => {
  if (_ctxEntry?.url) send('OPEN_INCOGNITO', { url: _ctxEntry.url }); hideCtxMenu();
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

// ── Session export as HTML ────────────────────────────────────────────────────
function exportSessionAsHtml(label, tabs) {
  const validTabs = tabs.filter(t => t.url);
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Session – ${esc(label)}</title>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0d0d10;color:#f0eee8;padding:40px 32px}
  h1{font-size:1.3rem;font-weight:700;color:#3b9eff;margin-bottom:4px}.meta{font-size:.78rem;color:#a09eb0;margin-bottom:28px}
  .links{display:flex;flex-direction:column;gap:3px}a{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;text-decoration:none;color:#f0eee8;background:#18181f;border:1px solid rgba(255,255,255,.06);transition:background .1s}
  a:hover{background:#1f1f28}.fav{width:16px;height:16px;border-radius:3px;flex-shrink:0}.title{flex:1;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .domain{font-size:.7rem;color:#a09eb0;flex-shrink:0;font-family:monospace}footer{margin-top:36px;font-size:.7rem;color:#5a5870}</style></head>
  <body><h1>📋 ${esc(label)}</h1><div class="meta">${validTabs.length} tabs · Exported ${new Date().toLocaleString()}</div>
  <div class="links">${validTabs.map(t => {
    const dom = tryDomain(t.url);
    return `<a href="${esc(t.url)}"><img class="fav" src="https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(dom)}" loading="lazy" onerror="this.style.display='none'"/><span class="title">${esc(t.title||t.url)}</span><span class="domain">${esc(dom)}</span></a>`;
  }).join('')}</div><footer>Exported by Extended History</footer></body></html>`;
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([html],{type:'text/html'})), download: `session_${new Date().toISOString().slice(0,10)}.html` }).click();
  toast('Session exported', 'ok');
}

// ══ PANEL NAV ════════════════════════════════════════════════════════════════
function switchPanel(name) {
  document.querySelectorAll('.nav-item[data-panel]').forEach(b =>
  b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p =>
  p.classList.toggle('active', p.id === `panel-${name}`));

  if (name === 'activity')  loadActivity();
  if (name === 'timespent') loadTimeSpent(curTimeDays || 15);
  if (name === 'devices')   loadDevices();
  if (name === 'sessions')  loadSessions();
  if (name === 'bookmarks') loadBookmarks();
  if (name === 'settings')  send('GET_SETTINGS').then(s => { _curSettings = s; populateSettings(s); }).catch(() => {});
}

// ══ INIT ════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Load settings first
  try {
    const s    = await send('GET_SETTINGS');
    _curSettings = s;
    applyVisuals(s);
    populateSettings(s);
  } catch {}

  // Theme buttons
  document.getElementById('themeLight').addEventListener('click', () => setTheme('light'));
  document.getElementById('themeDark').addEventListener('click', () => setTheme('dark'));

  // Setup
  document.querySelectorAll('.nav-item[data-panel]').forEach(b =>
  b.addEventListener('click', () => switchPanel(b.dataset.panel)));

  buildDateNav();
  buildHourNav();
  setupToolbar();
  setupSelActions();

  // Default to Today — activate silently so doSearch below picks up filterDate
  const todayKey = new Date().toLocaleDateString('en-CA');
  activateDatePill(todayKey, true);

  doSearch();

  // Hash routing — only switch away from history if explicitly requested; clear hash so refresh = history
  const hash = location.hash.slice(1);
  if (hash && hash !== 'history' && ['sessions','devices','activity','timespent','bookmarks','settings','about'].includes(hash)) {
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
});
