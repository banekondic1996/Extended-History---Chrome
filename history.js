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

  if (!allResults.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span>No history found</div>`;
    return;
  }

  area.innerHTML = '';
  appendPage();          // render first page immediately
  setupScrollObserver(area);
  calScrollSpyCheck(area);
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
      hdr.innerHTML = `${esc(dl)}<span class="day-visits"></span>`;
      area.appendChild(hdr);
      prevDay = dl;
    }

    const sel = selected.has(e.id);
    const row = document.createElement('div');
    row.className = `entry${sel ? ' sel' : ''}${selMode ? ' sel-mode-entry' : ''}`;
    row.dataset.id   = e.id;
    row.dataset.url  = e.url;
    row.dataset.date = new Date(e.visitTime).toLocaleDateString('en-CA');
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

// NOTE: date/search switching is fast because background.js now keeps history
// in memory between calls (see getAll()/setAll() there) instead of re-reading
// and re-parsing the whole storage blob on every SEARCH message. We deliberately
// do NOT duplicate the entire history into this page's memory (that was tried
// and caused growing RAM usage across reloads) — only the current filtered
// result set is held here, same as before.
async function doSearch() {
  const { query, mode, startDate, endDate } = getFilters();
  selected.clear(); selMode = false; updateSelBar();

  listArea().innerHTML = `<div class="state-msg" style="color:var(--text3);font-size:0.85rem">Loading…</div>`;

  try {
    const r = await send('SEARCH', { query, mode, startDate, endDate, limit: 20000 });
    allResults = applyQuickFilterEntries(r.entries);
    buildVirtualList();
  } catch (err) {
    listArea().innerHTML = `<div class="state-msg"><span class="state-msg-icon">⚠</span>${esc(err.message)}</div>`;
  }
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
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Lets a normal mouse wheel (vertical-only deltaY) scroll the horizontally
// scrolling date-pill bar — off by default since trackpads already scroll it
// horizontally on their own; useful for desktop/laptop mouse users. Moves by
// whole pill-widths per wheel "click" rather than raw pixel deltas, with a
// sensitivity setting (1–6) controlling how many days that jumps per click.
let _datePillsWheelEnabled = false;
let _datePillsWheelSensitivity = 1;
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

    const pill = document.querySelector('#dateScroll .dn-pill');
    const gap  = parseFloat(getComputedStyle(document.getElementById('dateScroll')).gap) || 6;
    const pillWidth = pill ? pill.getBoundingClientRect().width + gap : 60;
    const dir = e.deltaY > 0 ? 1 : -1;
    wrap.scrollBy({ left: dir * pillWidth * _datePillsWheelSensitivity, behavior: 'smooth' });
  }, { passive: false });
}

function buildDateNav(retentionDays) {
  const scroll = document.getElementById('dateScroll');
  const now    = Date.now();

  // Use the setting value; fall back to 365 if not provided or not a valid number.
  // Add 1 so "today" (i=0) is always included even when retentionDays is exactly 1.
  const pillCount = (Number.isFinite(retentionDays) && retentionDays > 0)
    ? retentionDays + 1
    : 366;

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
  for (let i = 0; i < pillCount; i++) {
    const d   = new Date(now - i * 86400000);
    const key = d.toLocaleDateString('en-CA');
    if (i === 0) { addBtn(_ehMsg('today')     || 'Today',     key, ''); continue; }
    if (i === 1) { addBtn(_ehMsg('yesterday') || 'Yesterday', key, ''); continue; }
    addBtn(d.toLocaleDateString(undefined, { month:'short', day:'numeric' }), key, DAYS[d.getDay()]);
  }

  // ── Scroll year indicator on dnAllPill ──────────────────────────────────────
  (function setupScrollYearIndicator() {
    const wrap    = document.getElementById('dateScrollWrap');
    const allPill = document.getElementById('dnAllPill');
    if (!wrap || !allPill) return;

    let _scrollStopTimer = null;
    let _isScrolling = false;

    wrap.addEventListener('scroll', () => {
      // Find the first dn-pill whose left edge is at or past the scroll container's left
      const wrapLeft = wrap.getBoundingClientRect().left;
      const pills    = document.querySelectorAll('#dateScroll .dn-pill');
      let firstVisible = null;
      for (const pill of pills) {
        if (pill.getBoundingClientRect().left >= wrapLeft - 2) {
          firstVisible = pill;
          break;
        }
      }

      if (firstVisible) {
        const date = firstVisible.dataset.date; // 'YYYY-MM-DD'
        const year = date ? date.slice(0, 4) : null;
        if (year) {
          allPill.textContent = year;
          _isScrolling = true;
        }
      }

      // Reset back to "All" shortly after scrolling stops
      clearTimeout(_scrollStopTimer);
      _scrollStopTimer = setTimeout(() => {
        _isScrolling = false;
        // Restore the original label — "All" (use i18n if available)
        allPill.textContent = _ehMsg('all') || 'All';
      }, 600);
    }, { passive: true });
  })();

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
  syncCalActiveDate(key);
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
    b.addEventListener('click', () => setFilterHour(h));
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
    if (key === filterDate) btn.classList.add('selected');
    else if (!filterDate && key === calActiveDate) btn.classList.add('scroll-highlight');
    if (key > todayKey) btn.classList.add('future');
    btn.addEventListener('click', () => {
      if (key > todayKey) return;
      calSelectDate(key);
    });
    daysEl.appendChild(btn);
  }
}

function calSelectDate(key) {
  closeCalPickers();
  activateDatePill(key); // handles filterDate, old pills, calendar sync, and doSearch
}

function calGoAllTime() {
  closeCalPickers();
  activateDatePill('all');
}

function calShiftMonth(delta) {
  calViewMonth += delta;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  renderCalendarWidget();
}

function calShiftDay(delta) {
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

// ── Scroll-spy: while browsing "All time", highlight the date of whatever's
// currently at the top of the visible list, without touching filterDate. ──
// NOTE: this used to scan every rendered `.entry` row (data-date lives on each
// entry) to find the one at the top. Since the list is append-only infinite
// scroll — old rows are never removed from the DOM — that scan grew with
// however far you'd scrolled, and ran on every animation frame while
// scrolling, which is what made scrolling feel like it was doing work.
// `.day-label` headers carry the same date and there are orders of magnitude
// fewer of them (one per day vs. one per visit), so scan those instead.
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
  const active = document.body.classList.contains('cal-mode') && !!onHistoryPanel;
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
  }

  if (!allResults.length) {
    area.innerHTML = `<div class="state-msg"><span class="state-msg-icon">🔎</span>No history found</div>`;
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
    const result = await send('DELETE_IDS', { ids: [id], urls });
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
  return send('DELETE_IDS', { ids, urls });
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
    if (typeof window.applyTranslations === 'function') window.applyTranslations();
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
  _bmItems = items;
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
  return !!_bmActiveNode && !_bmIsSearch;
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

  _bmIsSearch = true;
  _bmInitList(results, 'No matching bookmarks');
}
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
  if (popupHeightInput)  {
    popupHeightInput.value = s.popupHeight || 320;
    if (popupHeightVal) popupHeightVal.textContent = popupHeightInput.value + 'px';
  }
  if (popupSidebarToggle) {
    popupSidebarToggle.checked = s.popupAsSidebar === true;
    const row = document.getElementById('popupHeightRow');
    if (row) row.style.opacity = s.popupAsSidebar === true ? '0.4' : '';
  }
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
  if (s.theme)        setTheme(s.theme);
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
  const bgTintEnabled = document.getElementById('bgTintToggle')?.checked || false;
  const bgTintHue = parseInt(document.getElementById('bgTintHue')?.value || '220');
  const bgTintOpacity = parseInt(document.getElementById('bgTintOpacity')?.value || '8');
  const popupShowSearch = document.getElementById('popupSearchToggle')?.checked !== false;
  const popupShowTabs   = document.getElementById('popupTabsToggle')?.checked   !== false;
  const popupShowUrl   = document.getElementById('popupURLsToggle')?.checked   !== false;
  const popupHeight     = parseInt(document.getElementById('popupHeightInput')?.value || '320');
  const popupAsSidebar  = document.getElementById('popupSidebarToggle')?.checked === true;
  const sidebarAutoHide = document.getElementById('sidebarAutoHideToggle')?.checked !== false;
  const faviconResolver = document.getElementById('faviconResolverSel')?.value || 'google';
  const searchAutoFocus = document.getElementById('searchAutoFocusToggle')?.checked !== false;
  const highContrastMode = document.getElementById('highContrastToggle')?.checked === true;
  const roundedCorners = document.getElementById('roundedCornersToggle')?.checked !== false;
  const navIcons = document.getElementById('navIconsToggle')?.checked !== false;
  const matchUiColors = document.getElementById('matchUiColorsToggle')?.checked === true;
  const calendarMode = document.getElementById('calendarModeToggle')?.checked === true;
  const contextMenuEnabled = document.getElementById('contextMenuToggle')?.checked !== false;
  const datePillsWheelScroll = document.getElementById('datePillsWheelToggle')?.checked === true;
  const datePillsWheelSensitivity = Math.max(1, Math.min(6, parseInt(document.getElementById('datePillsWheelSensInput')?.value || '1') || 1));
  const toolbarIcon = document.querySelector('#toolbarIconGrid .icon-opt.on')?.dataset.icon || 'default';
  const autoExportIntervalMonths = Math.max(0, Math.min(60, parseInt(document.getElementById('autoExportInput')?.value || '0') || 0));
  
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
        bgTintEnabled,
        bgTintHue,
        bgTintOpacity,
        popupShowSearch,
        popupShowTabs,
        popupShowUrl,
        popupHeight,
        popupAsSidebar,
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
        datePillsWheelSensitivity,
        toolbarIcon,
        autoExportIntervalMonths,
        timeTrackingEnabled: document.getElementById('timeTrackingToggle')?.checked !== false,
        syncInterval: Math.max(1, Math.min(1440, parseInt(document.getElementById('syncIntervalInput')?.value || '30') || 30)),
        autoStoreEnabled: document.getElementById('autoStoreToggle')?.checked === true,
        autoStoreHours: Math.max(1, Math.min(168, parseInt(document.getElementById('autoStoreHoursInput')?.value || '6') || 6))
      } 
    });
    _curSettings = r.settings;
    applyIconVariant(_curSettings.toolbarIcon || 'default');
    applyDatePillsWheelScroll(_curSettings.datePillsWheelScroll === true, _curSettings.datePillsWheelSensitivity);
    applyHighContrastMode(_curSettings.highContrastMode === true);
    // Save max sessions separately
    if (maxSess >= 1 && maxSess <= 20) await send('SET_MAX_SESSIONS', { value: maxSess });
    // Save auto-save interval
    const autoSaveMins = parseInt(document.getElementById('autoSaveInput')?.value || '0');
    await send('SET_AUTO_SAVE_INTERVAL', { minutes: autoSaveMins });
    toast('Settings saved', 'ok');
    refreshAutoExportStatus();
  } catch (err) { toast(err.message, 'err'); }
});

// ── Auto export interval ──────────────────────────────────────────────────────
async function refreshAutoExportStatus() {
  const el = document.getElementById('autoExportStatus');
  if (!el) return;
  try {
    const r = await send('GET_AUTO_EXPORT_STATUS');
    if (!r.enabled) { el.textContent = 'Disabled'; return; }
    const acc = r.monthsAccumulated || 0;
    if (acc < r.retainMonths + r.intervalMonths) {
      el.textContent = `${acc.toFixed(1)} / ${r.retainMonths + r.intervalMonths} months accumulated`;
    } else {
      el.textContent = 'Due — will run on next check';
    }
  } catch {
    el.textContent = '';
  }
}

document.getElementById('testAutoExportBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('testAutoExportBtn');
  const inputEl = document.getElementById('autoExportInput');
  const interval = Math.max(0, Math.min(60, parseInt(inputEl?.value || '0') || 0));
  if (interval <= 0) { toast('Enter a number of months above 0 first', 'err'); return; }

  const ok = confirm(
    `This will export everything in your extended history older than 3 months to a .json file, ` +
    `then remove it from this extension's storage (your last 3 months always stay). ` +
    `This never touches Chrome's native history. Continue?`
  );
  if (!ok) return;

  btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Running…';
  try {
    // Persist the interval so "Run now" always reflects what's currently typed in,
    // even if "Save Settings" was never clicked.
    await send('SAVE_SETTINGS', { settings: { autoExportIntervalMonths: interval } });
    _curSettings.autoExportIntervalMonths = interval;

    const r = await send('TRIGGER_AUTO_EXPORT');
    if (r.success) {
      toast(`Exported & removed ${fmtNum(r.exported)} entries older than 3 months from extended storage`, 'ok');
      invalidateHistCache();
      doSearch();
    } else if (r.reason === 'empty' || r.reason === 'nothing_past_cutoff') {
      toast('Nothing older than 3 months to export yet', 'ok');
    } else if (r.reason === 'download_failed') {
      toast('Could not save the export file — nothing was deleted. Try again.', 'err');
    } else {
      toast('Nothing to export yet', 'err');
    }
    refreshAutoExportStatus();
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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'AUTO_SAVE_DOWNLOAD') return;
  const content = msg.content ?? msg.html; // msg.html kept for back-compat
  const blob = new Blob([content], { type: msg.mime || 'text/html' });
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
    invalidateHistCache();
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
    invalidateHistCache();
    doSearch();
  } catch (err) { toast(err.message, 'err'); }
});

