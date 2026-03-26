/**
 * Extended History — background.js v3.3 (Firefox port)
 *
 * Firefox-specific changes:
 *  1. All browser.* APIs (Promise-based, no callbacks needed)
 *  2. browser.tabs.query({url}) → manual filter (Firefox MV2 requires activeTab
 *     permission for URL-based tab queries from background)
 *  3. browser.i18n.getMessage → i18n() helper (graceful fallback)
 *  4. browser.runtime.onMessageExternal → removed (not supported in Firefox MV2)
 *  5. browser.storage.local.getBytesInUse → byte-size estimation fallback
 *  6. Array.prototype.findLastIndex polyfill (Firefox < 104)
 *  7. browser.browsingData.remove wrapped in try/catch (already was, kept)
 *  8. Persistent background page (manifest: persistent:true), so SW lifecycle
 *     patterns (alarms for self-heal) are kept but aren't strictly necessary.
 */

// ── Array.findLastIndex polyfill (Firefox < 104) ──────────────────────────────
if (!Array.prototype.findLastIndex) {
  Array.prototype.findLastIndex = function(predicate) {
    for (let i = this.length - 1; i >= 0; i--) {
      if (predicate(this[i], i, this)) return i;
    }
    return -1;
  };
}

// ── i18n helper ──────────────────────────────────────────────────────────────
function i18n(key, sub) {
  try {
    const msg = browser.i18n.getMessage(key, sub);
    return msg || key;
  } catch { return key; }
}

const HISTORY_KEY  = 'eh_history';
const TODAY_HISTORY_KEY = 'eh_today_history';
const TIME_KEY     = 'eh_time';
const SETTINGS_KEY = 'eh_settings';
const SESSIONS_KEY = 'eh_sessions';
const BACKFILL_KEY = 'eh_backfilled';
const CURRENT_SESSION_KEY = 'eh_current_session';
const IGNORE_LIST_KEY = 'eh_ignore_list';
const SYNC_INTERVAL_KEY = 'eh_sync_interval';
const CONTEXT_MENU_PARENT_ID        = 'eh_options';
const CONTEXT_MENU_IGNORE_DOMAIN_ID = 'eh_ignore_domain';
const CONTEXT_MENU_STORE_TAB_ID     = 'eh_store_tab';
const TAB_STORAGE_KEY               = 'eh_tab_storage';
const MAX_SESSIONS_DEFAULT = 4;

const DEFAULT_SETTINGS = {
  retentionDays: 365,
  maxEntries:    2000000,
  accentColor:   '#3b9eff',
  accentColor2:  '#2dd4a0',
  font:          'system-ui',
  fontSize:      15,
  theme:         'dark',
  language:      'en',
  ignoreListEnabled: true,
  syncInterval: 30,
  timeTrackingEnabled: true,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function todayKey() { return new Date().toLocaleDateString('en-CA'); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isTrackable(url) {
  if (!url) return false;
  return !['chrome://','chrome-extension://','about:','data:','javascript:','moz-extension://','edge://','brave://'].some(p => url.startsWith(p));
}

// ── Ignore List ──────────────────────────────────────────────────────────────
function normalizeIgnorePattern(pattern) {
  if (typeof pattern !== 'string') return '';
  let out = pattern.trim();
  if (!out) return '';
  if (out.startsWith('kw:')) return out;
  out = out.replace(/^['\"`]+|['\"`]+$/g, '');
  const stripped = out.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (stripped.indexOf('.') === -1 && stripped.indexOf('/') === -1) {
    return 'kw:' + stripped.toLowerCase().trim();
  }
  out = out.replace(/^https?:\/\//i, '');
  out = out.replace(/\.+$/g, '');
  out = out.trim();
  if (!out) return '';

  const slashIdx = out.indexOf('/');
  const hostPart = (slashIdx === -1 ? out : out.slice(0, slashIdx)).toLowerCase();
  const pathPart = slashIdx === -1 ? '' : out.slice(slashIdx).replace(/\/+$/, '');
  if (!hostPart) return '';
  return hostPart + pathPart;
}

function parseIgnorePattern(pattern) {
  const cleanPattern = normalizeIgnorePattern(pattern);
  if (!cleanPattern) return null;

  const slashIdx = cleanPattern.indexOf('/');
  const hostPart = slashIdx === -1 ? cleanPattern : cleanPattern.slice(0, slashIdx);
  const pathPart = slashIdx === -1 ? '' : cleanPattern.slice(slashIdx);
  const wildcard = hostPart.startsWith('*.');
  const host = wildcard ? hostPart.slice(2) : hostPart;
  if (!host) return null;

  return { host, path: pathPart, wildcard };
}

function stripWww(host) {
  return String(host || '').toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

function hostMatchesPattern(urlHost, patternHost, allowSubdomains = true) {
  const u = stripWww(urlHost);
  const p = stripWww(patternHost);
  if (!u || !p) return false;
  if (u === p) return true;
  return allowSubdomains ? u.endsWith('.' + p) : false;
}

async function getIgnoreList() {
  const r = await browser.storage.local.get(IGNORE_LIST_KEY);
  const list = r[IGNORE_LIST_KEY] || [];
  return list.map(normalizeIgnorePattern).filter(Boolean);
}

async function setIgnoreList(list) {
  const seen = new Set();
  const normalized = [];
  for (const pattern of (list || [])) {
    const clean = normalizeIgnorePattern(pattern);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  await browser.storage.local.set({ [IGNORE_LIST_KEY]: normalized });
}

async function isIgnoreListEnabled() {
  const r = await browser.storage.local.get(SETTINGS_KEY);
  const settings = r[SETTINGS_KEY] || DEFAULT_SETTINGS;
  return settings.ignoreListEnabled !== false;
}

function matchesIgnorePattern(url, pattern, title) {
  try {
    if (pattern.startsWith('kw:')) {
      const kw = pattern.slice(3).toLowerCase();
      if (!kw) return false;
      const urlLower = (url || '').toLowerCase();
      const titleLower = (title || '').toLowerCase();
      return urlLower.includes(kw) || titleLower.includes(kw);
    }
    const parsed = parseIgnorePattern(pattern);
    if (!parsed) return false;

    const urlObj = new URL(url);
    const urlHost = urlObj.hostname;
    const allowSubdomains = parsed.wildcard || !parsed.path;
    if (!hostMatchesPattern(urlHost, parsed.host, allowSubdomains)) return false;

    if (parsed.path) {
      const urlPath = urlObj.pathname + urlObj.search;
      return urlPath.startsWith(parsed.path);
    }
    return true;
  } catch {
    return false;
  }
}

async function shouldIgnoreUrl(url, title) {
  const enabled = await isIgnoreListEnabled();
  if (!enabled) return false;
  const ignoreList = await getIgnoreList();
  return ignoreList.some(pattern => matchesIgnorePattern(url, pattern, title));
}

async function addIgnorePattern(pattern) {
  const clean = normalizeIgnorePattern(pattern);
  if (!clean) return { success: false, error: 'Invalid pattern' };

  const list = await getIgnoreList();
  if (list.includes(clean)) return { success: false, error: 'Pattern already exists' };

  list.push(clean);
  await setIgnoreList(list);
  return { success: true, pattern: clean };
}

async function deleteUrlFromNativeHistory(url) {
  const urls = [...new Set([url, normalizeUrl(url)])].filter(Boolean);
  for (const target of urls) {
    try { await browser.history.deleteUrl({ url: target }); } catch {}
  }
}

async function cleanupIgnoredUrlFromNativeHistory(url) {
  const host = domainOf(url);
  const passes = [0, 250, 1200];
  for (const waitMs of passes) {
    if (waitMs) await sleep(waitMs);
    await deleteUrlFromNativeHistory(url);
  }

  if (!host) return;
  try {
    const ignoreList = await getIgnoreList();
    const recent = await browser.history.search({
      text: host,
      startTime: Date.now() - 10 * 60 * 1000,
      maxResults: 250,
    });

    for (const item of recent) {
      if (!item.url || !isTrackable(item.url)) continue;
      if (!ignoreList.some(pattern => matchesIgnorePattern(item.url, pattern))) continue;
      await deleteUrlFromNativeHistory(item.url);
    }
  } catch {}
}

async function cleanIgnoredFromHistory() {
  const enabled = await isIgnoreListEnabled();
  if (!enabled) return { removed: 0 };
  const ignoreList = await getIgnoreList();
  if (!ignoreList.length) return { removed: 0 };

  let entries = await getAll();

  const toKeep = [];
  const toDelete = [];
  for (const e of entries) {
    if (ignoreList.some(pattern => matchesIgnorePattern(e.url, pattern, e.title))) {
      toDelete.push(e);
    } else {
      toKeep.push(e);
    }
  }

  if (toDelete.length) {
    await setAll(toKeep);
    await updateTodayHistory();

    for (const e of toDelete) {
      try { await browser.history.deleteUrl({ url: e.url }); } catch {}
    }
  }

  return { removed: toDelete.length };
}

// ── Time tracking ─────────────────────────────────────────────────────────────
let activeTabId    = null;
let activeDomain   = null;
let segmentStart   = null;
let windowFocused  = true;
let _timeTrackingEnabled = true;

async function commitSegment() {
  if (!activeDomain || !segmentStart || !windowFocused) {
    segmentStart = null;
    return;
  }
  if (!_timeTrackingEnabled) { segmentStart = null; return; }
  const now = Date.now();
  const ms  = now - segmentStart;
  segmentStart = null;

  if (ms < 1000 || ms > 7_200_000) return;

  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const sinceDay = now - midnight.getTime();
  const capped   = Math.min(ms, sinceDay);
  if (capped < 1000) return;

  await addTime(activeDomain, capped);
}

function startSegment(tabId, domain) {
  activeTabId  = tabId;
  activeDomain = domain;
  segmentStart = Date.now();
}

async function resumeActiveTab() {
  try {
    const wins = await browser.windows.getAll({ populate: false });
    const focused = wins.find(w => w.focused);
    if (!focused) { windowFocused = false; return; }
    windowFocused = true;
    const tabs = await browser.tabs.query({ active: true, windowId: focused.id });
    const tab = tabs[0];
    if (tab && isTrackable(tab.url)) {
      if (_timeTrackingEnabled) startSegment(tab.id, domainOf(tab.url));
    }
  } catch {}
}

async function addTime(domain, ms) {
  if (!domain) return;
  const r   = await browser.storage.local.get(TIME_KEY);
  const map = r[TIME_KEY] || {};
  const day = todayKey();
  if (!map[domain]) map[domain] = {};
  map[domain][day] = (map[domain][day] || 0) + ms;
  await browser.storage.local.set({ [TIME_KEY]: map });
}

browser.alarms.create('eh_tick',  { periodInMinutes: 0.5 });
browser.alarms.create('eh_flush', { periodInMinutes: 1 });

const AUTO_SAVE_KEY = 'eh_auto_save_interval';
let _lastAutoSave   = 0;
let _lastSessionSave = 0;

async function getTodayFromNativeHistory() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startTime = todayStart.getTime();

  try {
    const items = await browser.history.search({
      text: '',
      startTime,
      maxResults: 10000,
    });

    const ignoreEnabled = await isIgnoreListEnabled();
    const ignoreList = ignoreEnabled ? await getIgnoreList() : [];

    const entries = [];
    for (const item of items) {
      if (!item.url || !isTrackable(item.url)) continue;
      if (ignoreList.some(p => matchesIgnorePattern(item.url, p, item.title))) continue;
      entries.push({
        id: `live_${item.lastVisitTime}_${Math.random().toString(36).slice(2, 6)}`,
        url: normalizeUrl(item.url),
        rawUrl: item.url,
        title: item.title || '',
        visitTime: item.lastVisitTime || Date.now(),
        domain: domainOf(item.url),
        tabId: null,
        source: 'live',
      });
    }
    return entries;
  } catch {
    return [];
  }
}

// Alias for compatibility with callers that use the legacy-named function
const getTodayFromBrowserApi = getTodayFromNativeHistory;

async function updateTodayHistory() {
  // No-op: today's history is read live via getTodayFromNativeHistory().
}

let _lastFlush = 0;

async function flushTodayToHistory() {
  const settings = await getSettings();
  const now = Date.now();
  const cutoff = now - settings.retentionDays * 86400000;

  const todayEntries = await getTodayFromNativeHistory();
  if (!todayEntries.length) return;

  let existing = await getAll();
  const existingSet = new Set(existing.map(e => `${e.url}|${Math.floor(e.visitTime / 5000)}`));

  let added = 0;
  for (const e of todayEntries) {
    const key = `${e.url}|${Math.floor(e.visitTime / 5000)}`;
    if (existingSet.has(key)) continue;
    existingSet.add(key);
    existing.push({ ...e, id: `flush_${e.visitTime}_${Math.random().toString(36).slice(2, 6)}`, source: 'flush' });
    added++;
  }

  if (!added) return;

  existing = existing.filter(e => e.visitTime >= cutoff);
  if (existing.length > settings.maxEntries) existing = existing.slice(existing.length - settings.maxEntries);
  existing.sort((a, b) => b.visitTime - a.visitTime);
  await setAll(existing);
  _lastFlush = now;
}

async function getSyncInterval() {
  const settings = await getSettings();
  return typeof settings.syncInterval === 'number' ? settings.syncInterval : 30;
}

async function getAutoSaveInterval() {
  const r = await browser.storage.local.get(AUTO_SAVE_KEY);
  return r[AUTO_SAVE_KEY] ?? 0;
}

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'eh_flush') {
    const intervalMins = await getSyncInterval();
    if (intervalMins > 0 && Date.now() - _lastFlush >= intervalMins * 60 * 1000) {
      await flushTodayToHistory().catch(() => {});
    }
    return;
  }
  if (alarm.name !== 'eh_tick') return;
  if (_timeTrackingEnabled) {
    if (activeDomain && segmentStart && windowFocused) {
      await commitSegment();
      segmentStart = Date.now();
    } else if (!segmentStart) {
      await resumeActiveTab();
    }
  }

  const now = Date.now();
  if (now - _lastSessionSave >= 30000) {
    await saveCurrentSession();
    _lastSessionSave = now;
  }

  const mins = await getAutoSaveInterval();
  if (mins >= 1 && Date.now() - _lastAutoSave >= mins * 60 * 1000) {
    try {
      const win = await browser.windows.getLastFocused({ populate: false });
      if (win && win.focused) await doAutoSaveSession();
    } catch {}
  }
});

async function doAutoSaveSession() {
  if (!sessionId) await loadSessionState();
  const openTabs = sessionId
    ? Object.values(sessionTabs).filter(t => t.url && t.closed === null)
    : [];
  if (!openTabs.length) return;

  const label    = i18n('current_session') + ' – ' + new Date().toLocaleString();
  const tsData   = await browser.storage.local.get('eh_tab_storage');
  const tsEntries = tsData['eh_tab_storage'] || [];
  const htmlBody = buildSessionHtml(label, openTabs, tsEntries);
  const extPageUrl = browser.runtime.getURL('history.html');

  let tabId = null;
  let didOpen = false;
  try {
    // Firefox: can't query by URL from background without <all_urls>; query all and filter
    const allTabs = await browser.tabs.query({});
    const existing = allTabs.filter(t => t.url && t.url.startsWith(extPageUrl));
    if (existing.length > 0) {
      tabId = existing[0].id;
    } else {
      const t = await browser.tabs.create({ url: extPageUrl, active: false });
      tabId = t.id;
      didOpen = true;
    }
  } catch (e) {
    console.warn('[EH] auto-save: could not get tab:', e.message);
    return;
  }

  await new Promise(resolve => {
    if (!didOpen) { resolve(); return; }
    const timeout = setTimeout(resolve, 6000);
    const listener = (msg, sender) => {
      if (msg.type === 'AUTO_SAVE_READY' && sender.tab && sender.tab.id === tabId) {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        resolve();
      }
      return false;
    };
    browser.runtime.onMessage.addListener(listener);
  });

  try {
    await browser.tabs.sendMessage(tabId, {
      type: 'AUTO_SAVE_DOWNLOAD',
      html: htmlBody,
      filename: 'extended-history-session.html',
    });
    _lastAutoSave = Date.now();
  } catch (e) {
    console.warn('[EH] auto-save: send failed:', e.message);
  }

  if (didOpen) {
    setTimeout(async () => {
      try { await browser.tabs.remove(tabId); } catch {}
    }, 3000);
  }
}

async function saveCurrentSession() {
  if (!sessionId) await loadSessionState();
  const openTabs = sessionId
    ? Object.values(sessionTabs).filter(t => t.url && t.closed === null)
    : [];

  if (!openTabs.length) return;

  await browser.storage.local.set({
    [CURRENT_SESSION_KEY]: {
      id: sessionId,
      start: sessionStart,
      tabs: openTabs,
      lastSaved: Date.now()
    }
  });
}

function buildSessionHtml(label, tabs, tsEntries) {
  tsEntries = tsEntries || [];
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const domainOf2 = url => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; } };
  const validTabs = tabs.filter(t => t.url);
  const windowIds = [...new Set(validTabs.map(t => t.windowId).filter(Boolean))];
  const hasMultiWindow = windowIds.length > 1;

  function tabLink(t) {
    const dom = domainOf2(t.url);
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
      sessHtml += winTabs.map(tabLink).join('');
      wi++;
    }
  } else {
    const allUrls = JSON.stringify(validTabs.map(t => t.url)).replace(/"/g, '&quot;');
    sessHtml = '<div class="restore-bar">'
      + '<button class="restore-btn" data-urls="' + allUrls + '">\u21BA Restore all ' + validTabs.length + ' tabs</button>'
      + '</div>';
    sessHtml += validTabs.map(tabLink).join('');
  }

  const tsHtml = tsEntries.length
    ? '<div class="links">' + tsEntries.map(e => { try { return tabLink(e); } catch(x) { return ''; } }).join('') + '</div>'
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
    + 'function st(n){'
    +   '["sessions","tabstorage"].forEach(function(x){'
    +     'document.getElementById("tab-"+x).classList.toggle("active",x===n);'
    +     'document.getElementById("btn-"+x).classList.toggle("active",x===n);'
    +   '});'
    + '}'
    + 'document.getElementById("btn-sessions").addEventListener("click",function(){st("sessions");});'
    + 'document.getElementById("btn-tabstorage").addEventListener("click",function(){st("tabstorage");});'
    + 'document.querySelectorAll(".restore-btn").forEach(function(btn){'
    +   'btn.addEventListener("click",function(){'
    +     'var u=JSON.parse(btn.getAttribute("data-urls").replace(/&quot;/g,\'"\')); '
    +     'if(!u.length)return;'
    +     'if(u.length>15&&!confirm("Open "+u.length+" tabs?"))return;'
    +     'u.forEach(function(x){window.open(x,"_blank");});'
    +   '});'
    + '});'
    + '})();';

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"/>'
    + '<title>Session \u2013 ' + esc(label) + '</title>'
    + '<style>' + CSS + '</style></head>\n<body>\n'
    + '<div class="page-header">'
    +   '<h1>\uD83D\uDCCB ' + esc(label) + '</h1>'
    +   '<div class="meta">' + validTabs.length + ' tabs \u00B7 Auto-saved ' + new Date().toLocaleString() + '</div>'
    + '</div>\n'
    + '<div class="tabs-nav">'
    +   '<button class="tab-btn active" id="btn-sessions">Sessions</button>'
    +   '<button class="tab-btn" id="btn-tabstorage">Tab Storage</button>'
    + '</div>\n'
    + '<div class="tab-panel active" id="tab-sessions">'
    +   '<div class="links">' + sessHtml + '</div>'
    + '</div>\n'
    + '<div class="tab-panel" id="tab-tabstorage">' + tsHtml + '</div>\n'
    + '<footer>Auto-saved by Extended History</footer>\n'
    + '<script>' + SCRIPT + '<\/script>\n'
    + '</body></html>';
}

// ── Tab activated ─────────────────────────────────────────────────────────────
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (_timeTrackingEnabled) await commitSegment();
  activeTabId = null; activeDomain = null;

  if (!windowFocused || !_timeTrackingEnabled) return;

  try {
    const tab = await browser.tabs.get(tabId);
    if (tab && isTrackable(tab.url)) startSegment(tabId, domainOf(tab.url));
  } catch {}
});