document.getElementById('clearAllBtn').addEventListener('click', async () => {
  if (!confirm('Delete ALL history permanently? Cannot be undone.')) return;
  try {
    await send('CLEAR_ALL');
    allResults = []; invalidateHistCache(); exitSelMode(); buildVirtualList();
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
  const bmRename   = document.getElementById('ctx-rename-bookmark');
  const hasId   = !!entry.id;
  const hasDate = !!entry.visitTime;
  const hasBmId = !!entry.bmId;
  if (delEl)        delEl.style.display        = hasId   ? '' : 'none';
  if (delSep)       delSep.style.display       = hasId   ? '' : 'none';
  if (jumpEl)       jumpEl.style.display       = hasDate ? '' : 'none';
  if (jumpSep)      jumpSep.style.display      = hasDate ? '' : 'none';
  if (bmRemove)     bmRemove.style.display     = hasBmId ? '' : 'none';
  if (bmRename)     bmRename.style.display     = hasBmId ? '' : 'none';
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
      title.textContent = tr('ignore_list_setup','🔒 Set Up Ignore List');
      desc.textContent  = tr('ignore_list_setup_desc','No password is set yet. Create a master password to protect your ignore list.');
      resetBtn.style.display = 'none';
      okBtn.textContent =  tr('create_password','Create Password');
    } else if (m === 'unlock') {
      title.textContent = tr('ignore_list_access','🔒 Ignore List Access');
      desc.textContent  = tr('ignore_list_access_desc','Enter your master password to view the ignore list.');
      resetBtn.style.display = '';
      okBtn.textContent = tr('ok','OK');
    } else if (m === 'reset-new') {
      title.textContent = tr('reset_ignore_list','🔑 Reset Ignore List');
      desc.textContent  = tr('reset_ignore_list_desc','Ignore list has been cleared. Enter a new master password to continue.');
      resetBtn.style.display = 'none';
      okBtn.textContent = tr('set_new_password','Set New Password');
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
        <div class="panel-heading">🚫 <span data-i18n-key="ignored_domains">Ignored Domains</span></div>
        <p style="color:var(--text2);font-size:0.9rem;margin-bottom:20px;line-height:1.5;max-width:600px">
          <span data-i18n-key="domains_added_will_not_be">Domains added here will not be saved in history. Existing entries will be removed automatically.</span>
          <span data-i18n-key="ignore_keywords_note">Words without a dot are treated as keywords — they match any URL or page title containing that word.</span>
        </p>
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
    const s = await send('GET_DEV_STATS');
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
      border-color: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'} !important;
    }

    html.wallpaper-mode .modal-box,
    html.wallpaper-mode .s-card,
    html.wallpaper-mode .chart-card,
    html.wallpaper-mode .ctxMenu,
    html.wallpaper-mode .kpi-card,
    html.wallpaper-mode .modal-inner,
    html.wallpaper-mode .ignore-add,
    html.wallpaper-mode .ignore-item,
    html.wallpaper-mode .session-card,
    html.wallpaper-mode .device-card,
    html.wallpaper-mode .ts-card,
    html.wallpaper-mode .bm-item,
    html.wallpaper-mode .mv-item,
    html.wallpaper-mode .day-label, .bm-tree-pane, .bm-toolbar, .sel-bar.on{
      background: ${isDark ? 'rgba(19,19,24,0.55)' : 'rgba(255,255,255,0.55)'} !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.4) !important;
      border-color: ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'} !important;
      color:var(--text2);
    }
    /* The history list gets its own glass layer stacked on top of .main's
       (which carries the same tint as the sidebar): a faint white lift over
       the dark glass (list lighter than the UI in dark mode), and a faint
       black shade over the light glass (list darker than the UI in light
       mode). */
    html.wallpaper-mode .list-area {
      background: ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'} !important;
    }
    /* Sticky date headers must blend into that list surface: no tint of their
       own (a second layer would show as a lighter band), just a blur so rows
       scrolling underneath stay legible. */
    /* Settings > Match UI colors: no tint of its own - the list shows the same
       glass as the sidebar / calendar sidebar / main panel behind it. */
    html.wallpaper-mode.match-ui-colors .list-area { background: transparent !important; }
    html.wallpaper-mode .list-area .day-label {
      background: transparent !important;
      backdrop-filter: blur(10px) !important;
      -webkit-backdrop-filter: blur(10px) !important;
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
    /* .topbar has a solid background in the base stylesheet — let .main's
       own glass layer show through it instead of covering it again. */
    html.wallpaper-mode .topbar {
      background: transparent !important;
    }
    /* .entry rows tile edge-to-edge across .list-area, so giving each one
       its own glass layer (like the card elements above) stacked another
       ~55% opaque layer on every row across the whole list — compounding
       with .main's glass until the list read as solid instead of frosted.
       Keep just the border for row separation; .main's glass carries the
       actual background here. Hover/selected states still get their own
       solid highlight from the base stylesheet. */
    html.wallpaper-mode .entry {
      background: transparent !important;
      border-color: ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'} !important;
    }
    html.wallpaper-mode .action-btn,
    html.wallpaper-mode .dn-pill,
    html.wallpaper-mode .chip,
    html.wallpaper-mode .nav-item,
    html.wallpaper-mode .tf-btn {
      border-color: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'} !important;
  
    }
    html.wallpaper-mode #dnLeft,#dnRight,.dn-pill, .tb-btn, .hn-pill, .sa-btn, .action-btn, .tf-btn, .nav-arrow, #rmSearchMode, #rmDateFrom, #rmDateTo, #languageSelect{
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
      const warn = document.getElementById('dhConfirmWarn');
      if (warn) {
        let msg = tr('dh_confirm_warn', 'This will permanently delete history for: {0}. Click Delete again to confirm.', label);
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
      const r = await send('DELETE_HISTORY_RANGE', { startTime, endTime, clearCookies, clearCache });
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