// ── Tab URL changed ───────────────────────────────────────────────────────────
browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (tabId !== activeTabId) return;
  if (!info.url) return;
  if (!isTrackable(info.url)) {
    if (_timeTrackingEnabled) await commitSegment();
    activeDomain = null;
    return;
  }
  if (_timeTrackingEnabled) await commitSegment();
  if (_timeTrackingEnabled) startSegment(tabId, domainOf(info.url));
});

// ── Tab closed ────────────────────────────────────────────────────────────────
browser.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== activeTabId) return;
  if (_timeTrackingEnabled) await commitSegment();
  activeTabId = null; activeDomain = null;
});

// ── Window focus changes ──────────────────────────────────────────────────────
browser.windows.onFocusChanged.addListener(async wid => {
  if (wid === browser.windows.WINDOW_ID_NONE) {
    windowFocused = false;
    if (_timeTrackingEnabled) await commitSegment();
    activeTabId = null; activeDomain = null;
  } else {
    windowFocused = true;
    if (!_timeTrackingEnabled) return;
    try {
      const tabs = await browser.tabs.query({ active: true, windowId: wid });
      const tab = tabs[0];
      if (tab && isTrackable(tab.url)) startSegment(tab.id, domainOf(tab.url));
    } catch {}
  }
});

// ── Storage migration ─────────────────────────────────────────────────────────
const LEGACY_KEYS = [
  ['recall_history',    HISTORY_KEY],
  ['recall_time',       TIME_KEY],
  ['recall_settings',   SETTINGS_KEY],
  ['recall_sessions',   SESSIONS_KEY],
  ['recall_backfilled', BACKFILL_KEY],
];
async function migrateStorage() {
  const m = await browser.storage.local.get('eh_migration_done');
  if (m.eh_migration_done) return;
  const existing = await browser.storage.local.get(LEGACY_KEYS.map(([k]) => k));
  const toSet = {};
  for (const [oldKey, newKey] of LEGACY_KEYS) {
    if (existing[oldKey] !== undefined) {
      const cur = await browser.storage.local.get(newKey);
      if (!cur[newKey] || (Array.isArray(cur[newKey]) && !cur[newKey].length))
        toSet[newKey] = existing[oldKey];
    }
  }
  if (Object.keys(toSet).length) await browser.storage.local.set(toSet);
  await browser.storage.local.set({ eh_migration_done: true });
}

// ── Session tracking ──────────────────────────────────────────────────────────
let sessionId    = null;
let sessionTabs  = {};
let sessionStart = null;

async function saveSessionState() {
  if (!sessionId) return;
  await browser.storage.local.set({ eh_cur_session: { sessionId, sessionStart, sessionTabs } });
}
async function loadSessionState() {
  const r = await browser.storage.local.get('eh_cur_session');
  if (r.eh_cur_session) {
    sessionId    = r.eh_cur_session.sessionId;
    sessionStart = r.eh_cur_session.sessionStart;
    sessionTabs  = r.eh_cur_session.sessionTabs || {};
  }
}
async function clearSessionState() {
  await browser.storage.local.remove('eh_cur_session');
}

let _saveSessionTimer = null;
function debouncedSaveSession() {
  if (_saveSessionTimer) clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    _saveSessionTimer = null;
    saveSessionState().catch(() => {});
  }, 1000);
}

// ── Tab Storage helpers ───────────────────────────────────────────────────────
async function getTabStorage() {
  const r = await browser.storage.local.get(TAB_STORAGE_KEY);
  return r[TAB_STORAGE_KEY] || [];
}
async function removeTabStorageEntry(id) {
  const stored = await getTabStorage();
  const next = stored.filter(e => e.id !== id);
  await browser.storage.local.set({ [TAB_STORAGE_KEY]: next });
  return next;
}

async function getSessions() {
  const r = await browser.storage.local.get(SESSIONS_KEY);
  return r[SESSIONS_KEY] || [];
}
async function getMaxSessions() {
  const r = await browser.storage.local.get('eh_max_sessions');
  return r.eh_max_sessions || MAX_SESSIONS_DEFAULT;
}

async function saveSessions(list) {
  const max = await getMaxSessions();
  if (list.length > max) list = list.slice(-max);
  await browser.storage.local.set({ [SESSIONS_KEY]: list });
}
async function beginSession() {
  sessionId    = `s_${Date.now()}`;
  sessionTabs  = {};
  sessionStart = Date.now();
  try {
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      if (isTrackable(t.url))
        sessionTabs[t.id] = { url: t.url, title: t.title||'', domain: domainOf(t.url), windowId: t.windowId||null, opened: Date.now(), closed: null };
    }
  } catch {}
  await saveSessionState();
}
async function finishSession() {
  if (!sessionId) await loadSessionState();
  if (!sessionId) return;
  const list = await getSessions();
  const tabs = Object.values(sessionTabs).filter(t => t.url && t.closed === null);
  const uniq = new Set(tabs.map(t => t.url));
  if (tabs.length) list.push({ id: sessionId, start: sessionStart, end: Date.now(), tabCount: uniq.size, tabs });
  await saveSessions(list);
  sessionId = null; sessionTabs = {}; sessionStart = null;
  await clearSessionState();
}

browser.tabs.onCreated.addListener(async tab => {
  if (!sessionId || !isTrackable(tab.url)) return;
  sessionTabs[tab.id] = { url: tab.url||'', title: tab.title||'', domain: domainOf(tab.url||''), windowId: tab.windowId||null, opened: Date.now(), closed: null };
  debouncedSaveSession();
});

// ── Title backfill queue ──────────────────────────────────────────────────────
let _titleQueue = Promise.resolve();
function queuedBackfillTitle(url, title) {
  _titleQueue = _titleQueue.then(() => backfillTitle(url, title)).catch(() => {});
}

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // ── Sessions ──
  if (sessionId) {
    if (info.url && isTrackable(info.url)) {
      const prev = sessionTabs[tabId];
      sessionTabs[tabId] = { url: info.url, title: tab.title||'', domain: domainOf(info.url), windowId: tab.windowId||null, opened: prev?.opened||Date.now(), closed: null };
      debouncedSaveSession();
    } else if (info.title && sessionTabs[tabId]) {
      sessionTabs[tabId].title = info.title;
      debouncedSaveSession();
    }
  }

  const _badTitles = ['New Tab', 'Loading\u2026', 'Loading...', ''];
  if (!info.title || _badTitles.includes(info.title) || !tab?.url || !isTrackable(tab.url)) return;
  queuedBackfillTitle(tab.url, info.title);
});

browser.tabs.onRemoved.addListener(async tabId => {
  if (sessionTabs[tabId]) {
    sessionTabs[tabId].closed = Date.now();
    debouncedSaveSession();
  }
});

function ensureContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: CONTEXT_MENU_PARENT_ID,
      title: 'Extended History',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });

    browser.contextMenus.create({
      id: CONTEXT_MENU_IGNORE_DOMAIN_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Don't keep this domain in history",
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });

    browser.contextMenus.create({
      id: CONTEXT_MENU_STORE_TAB_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: 'Store this tab',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const pageUrl = info.pageUrl || info.frameUrl || tab?.url || '';

  if (info.menuItemId === CONTEXT_MENU_IGNORE_DOMAIN_ID) {
    if (!isTrackable(pageUrl)) return;
    const domain = domainOf(pageUrl);
    if (!domain) return;
    const result = await addIgnorePattern(domain);
    if (!result.success && result.error !== 'Pattern already exists') {
      console.warn('[EH] Failed to add ignore pattern from context menu:', result.error);
      return;
    }
    const enabled = await isIgnoreListEnabled();
    if (enabled) {
      await cleanIgnoredFromHistory();
      await cleanupIgnoredUrlFromNativeHistory(pageUrl);
    }
  }

  if (info.menuItemId === CONTEXT_MENU_STORE_TAB_ID) {
    if (!pageUrl) return;
    const stored = await getTabStorage();
    if (!stored.find(e => e.url === pageUrl)) {
      stored.push({
        id: `ts_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        url: pageUrl,
        title: tab?.title || pageUrl,
        domain: domainOf(pageUrl),
        savedAt: Date.now(),
      });
      await browser.storage.local.set({ [TAB_STORAGE_KEY]: stored });
    }
    if (tab?.id) {
      try { await browser.tabs.remove(tab.id); } catch {}
    }
  }
});

// ── Startup / Install ─────────────────────────────────────────────────────────
browser.runtime.onStartup.addListener(async () => {
  ensureContextMenus();
  await migrateStorage();
  const _s0 = await getSettings();
  _timeTrackingEnabled = _s0.timeTrackingEnabled !== false;
  await flushTodayToHistory().catch(() => {});
  await finishSession();
  await beginSession();
  await resumeActiveTab();
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  ensureContextMenus();
  await migrateStorage();
  if (reason === 'install') {
    browser.tabs.create({ url: browser.runtime.getURL('tutorial.html') });
  }
  const _s0 = await getSettings();
  _timeTrackingEnabled = _s0.timeTrackingEnabled !== false;
  await beginSession();
  await resumeActiveTab();

  try {
    const items   = await browser.history.search({ text:'', startTime:0, maxResults:100000 });
    const entries = items.filter(i=>isTrackable(i.url)).map(i=>({
      id:`bf_${i.lastVisitTime}_${Math.random().toString(36).slice(2,6)}`,
      url:normalizeUrl(i.url), rawUrl:i.url, title:i.title||'',
      visitTime:i.lastVisitTime||Date.now(), domain:domainOf(i.url), tabId:null, source:'backfill',
    }));
    const existing    = await getAll();
    const existingSet = new Set(existing.map(e=>`${e.url}|${Math.floor(e.visitTime/5000)}`));
    const newOnes     = entries.filter(e=>!existingSet.has(`${e.url}|${Math.floor(e.visitTime/5000)}`));
    if (newOnes.length) {
      await setAll([...existing,...newOnes].sort((a,b)=>b.visitTime-a.visitTime));
      await updateTodayHistory();
    }
    await browser.storage.local.set({ [BACKFILL_KEY]:true });
  } catch(e) { console.error('[EH] backfill',e); }
});

// ── History storage ───────────────────────────────────────────────────────────
async function getAll() { const r=await browser.storage.local.get(HISTORY_KEY); return r[HISTORY_KEY]||[]; }
async function setAll(e) { await browser.storage.local.set({ [HISTORY_KEY]:e }); }
async function getSettings() { const r=await browser.storage.local.get(SETTINGS_KEY); return {...DEFAULT_SETTINGS,...(r[SETTINGS_KEY]||{})}; }
async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await browser.storage.local.set({ [SETTINGS_KEY]: merged });

  if (newSettings.hasOwnProperty('ignoreListEnabled')) {
    if (newSettings.ignoreListEnabled) {
      await cleanIgnoredFromHistory();
    }
  }
}

// ── Title back-fill ───────────────────────────────────────────────────────────
async function backfillTitle(url, title, _isRetry = false) {
  if (!url || !title || !isTrackable(url)) return;
  if (title === 'New Tab' || title === 'Loading\u2026' || title === 'Loading...') return;
  const norm = normalizeUrl(url);
  const entries = await getAll();
  const now = Date.now();
  let bestIdx = -1, bestTime = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.url !== norm) continue;
    if ((now - e.visitTime) > 300000) continue;
    if (e.visitTime > bestTime) { bestTime = e.visitTime; bestIdx = i; }
  }
  if (bestIdx === -1) {
    if (!_isRetry) setTimeout(() => backfillTitle(url, title, true), 1500);
    return;
  }
  entries[bestIdx].title = title;
  await setAll(entries);
}

function normalizeUrl(url) { try { const u=new URL(url); u.hash=''; return u.toString().replace(/\/$/, ''); } catch { return url; } }

async function recordVisit(url, title, tabId) {
  if (!isTrackable(url)) return;
  if (await shouldIgnoreUrl(url, title)) return;
  const settings = await getSettings();
  const now      = Date.now();
  const syncInterval = typeof settings.syncInterval === 'number' ? settings.syncInterval : 30;

  if (syncInterval > 0) {
    if (title) {
      const cutoff5 = now - 5000;
      const norm = normalizeUrl(url);
      const entries = await getAll();
      // findLastIndex polyfilled above
      const idx = entries.findLastIndex(e => e.url === norm && e.visitTime >= cutoff5);
      if (idx !== -1 && !entries[idx].title) {
        entries[idx].title = title;
        await setAll(entries);
      }
    }
    return;
  }

  const cutoff   = now - settings.retentionDays * 86400000;
  let entries    = await getAll();
  const norm     = normalizeUrl(url);
  const dup      = entries.findIndex(e=>e.url===norm && (now-e.visitTime)<5000);
  if (dup !== -1) { if (title && !entries[dup].title) { entries[dup].title=title; await setAll(entries); } return; }
  entries.push({ id:`${now}_${Math.random().toString(36).slice(2,6)}`, url:norm, rawUrl:url, title:title||'', visitTime:now, domain:domainOf(url), tabId:tabId||null });
  entries = entries.filter(e=>e.visitTime>=cutoff);
  if (entries.length>settings.maxEntries) entries=entries.slice(entries.length-settings.maxEntries);
  await setAll(entries);
}

browser.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
  if (['auto_subframe','manual_subframe'].includes(details.transitionType)) return;
  let title='';
  const url = details.url;
  if (await shouldIgnoreUrl(url)) {
    await cleanupIgnoredUrlFromNativeHistory(url);
    return;
  }
  try { const tab=await browser.tabs.get(details.tabId); title=tab?.title||''; } catch {}
  await recordVisit(details.url, title, details.tabId);
});

browser.webNavigation.onCompleted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
  if (await shouldIgnoreUrl(details.url)) {
    await cleanupIgnoredUrlFromNativeHistory(details.url);
  }
});

browser.webNavigation.onHistoryStateUpdated.addListener(async details => {
  if (details.frameId !== 0 || !isTrackable(details.url)) return;
  if (await shouldIgnoreUrl(details.url)) return;
  await recordVisit(details.url, '', details.tabId);
});

// ── Message API ───────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, _s, respond) => {
  handle(msg).then(respond).catch(err => respond({ error: err.message }));
  return true; // keep channel open for async response
});

async function handle(msg) {
  switch(msg.type) {
    case 'SEARCH': {
      const {query='',mode='all',startDate,endDate,limit=5000,offset=0}=msg;

      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayMs = todayStart.getTime();

      const [todayEntries, allStored] = await Promise.all([
        getTodayFromNativeHistory(),
        getAll(),
      ]);
      const pastEntries = allStored.filter(e => e.visitTime < todayMs);
      let entries = [...todayEntries, ...pastEntries];

      if (startDate) entries=entries.filter(e=>e.visitTime>=startDate);
      if (endDate)   entries=entries.filter(e=>e.visitTime<=endDate);
      if (query) {
        const words=query.toLowerCase().split(/\s+/).filter(Boolean);
        entries=entries.filter(e=>{
          const hay = (mode==='title')  ? (e.title||'').toLowerCase()
                    : (mode==='url')    ? e.url.toLowerCase()
                    : (mode==='domain') ? (e.domain||'').toLowerCase()
                    : (e.url+' '+(e.title||'')+' '+(e.domain||'')).toLowerCase();
          return words.every(w => hay.includes(w));
        });
      }
      entries.sort((a,b)=>b.visitTime-a.visitTime);
      return {total:entries.length,entries:entries.slice(offset,offset+limit)};
    }
    case 'DELETE_IDS': {
      const s = new Set(msg.ids);

      const all = await getAll();
      const removed = all.filter(e => s.has(e.id));
      await setAll(all.filter(e => !s.has(e.id)));

      const urlsToDelete = new Set([
        ...(msg.urls || []),
        ...removed.flatMap(e => [e.url, e.rawUrl]),
      ].filter(Boolean));
      for (const url of urlsToDelete) {
        try { await browser.history.deleteUrl({ url }); } catch {}
      }
      return { success: true };
    }
    case 'DELETE_MATCHING': {
      const {query='',mode='all',startDate,endDate}=msg;
      const q=query.toLowerCase();
      const words=q?q.split(/\s+/).filter(Boolean):[];

      function matchesFilter(e) {
        const ms=!startDate||e.visitTime>=startDate; const me=!endDate||e.visitTime<=endDate;
        let mq=true; if(words.length){
          const hay=(mode==='title')?(e.title||'').toLowerCase()
                   :(mode==='url')?e.url.toLowerCase()
                   :(mode==='domain')?(e.domain||'').toLowerCase()
                   :(e.url+' '+(e.title||'')+' '+(e.domain||'')).toLowerCase();
          mq=words.every(w=>hay.includes(w));
        }
        return ms&&me&&mq;
      }

      const allStored = await getAll();
      const toDelete = allStored.filter(matchesFilter);
      await setAll(allStored.filter(e => !toDelete.find(d => d.id === e.id)));

      const todayLive = await getTodayFromNativeHistory();
      const toDeleteToday = todayLive.filter(matchesFilter);

      const urlsToDelete = new Set(
        [...toDelete, ...toDeleteToday].flatMap(e => [e.url, e.rawUrl]).filter(Boolean)
      );
      for (const url of urlsToDelete) {
        try { await browser.history.deleteUrl({ url }); } catch {}
      }
      return { success: true, deleted: toDelete.length + toDeleteToday.length };
    }
    case 'DELETE_HISTORY_RANGE': {
      const { startTime, endTime, clearCookies, clearCache } = msg;
      let entries = await getAll();
      const before = entries.length;
      entries = entries.filter(e => !(e.visitTime >= startTime && e.visitTime <= endTime));
      await setAll(entries);
      const deleted = before - entries.length;
      try { await browser.history.deleteRange({ startTime, endTime }); } catch {}
      if (clearCookies || clearCache) {
        const since = startTime;
        const dataTypes = {};
        if (clearCookies) { dataTypes.cookies = true; dataTypes.localStorage = true; dataTypes.indexedDB = true; }
        if (clearCache)   { dataTypes.cache = true; dataTypes.cacheStorage = true; }
        try { await browser.browsingData.remove({ since }, dataTypes); } catch {}
      }
      await updateTodayHistory();
      return { success: true, deleted };
    }
    case 'CLEAR_ALL': {
      await setAll([]);
      try { await browser.history.deleteAll(); } catch {}
      await updateTodayHistory();
      return { success: true };
    }
    case 'GET_STATS': {
      const entries=await getAll();
      // Firefox: getBytesInUse is not supported on local storage; estimate from JSON size
      let storageMB = '?';
      try {
        const raw = await browser.storage.local.get(HISTORY_KEY);
        const bytes = new TextEncoder().encode(JSON.stringify(raw)).length;
        storageMB = (bytes / 1048576).toFixed(1);
      } catch {}
      const oldest=entries.length?Math.min(...entries.map(e=>e.visitTime)):null;
      const now=Date.now(); const daily={};
      for(let i=89;i>=0;i--) daily[new Date(now-i*86400000).toLocaleDateString('en-CA')]=0;
      for(const e of entries){const d=new Date(e.visitTime).toLocaleDateString('en-CA'); if(d in daily) daily[d]++;}
      return {totalEntries:entries.length,storageMB,oldestEntry:oldest,dailyActivity:daily};
    }
    case 'GET_TIME_DATA': {
      const {days=30}=msg; const r=await browser.storage.local.get(TIME_KEY); const map=r[TIME_KEY]||{};
      const now=Date.now(); const dateSet=new Set();
      for(let i=0;i<days;i++) dateSet.add(new Date(now-i*86400000).toLocaleDateString('en-CA'));
      const totals={};
      for(const [domain,dayMap] of Object.entries(map)){
        let t=0; for(const [date,ms] of Object.entries(dayMap)){if(dateSet.has(date)) t+=ms;} if(t>0) totals[domain]=t;
      }
      const sorted=Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,20)
      .map(([domain,ms])=>({domain,ms,minutes:Math.round(ms/60000),hours:(ms/3600000).toFixed(1)}));
      const dailyMap={};
      for(const [domain,dayMap] of Object.entries(map)){
        for(const [date,ms] of Object.entries(dayMap)){
          if(!dateSet.has(date)) continue;
          if(!dailyMap[date]) dailyMap[date]={};
          dailyMap[date][domain]=(dailyMap[date][domain]||0)+ms;
        }
      }
      return {topSites:sorted,dailyMap};
    }
    case 'GET_DEVICES': {
      // browser.sessions.getDevices() exists in Firefox
      try { return {devices: await browser.sessions.getDevices()}; } catch { return {devices:[]}; }
    }
    case 'GET_TODAY_HISTORY': {
      const liveEntries = await getTodayFromNativeHistory();
      if (liveEntries.length) return { entries: liveEntries };
      const r = await browser.storage.local.get(TODAY_HISTORY_KEY);
      return { entries: r[TODAY_HISTORY_KEY] || [] };
    }
    case 'GET_CURRENT_SESSION': {
      const r = await browser.storage.local.get(CURRENT_SESSION_KEY);
      return { session: r[CURRENT_SESSION_KEY] || null };
    }
    case 'GET_SESSIONS': {
      const list=await getSessions();
      const maxSess=await getMaxSessions();
      return {sessions:list.slice().reverse(),current:sessionId?{id:sessionId,start:sessionStart,tabs:Object.values(sessionTabs).filter(t=>t.url&&t.closed===null)}:null,maxSessions:maxSess};
    }
    case 'GET_TAB_STORAGE': {
      return { entries: await getTabStorage() };
    }
    case 'REMOVE_TAB_STORAGE_ENTRY': {
      const next = await removeTabStorageEntry(msg.id);
      return { success: true, entries: next };
    }
    case 'REMOVE_TAB_STORAGE_ENTRIES': {
      const { ids } = msg;
      const r = await browser.storage.local.get('eh_tab_storage');
      const list = (r['eh_tab_storage'] || []).filter(e => !ids.includes(e.id));
      await browser.storage.local.set({ 'eh_tab_storage': list });
      return { success: true, entries: list };
    }
    case 'CLEAR_TAB_STORAGE': {
      await browser.storage.local.set({ [TAB_STORAGE_KEY]: [] });
      return { success: true };
    }
    case 'SET_MAX_SESSIONS': {
      const val = Math.max(1, Math.min(20, parseInt(msg.value) || MAX_SESSIONS_DEFAULT));
      await browser.storage.local.set({ eh_max_sessions: val });
      const list = await getSessions();
      if (list.length > val) await browser.storage.local.set({ [SESSIONS_KEY]: list.slice(-val) });
      return { success: true, value: val };
    }
    case 'SET_AUTO_SAVE_INTERVAL': {
      const mins = parseInt(msg.minutes) || 0;
      const safe = mins === 0 ? 0 : Math.max(1, Math.min(1440, mins));
      await browser.storage.local.set({ [AUTO_SAVE_KEY]: safe });
      _lastAutoSave = 0;
      return { success: true, minutes: safe };
    }
    case 'GET_SYNC_INTERVAL': {
      return { minutes: await getSyncInterval() };
    }
    case 'SET_SYNC_INTERVAL': {
      const mins = parseInt(msg.minutes);
      const safe = isNaN(mins) ? 30 : Math.max(0, Math.min(1440, mins));
      await saveSettings({ syncInterval: safe });
      _lastFlush = 0;
      return { success: true, minutes: safe };
    }
    case 'FORCE_FLUSH': {
      await flushTodayToHistory();
      return { success: true };
    }
    case 'GET_AUTO_SAVE_INTERVAL': {
      return { minutes: await getAutoSaveInterval() };
    }
    case 'TRIGGER_AUTO_SAVE': {
      await doAutoSaveSession();
      return { success: true };
    }
    case 'RESTORE_SESSION': {
      const { tabs } = msg;
      if (!Array.isArray(tabs)) return { success: false };
      for (const t of tabs) {
        if (t.url && isTrackable(t.url)) {
          try { await browser.tabs.create({ url: t.url, active: false }); } catch {}
        }
      }
      return { success: true };
    }
    case 'GET_SETTINGS': { return await getSettings(); }
    case 'SAVE_SETTINGS': {
      const cur=await getSettings();
      const next={...cur,...msg.settings};
      await browser.storage.local.set({[SETTINGS_KEY]:next});
      if (next.timeTrackingEnabled !== undefined) _timeTrackingEnabled = next.timeTrackingEnabled !== false;
      return {success:true,settings:next};
    }
    case 'EXPORT': {
      const entries=await getAll(); const tr=await browser.storage.local.get(TIME_KEY); const sess=await getSessions();
      return {exportedAt:new Date().toISOString(),totalEntries:entries.length,entries,timeData:tr[TIME_KEY]||{},sessions:sess};
    }
    case 'IMPORT_HISTORY': {
      const {entries:imported}=msg;
      if(!Array.isArray(imported)||!imported.length) return {success:false,error:'No entries'};
      const existing=await getAll(); const settings=await getSettings();
      const cutoff=Date.now()-settings.retentionDays*86400000;
      const existingSet=new Set(existing.map(e=>`${e.url}|${Math.floor(e.visitTime/5000)}`));
      let count=0;
      for(const e of imported){
        if(!e.url||!isTrackable(e.url)) continue;
        if(e.visitTime&&e.visitTime<cutoff) continue;
        const norm=normalizeUrl(e.url); const key=`${norm}|${Math.floor((e.visitTime||Date.now())/5000)}`;
        if(existingSet.has(key)) continue;
        existing.push({id:`imp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,url:norm,rawUrl:e.url,title:e.title||'',visitTime:e.visitTime||Date.now(),domain:domainOf(e.url),tabId:null,source:'import'});
        existingSet.add(key); count++;
      }
      existing.sort((a,b)=>b.visitTime-a.visitTime); await setAll(existing);
      await updateTodayHistory();

      try {
        const allEntries = await getAll();
        const domainCounts = {};
        for (const e of allEntries) {
          const d = e.domain || domainOf(e.url);
          if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
        }
        const topDomains = Object.entries(domainCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([domain]) => domain);

        if (topDomains.length) {
          const tree = await browser.bookmarks.getTree();
          function findFolder(nodes, title) {
            for (const n of nodes) {
              if (!n.url && n.title === title) return n;
              if (n.children) { const f = findFolder(n.children, title); if (f) return f; }
            }
            return null;
          }
          let folder = findFolder(tree, 'Extended History');
          if (!folder) {
            const parentId = tree[0]?.children?.[0]?.id || '1';
            folder = await browser.bookmarks.create({ parentId, title: 'Extended History' });
          }

          const folderChildren = await browser.bookmarks.getChildren(folder.id);
          const existingUrls = new Set(folderChildren.map(c => c.url).filter(Boolean));

          for (const domain of topDomains) {
            const url = `https://${domain}`;
            if (!existingUrls.has(url)) {
              try {
                await browser.bookmarks.create({ parentId: folder.id, title: domain, url });
                existingUrls.add(url);
              } catch {}
            }
          }
        }
      } catch {}

      return {success:true,imported:count};
    }
    case 'RE_BACKFILL': {
      try {
        await browser.storage.local.remove(BACKFILL_KEY);
        const items = await browser.history.search({ text: '', startTime: 0, maxResults: 100000 });
        const entries = items.filter(i => isTrackable(i.url)).map(i => ({
          id:        `bf_${i.lastVisitTime}_${Math.random().toString(36).slice(2, 6)}`,
          url:       normalizeUrl(i.url),
          rawUrl:    i.url,
          title:     i.title || '',
          visitTime: i.lastVisitTime || Date.now(),
          domain:    domainOf(i.url),
          tabId:     null,
          source:    'backfill',
        }));
        const existing    = await getAll();
        const existingSet = new Set(existing.map(e => `${e.url}|${Math.floor(e.visitTime / 5000)}`));
        const newOnes     = entries.filter(e => !existingSet.has(`${e.url}|${Math.floor(e.visitTime / 5000)}`));
        if (newOnes.length) await setAll([...existing, ...newOnes].sort((a, b) => b.visitTime - a.visitTime));
        await browser.storage.local.set({ [BACKFILL_KEY]: true });
        await updateTodayHistory();
        return { success: true, imported: newOnes.length };
      } catch (e) { return { error: e.message }; }
    }
    case 'GET_BOOKMARKS': { try{return {tree:await browser.bookmarks.getTree()};}catch{return {tree:[]};} }
    case 'MOVE_BOOKMARK': {
      try {
        await browser.bookmarks.move(msg.id, { parentId: msg.parentId });
        return { success: true };
      } catch(e) { return { error: e.message }; }
    }
    case 'DELETE_BOOKMARK': {
      try {
        await browser.bookmarks.removeTree(msg.id);
        return { success: true };
      } catch(e) { return { error: e.message }; }
    }
    case 'RENAME_BOOKMARK': {
      try {
        await browser.bookmarks.update(msg.id, { title: msg.title });
        return { success: true };
      } catch(e) { return { error: e.message }; }
    }
    case 'CREATE_BOOKMARK_FOLDER': {
      try {
        const folder = await browser.bookmarks.create({ parentId: msg.parentId, title: msg.title });
        return { success: true, id: folder.id };
      } catch(e) { return { error: e.message }; }
    }
    case 'IMPORT_BOOKMARKS': {
      const {bookmarks}=msg; let imported=0;
      for(const bm of (bookmarks||[])) if(bm.url){try{await browser.bookmarks.create({title:bm.title||bm.url,url:bm.url});imported++;}catch{}}
      return {success:true,imported};
    }
    case 'OPEN_INCOGNITO': {
      // Firefox uses "private" not "incognito" for window type
      try { await browser.windows.create({ url: msg.url, incognito: true }); } catch {}
      return { success: true };
    }
    case 'GET_IGNORE_LIST': {
      return { list: await getIgnoreList(), enabled: await isIgnoreListEnabled() };
    }
    case 'ADD_IGNORE_PATTERN': {
      const result = await addIgnorePattern(msg.pattern);
      if (!result.success) return result;
      const enabled = await isIgnoreListEnabled();
      if (enabled) {
        cleanIgnoredFromHistory().catch(() => {});
      }
      return result;
    }
    case 'SET_IGNORE_LIST': {
      const { list } = msg;
      await setIgnoreList(list || []);
      return { success: true };
    }
    case 'REMOVE_IGNORE_PATTERN': {
      const { pattern } = msg;
      const cleanPattern = normalizeIgnorePattern(pattern);
      let list = await getIgnoreList();
      list = list.filter(p => p !== cleanPattern);
      await setIgnoreList(list);
      return { success: true };
    }
    case 'CLEAN_IGNORED_HISTORY': {
      const res = await cleanIgnoredFromHistory();
      return { success: true, removed: res.removed || 0 };
    }
    case 'TOGGLE_IGNORE_LIST': {
      const settings = await getSettings();
      const newEnabled = !settings.ignoreListEnabled;
      await saveSettings({ ignoreListEnabled: newEnabled });
      return { success: true, enabled: newEnabled };
    }
    case 'FLUSH_TIME': {
      if (activeDomain && segmentStart && windowFocused) {
        await commitSegment();
        segmentStart = Date.now();
      }
      return {success:true};
    }
    case 'CLEAR_TIME_DATA': {
      await browser.storage.local.remove(TIME_KEY);
      return {success:true};
    }
    case 'GET_MOST_VISITED': {
      const {viewType='url',period='all'}=msg;
      const entries=await getAll();
      const now=Date.now();
      let cutoffTime=0;
      if(period==='10') cutoffTime=now-10*86400000;
      else if(period==='30') cutoffTime=now-30*86400000;

      const filtered=period==='all'?entries:entries.filter(e=>e.visitTime>=cutoffTime);
      const counts={};

      for(const e of filtered){
        let key;
        if(viewType==='domain'){
          try{key=new URL(e.url).hostname.replace(/^www\./,'');}catch{continue;}
        }else{
          key=e.url;
        }
        if(!counts[key]){
          counts[key]={identifier:key,count:0,title:viewType==='url'?e.title:key};
        }
        counts[key].count++;
      }

      const sorted=Object.values(counts).sort((a,b)=>b.count-a.count).slice(0,50);
      return {items:sorted};
    }
    default: return {error:`Unknown: ${msg.type}`};
  }
}

// NOTE: browser.runtime.onMessageExternal is not supported in Firefox MV2.
// Cross-extension messaging is intentionally omitted in this port.
