/**
 * Extended History — background.js v3.3
 * Time tracking: purely event-driven per-tab, domain-bucketed by day.
 */
if (typeof importScripts === 'function') {
  importScripts('eh-idb.js');
}
const IDB_STORAGE_KEY = 'eh_use_idb';
const HISTORY_KEY  = 'eh_history';
const TODAY_HISTORY_KEY = 'eh_today_history';  // Separate storage for today's history
const TIME_KEY     = 'eh_time';
const SETTINGS_KEY = 'eh_settings';
const SESSIONS_KEY = 'eh_sessions';
const BACKFILL_KEY = 'eh_backfilled';
const CURRENT_SESSION_KEY = 'eh_current_session'; // Single current session (overwritten)
const IGNORE_LIST_KEY = 'eh_ignore_list'; // List of URL patterns to ignore
const QUICK_FILTERS_KEY = 'eh_quick_filters'; // Named saved filters: [{id,name,patterns:[]}]
const SYNC_INTERVAL_KEY = 'eh_sync_interval'; // Minutes between today→history flushes
const CONTEXT_MENU_PARENT_ID        = 'eh_options';
const CONTEXT_MENU_IGNORE_DOMAIN_ID = 'eh_ignore_domain';
const CONTEXT_MENU_STORE_TAB_ID     = 'eh_store_tab';
const TAB_STORAGE_KEY               = 'eh_tab_storage';
const FAV_CACHE_KEY                 = 'eh_fav_cache'; // domain → dataURL

const MAX_SESSIONS_DEFAULT = 4;

const DEFAULT_SETTINGS = {
  retentionDays: 365,
  maxEntries:    2000000,
  accentColor:   '#3b9eff',
  accentColor2:  '#2dd4a0',
  font:          'system-ui',
  fontSize:      15,
  theme:         'dark',
  language:      'en', // Default language
  ignoreListEnabled: true, // Toggle for ignore list
  syncInterval: 30,        // Minutes between flushing today's browser history → local storage (0 = every visit)
  timeTrackingEnabled: true, // Whether to track time spent per domain
  autoStoreEnabled: false,   // Auto-store tabs idle for too long
  autoStoreHours: 6,         // Hours of no focus before a tab is auto-stored
  toolbarIcon: 'default',    // Toolbar icon variant: default|bw|emerald|green|gold|pink|red
  contextMenuEnabled: true,  // Whether right-click context menu shows on web pages
  datePillsWheelScroll: false, // Let a vertical mouse wheel scroll the horizontal date-pill bar
  datePillsWheelSensitivity: 1, // Days moved per wheel "click" (1-6) when the above is enabled
  popupAsSidebar: false,     // Open Extended History in Firefox's sidebar instead of the popup
  autoExportIntervalMonths: 0, // 0 = disabled. When set (e.g. 4), auto-exports+deletes the oldest
                                // block of history once it's built up beyond the retained window.
  autoExportLastRunAt: 0,      // timestamp of the last successful auto-export (informational)
};

// Auto-export always keeps this many months of the most recent history untouched,
// no matter what interval the user picks.
const AUTO_EXPORT_RETAIN_MONTHS = 3;
const MS_PER_MONTH = 30 * 86400000; // approximate month, consistent with the rest of the codebase

// ── Toolbar icon variants ────────────────────────────────────────────────────
const TOOLBAR_ICON_FILES = {
  default: 'icons/icon16.png',
  bw:      'icons/icon_bw.png',
  emerald: 'icons/icon_emerlad.png',
  green:   'icons/icon_green.png',
  gold:    'icons/icon_gold.png',
  pink:    'icons/icon_pink.png',
  red:     'icons/icon_red.png',
};
function applyToolbarIcon(variant) {
  const file = TOOLBAR_ICON_FILES[variant] || TOOLBAR_ICON_FILES.default;
  try {
    browser.browserAction.setIcon({ path: file });
  } catch (e) { console.warn('[EH] setIcon failed:', e); }
}

// ── Popup / Sidebar mode ─────────────────────────────────────────────────────
// When "Use as sidebar" is enabled, clear the browserAction's default popup so
// clicking the toolbar icon fires onClicked instead — which we use to open the
// Firefox sidebar (a full-height panel) rather than the small dropdown popup.
function applyPopupMode(sidebarMode) {
  try {
    browser.browserAction.setPopup({ popup: sidebarMode ? '' : 'popup.html' });
  } catch (e) { console.warn('[EH] setPopup failed:', e); }
}

browser.browserAction.onClicked.addListener(async () => {
  // Only fires when default_popup has been cleared (sidebar mode is on).
  // sidebarAction.toggle() opens it if closed, closes it if already open —
  // so clicking the icon again closes the sidebar.
  try {
    if (browser.sidebarAction && browser.sidebarAction.toggle) {
      await browser.sidebarAction.toggle();
    } else if (browser.sidebarAction && browser.sidebarAction.open) {
      // Fallback for older Firefox versions without toggle()
      await browser.sidebarAction.open();
    }
  } catch (e) { console.warn('[EH] sidebarAction.toggle failed:', e); }
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function todayKey() { return new Date().toLocaleDateString('en-CA'); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isTrackable(url) {
  if (!url) return false;
  return !['browser://','browser-extension://','about:','data:','javascript:','moz-extension://','edge://','brave://'].some(p => url.startsWith(p));
}

// ── Ignore List ──────────────────────────────────────────────────────────────
function normalizeIgnorePattern(pattern) {
  if (typeof pattern !== 'string') return '';
  let out = pattern.trim();
  if (!out) return '';
  // Already normalized keyword — return as-is
  if (out.startsWith('kw:')) return out;
  out = out.replace(/^['"`]+|['"`]+$/g, ''); // allow users to paste quoted values
  // If no dot (and no slash after stripping protocol), treat as keyword
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
  return list
    .map(normalizeIgnorePattern)
    .filter(Boolean);
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
// Check if ignore list is enabled
async function isIgnoreListEnabled() {
  const r = await browser.storage.local.get(SETTINGS_KEY);
  const settings = r[SETTINGS_KEY] || DEFAULT_SETTINGS;
  return settings.ignoreListEnabled !== false; // Default to true if not set
}
// Check if URL matches any ignore pattern
function matchesIgnorePattern(url, pattern, title) {
  try {
    // Keyword pattern: matches URL string or page title
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

// Ignore cleanup needs retries because some sites commit through redirect chains
// and native history records may appear slightly after onCommitted.
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

// Clean all ignored URLs from history
async function cleanIgnoredFromHistory() {
  const enabled = await isIgnoreListEnabled();
  if (!enabled) return { removed: 0 };
  const ignoreList = await getIgnoreList();
  if (!ignoreList.length) return { removed: 0 };
  
  let entries = await getAll();
  
  // Filter out ignored entries
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
    
    // Also remove from browser native history
    for (const e of toDelete) {
      try { await browser.history.deleteUrl({ url: e.url }); } catch {}
    }
  }
  
  return { removed: toDelete.length };
}

// ── Time tracking ─────────────────────────────────────────────────────────────
//
// Tracks the currently active tab in the focused window.
// SW restarts from scratch after idle — self-heals within 30s via alarm.

let activeTabId    = null;
let activeDomain   = null;
let segmentStart   = null;
let windowFocused  = true; // corrected by resumeActiveTab
let _timeTrackingEnabled = true; // cached in-memory, updated on SAVE_SETTINGS
let _autoStoreEnabled = false;   // cached in-memory, updated on SAVE_SETTINGS
let _autoStoreHours   = 6;       // cached in-memory, updated on SAVE_SETTINGS

async function commitSegment() {
  if (!activeDomain || !segmentStart || !windowFocused) {
    segmentStart = null;
    return;
  }
  if (!_timeTrackingEnabled) { segmentStart = null; return; }
  const now = Date.now();
  const ms  = now - segmentStart;
  segmentStart = null; // clear immediately to prevent double-commit

  if (ms < 1000 || ms > 7_200_000) return;

  // Cap at today's elapsed time (don't bleed across midnight)
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const sinceDay = now - midnight.getTime();
  const capped   = Math.min(ms, sinceDay);
  if (capped < 1000) return;

  await addTime(activeDomain, capped);
}

function startSegment(tabId, domain) {
  activeTabId  = tabId;
  activeDomain = domain;
  // segmentStart stays null if tracking is disabled; commitSegment checks too
  segmentStart = Date.now();
}

// Called on startup/install to pick up wherever we are
async function resumeActiveTab() {
  try {
    const wins = await browser.windows.getAll({ populate: false });
    const focused = wins.find(w => w.focused);
    if (!focused) { windowFocused = false; return; }
    windowFocused = true;
    const [tab] = await browser.tabs.query({ active: true, windowId: focused.id });
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

// Safety-net alarm every 30s:
// - segment running → commit + restart
// - no segment (e.g. after SW restart) → resumeActiveTab to self-heal
// - save current session (overwrite, not append)
browser.alarms.create('eh_tick', { periodInMinutes: 0.5 });
// Flush alarm: fire every minute; actual flush only runs when syncInterval has elapsed
browser.alarms.create('eh_flush', { periodInMinutes: 1 });
// Auto-export check: cheap to run, only does real work once enough backlog has built up
browser.alarms.create('eh_auto_export_check', { periodInMinutes: 60 });

const AUTO_SAVE_KEY = 'eh_auto_save_interval'; // minutes, 0 = disabled
let _lastAutoSave   = 0; // timestamp of last auto-save
let _lastSessionSave = 0; // timestamp of last session save

// ── Live history fetch: read straight from browser API (no per-visit storage writes) ──
// Returns entries in the same shape as eh_history entries. Shared by the
// calendar-day "today" fetch and the rolling-24h popup fetch below.
async function _liveHistoryEntries(searchParams) {
  try {
    const items = await browser.history.search({
      text: '',
      maxResults: 10000,
      ...searchParams,
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

// Calendar-day "today" (midnight → now). Used by the sidebar's Recent History
// day-nav "Today" view, and by flushTodayToHistory() for merging into eh_history.
async function getTodayFrombrowserApi() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return _liveHistoryEntries({ startTime: todayStart.getTime() });
}

// Rolling last-24h window. Used by the (non-sidebar) popup's Recent History —
// omitting startTime lets browser.history.search() apply its own default
// window (last 24 hours) instead of a calendar-day cutoff.
async function getRecentFromBrowserApi() {
  return _liveHistoryEntries({});
}

// Legacy no-op shim — callers that still call updateTodayHistory() are safe.
// Today's data is now served live from browser API; we don't need to cache it.
async function updateTodayHistory() {
  // No-op: today's history is read live via getTodayFrombrowserApi().
  // The periodic flush (flushTodayToHistory) handles persisting to eh_history.
}

// ── Periodic flush: merge today's browser history into eh_history ──────────────
// Runs every `syncInterval` minutes (default 30). Pulls all of today's visits
// from the browser history API and merges them into local storage, deduplicating
// by (normalizedUrl, 5-second bucket). This replaces per-visit storage writes.
let _lastFlush = 0;

async function flushTodayToHistory() {
  const settings = await getSettings();
  const now = Date.now();
  const cutoff = now - settings.retentionDays * 86400000;

  const todayEntries = await getTodayFrombrowserApi();
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

  // Apply retention/max cap then save
  existing = existing.filter(e => e.visitTime >= cutoff);
  if (existing.length > settings.maxEntries) existing = existing.slice(existing.length - settings.maxEntries);
  existing.sort((a, b) => b.visitTime - a.visitTime);
  await setAll(existing);
  _lastFlush = now;
  //console.log(`[EH] Flushed ${added} new entries from today into history`);
}

async function getSyncInterval() {
  const settings = await getSettings();
  return typeof settings.syncInterval === 'number' ? settings.syncInterval : 30;
}

// Removes entries matching any id in idSet. Used by auto-export to drop the
// exported block from the extension's own storage (native browser history is
// never touched here — see checkAutoExport() below for why).
async function removeEntries(idSet) {
  const all = await getAll();
  const toRemove = all.filter(e => idSet.has(e.id));
  if (!toRemove.length) return { removed: [] };
  await setAll(all.filter(e => !idSet.has(e.id)));
  return { removed: toRemove };
}

// Stack-safe replacement for Math.min(...arr) — spreading a huge history array
// as call arguments overflows the call stack once it gets into the hundreds of
// thousands of entries.
function oldestVisitTime(entries) {
  let oldest = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const t = entries[i].visitTime;
    if (t < oldest) oldest = t;
  }
  return oldest;
}

// Downloads content by handing it to an open (or briefly-opened) history.html
// tab, which does the actual save via a Blob + <a download> click — same
// mechanism session auto-save uses, so the extension never needs the
// "downloads" permission at all.
async function downloadViaPage(content, filename, mime) {
  const extPageUrl = browser.runtime.getURL('history.html');

  let tabId = null;
  let didOpen = false;
  try {
    const existing = await browser.tabs.query({ url: extPageUrl });
    if (existing.length > 0) {
      tabId = existing[0].id;
    } else {
      const t = await browser.tabs.create({ url: extPageUrl, active: false });
      tabId = t.id;
      didOpen = true;
    }
  } catch (e) {
    console.warn('[EH] downloadViaPage: could not get tab:', e.message);
    return false;
  }

  await new Promise(resolve => {
    if (!didOpen) { resolve(); return; }
    const timeout = setTimeout(resolve, 6000);
    const listener = (msg, sender) => {
      if (msg.type === 'AUTO_SAVE_READY' && sender.tab?.id === tabId) {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    browser.runtime.onMessage.addListener(listener);
  });

  let ok = true;
  try {
    await browser.tabs.sendMessage(tabId, {
      type: 'AUTO_SAVE_DOWNLOAD',
      content,
      mime: mime || 'text/html',
      filename,
    });
  } catch (e) {
    console.warn('[EH] downloadViaPage: send failed:', e.message);
    ok = false;
  }

  if (didOpen) {
    setTimeout(async () => {
      try { await browser.tabs.remove(tabId); } catch {}
    }, 3000);
  }
  return ok;
}

// ── Auto history export ──────────────────────────────────────────────────────
// If the user sets an interval (months), once history has accumulated beyond
// (AUTO_EXPORT_RETAIN_MONTHS + interval) months old, the oldest block — every
// entry older than AUTO_EXPORT_RETAIN_MONTHS — is exported as a .json download
// and then removed from storage (extension storage only — native browser
// history is left alone entirely).
let _autoExportRunning = false;

async function checkAutoExport(force) {
  if (_autoExportRunning) return { skipped: true };
  const settings = await getSettings();
  const interval = Number(settings.autoExportIntervalMonths) || 0;
  if (interval <= 0) return { skipped: true, reason: 'disabled' };

  _autoExportRunning = true;
  try {
    const entries = await getAll();
    if (!entries.length) return { skipped: true, reason: 'empty' };

    const now = Date.now();
    const oldest = oldestVisitTime(entries);
    const retainMs  = AUTO_EXPORT_RETAIN_MONTHS * MS_PER_MONTH;
    const triggerMs = retainMs + interval * MS_PER_MONTH;

    if (!force && (now - oldest) < triggerMs) {
      return { skipped: true, reason: 'not_due', ageMonths: (now - oldest) / MS_PER_MONTH };
    }

    const cutoff = now - retainMs;
    const toExport = entries.filter(e => e.visitTime < cutoff);
    if (!toExport.length) return { skipped: true, reason: 'nothing_past_cutoff' };

    const exportData = {
      exportedAt: new Date(now).toISOString(),
      totalEntries: toExport.length,
      entries: toExport,
      auto: true,
      autoExportIntervalMonths: interval,
    };

    const json = JSON.stringify(exportData, null, 2);
    const filename = `extended-history-auto_${new Date(now).toISOString().slice(0, 10)}.json`;
    const downloaded = await downloadViaPage(json, filename, 'application/json');
    if (!downloaded) return { skipped: true, reason: 'download_failed' };

    // Remove exported entries from the EXTENSION'S OWN storage only — keep
    // only the retained window there. This must NEVER touch native browser
    // history: (1) that's not what auto-export is for — native history is
    // the browser's own rolling window and is left alone entirely; and
    // (2) browser.history.deleteUrl() removes ALL visits to a URL, not just
    // the specific old one being archived, which would also wipe out any
    // more recent (within-retention) visits to the same URL.
    const idsToRemove = new Set(toExport.map(e => e.id));
    await removeEntries(idsToRemove);

    await saveSettings({ autoExportLastRunAt: now });
    return { success: true, exported: toExport.length, filename };
  } finally {
    _autoExportRunning = false;
  }
}

async function getAutoSaveInterval() {
  const r = await browser.storage.local.get(AUTO_SAVE_KEY);
  return r[AUTO_SAVE_KEY] ?? 0;
}

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'eh_auto_export_check') {
    await checkAutoExport().catch(() => {});
    return;
  }
  if (alarm.name === 'eh_flush') {
    const intervalMins = await getSyncInterval();
    // intervalMins === 0 means "flush on every visit" (legacy mode) — skip timer flush
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
  
  // Save current session every 30s (overwrite same storage)
  const now = Date.now();
  if (now - _lastSessionSave >= 30000) { // 30 seconds
    await saveCurrentSession();
    _lastSessionSave = now;
  }
 
  
  // Auto-store idle tabs check (runs every tick ~30s, cheap because most tabs won't qualify)
  await runAutoStore().catch(() => {});
  
  // Only auto-save when browser window is focused — don't interrupt games etc.
  const mins = await getAutoSaveInterval();
  if (mins >= 1 && Date.now() - _lastAutoSave >= mins * 60 * 1000) {
    try {
      const win = await browser.windows.getLastFocused({ populate: false });
      if (win && win.focused) await doAutoSaveSession();
    } catch { /* no window */ }
  }
});

async function doAutoSaveSession() {
  if (!sessionId) await loadSessionState();
  const openTabs = sessionId
    ? Object.values(sessionTabs).filter(t => t.url && t.closed === null)
    : [];
  if (!openTabs.length) return;

  const label    = browser.i18n.getMessage("current_session") + ' – ' + new Date().toLocaleString();
  const tsData   = await browser.storage.local.get('eh_tab_storage');
  const tsEntries = tsData['eh_tab_storage'] || [];
  const htmlBody = buildSessionHtml(label, openTabs, tsEntries);
  const extPageUrl = browser.runtime.getURL('history.html');

  // Check if the history page is already open
  let tabId = null;
  let didOpen = false;
  try {
    const existing = await browser.tabs.query({ url: extPageUrl });
    if (existing.length > 0) {
      tabId = existing[0].id;
    } else {
      // Open it hidden in the background
      const t = await browser.tabs.create({ url: extPageUrl, active: false });
      tabId = t.id;
      didOpen = true;
    }
  } catch (e) {
    console.warn('[EH] auto-save: could not get tab:', e.message);
    return;
  }

  // Wait for the page to signal it's ready (it sends READY ping on load),
  // or fall back to a fixed delay if it was already open
  await new Promise(resolve => {
    if (!didOpen) { resolve(); return; }
    const timeout = setTimeout(resolve, 6000);
    const listener = (msg, sender) => {
      if (msg.type === 'AUTO_SAVE_READY' && sender.tab?.id === tabId) {
        clearTimeout(timeout);
        browser.runtime.onMessage.removeListener(listener);
        resolve();
      }
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

  // Close the tab we opened (leave user's existing tab alone)
  if (didOpen) {
    setTimeout(async () => {
      try { await browser.tabs.remove(tabId); } catch {}
    }, 3000);
  }
}

// Save current session to storage (overwrite same location, don't pile data)
async function saveCurrentSession() {
  if (!sessionId) await loadSessionState();
  const openTabs = sessionId
    ? Object.values(sessionTabs).filter(t => t.url && t.closed === null)
    : [];
  
  if (!openTabs.length) return;
  
  // Save to single storage location, overwriting previous
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
    +     'var u=JSON.parse(btn.getAttribute("data-urls").replace(/&quot;/g,\'"\'));'
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

// ── Tab activated (user switches tabs) ───────────────────────────────────────
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (_timeTrackingEnabled) await commitSegment();
  activeTabId = null; activeDomain = null;
  if (!windowFocused || !_timeTrackingEnabled && !_autoStoreEnabled) return;

  try {
    const tab = await browser.tabs.get(tabId);
    if (tab && isTrackable(tab.url)) {
      startSegment(tabId, domainOf(tab.url));
    }
  } catch {}
});

// ── Tab URL changed (navigation within same tab) ─────────────────────────────
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

// ── Tab closed ───────────────────────────────────────────────────────────────
browser.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== activeTabId) return;
  if (_timeTrackingEnabled) await commitSegment();
  activeTabId = null; activeDomain = null;
});

// ── Window focus changes (alt-tab away / back) ────────────────────────────────
browser.windows.onFocusChanged.addListener(async wid => {
  if (wid === browser.windows.WINDOW_ID_NONE) {
    windowFocused = false;
    if (_timeTrackingEnabled) await commitSegment();
    activeTabId = null; activeDomain = null;
  } else {
    windowFocused = true;
    if (!_timeTrackingEnabled) return;
    try {
      const [tab] = await browser.tabs.query({ active: true, windowId: wid });
      if (tab && isTrackable(tab.url)) startSegment(tab.id, domainOf(tab.url));
    } catch {}
  }
});

// ── Storage migration ────────────────────────────────────────────────────────
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

// ── Session tracking ─────────────────────────────────────────────────────────
let sessionId    = null;
let sessionTabs  = {};
let sessionStart = null;

// Persist current session state so SW restarts don't lose it
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

// Debounced wrapper — coalesces rapid tab open/close events into one write
let _saveSessionTimer = null;
function debouncedSaveSession() {
  if (_saveSessionTimer) clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    _saveSessionTimer = null;
    saveSessionState().catch(() => {});
  }, 1000);
}

// ── Tab Storage helpers ──────────────────────────────────────────────────────
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
// ── Auto-store: idle detection via tabs.Tab.lastAccessed ─────────────────────
// The browser maintains tab.lastAccessed (ms epoch) natively — updated whenever
// a tab is activated or navigated. No manual tracking map is needed, and the
// value survives service-worker restarts automatically.

async function runAutoStore() {
  if (!_autoStoreEnabled) return;
  const thresholdMs = _autoStoreHours * 3600000;
  const now = Date.now();

  let tabs;
  try {
    tabs = await browser.tabs.query({});
  } catch { return; }

  const stored = await getTabStorage();
  const storedUrls = new Set(stored.map(e => e.url));

  const toStore = [];
  for (const tab of tabs) {
    if (!tab.url || !isTrackable(tab.url)) continue;
    if (tab.active) continue; // never auto-store the currently active tab
    const norm = normalizeUrl(tab.url);
    if (storedUrls.has(norm)) continue; // already in tab storage

    // tab.lastAccessed is maintained natively by the browser (ms epoch).
    // Fall back to now so a tab with no recorded access time is never stored
    // immediately — treat it as freshly opened instead.
    const lastAccessed = tab.lastAccessed ?? now;
    if (now - lastAccessed >= thresholdMs) {
      toStore.push({ tab, norm });
    }
  }

  if (!toStore.length) return;

  for (const { tab, norm } of toStore) {
    if (!stored.find(e => e.url === norm)) {
      stored.push({
        id: `ts_auto_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        url: norm,
        title: tab.title || norm,
        domain: domainOf(norm),
        savedAt: Date.now(),
        autoStored: true,
      });
    }
    try { await browser.tabs.remove(tab.id); } catch {}
  }
  await browser.storage.local.set({ [TAB_STORAGE_KEY]: stored });
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
  // Restore persisted state in case SW restarted (sessionId would be null)
  if (!sessionId) await loadSessionState();
  if (!sessionId) return; // truly no session
  const list = await getSessions();
  // Only include tabs still open when the session ended (closed === null)
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
// ── Title backfill queue — serializes concurrent storage writes ───────────────
let _titleQueue = Promise.resolve();
function queuedBackfillTitle(url, title) {
  _titleQueue = _titleQueue.then(() => backfillTitle(url, title)).catch(() => {});
}

// Per-tab debounce timers for title-only updates.
// Notification badges change the title many times per minute (e.g. "(3) Gmail",
// "(4) Gmail" …). We debounce title-only updates so we only write to storage
// once the title has been stable for 5 seconds, keeping CPU near zero.
const _titleDebounceTimers = new Map(); // tabId → timeoutId
const TITLE_DEBOUNCE_MS = 5000;

// Track the last URL we recorded for each tab so we can detect real navigations
// vs pure title changes on the same URL.
const _tabLastUrl = new Map(); // tabId → url

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  // ── Sessions ──
  if (sessionId) {
    if (info.url && isTrackable(info.url)) {
      const prev = sessionTabs[tabId];
      sessionTabs[tabId] = { url: info.url, title: tab.title||'', domain: domainOf(info.url), windowId: tab.windowId||null, opened: prev?.opened||Date.now(), closed: null };
      debouncedSaveSession();
    } else if (info.title && sessionTabs[tabId]) {
      // Don't write to session storage on every title flash — debounce it
      const existing = sessionTabs[tabId];
      if (existing.title !== info.title) {
        existing.title = info.title;
        debouncedSaveSession(); // already debounced at 1 s, so this is fine
      }
    }
  }

  // ── History title back-fill ──
  // Only backfill when info.url is present (real navigation) OR when the title
  // has settled after a debounce delay (avoids hammering storage on notification
  // badge sites that flip the title dozens of times per minute).
  const _badTitles = new Set(['New Tab', 'Loading…', 'Loading...', '']);

  if (!info.title || _badTitles.has(info.title) || !tab?.url || !isTrackable(tab.url)) {
    // Track URL changes even when there's no title update
    if (info.url && isTrackable(info.url)) _tabLastUrl.set(tabId, info.url);
    return;
  }

  const isUrlChange = !!info.url; // browser sets info.url only on real navigations
  if (isUrlChange) {
    // Real navigation: cancel any pending title debounce for this tab and
    // write immediately — the URL changed so the title is definitely fresh.
    const pending = _titleDebounceTimers.get(tabId);
    if (pending) { clearTimeout(pending); _titleDebounceTimers.delete(tabId); }
    _tabLastUrl.set(tabId, info.url);
    queuedBackfillTitle(tab.url, info.title);
  } else {
    // Title-only update on the same URL (notification badge, SPA state, etc.).
    // Debounce: cancel the previous timer and restart. Only write after the
    // title has been stable for TITLE_DEBOUNCE_MS milliseconds.
    const pending = _titleDebounceTimers.get(tabId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      _titleDebounceTimers.delete(tabId);
      if (!tab?.url || !isTrackable(tab.url)) return;
      queuedBackfillTitle(tab.url, info.title);
    }, TITLE_DEBOUNCE_MS);
    _titleDebounceTimers.set(tabId, timer);
  }
});
browser.tabs.onRemoved.addListener(async tabId => {
  // Clean up per-tab title debounce state
  const pending = _titleDebounceTimers.get(tabId);
  if (pending) { clearTimeout(pending); _titleDebounceTimers.delete(tabId); }
  _tabLastUrl.delete(tabId);

  if (sessionTabs[tabId]) {
    sessionTabs[tabId].closed = Date.now();
    debouncedSaveSession();
  }
});

async function ensureContextMenus() {
  const settings = await getSettings();
  if (settings.contextMenuEnabled === false) {
    // User disabled the right-click menu on web pages — just clear it out.
    browser.contextMenus.removeAll();
    return;
  }
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: CONTEXT_MENU_PARENT_ID,
      title: 'Extended History',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (browser.runtime.lastError) console.warn('[EH] context menu parent failed:', browser.runtime.lastError.message); });

    browser.contextMenus.create({
      id: CONTEXT_MENU_IGNORE_DOMAIN_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Don't keep this domain in history",
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (browser.runtime.lastError) console.warn('[EH] ignore menu failed:', browser.runtime.lastError.message); });

    browser.contextMenus.create({
      id: CONTEXT_MENU_STORE_TAB_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: 'Store this tab',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (browser.runtime.lastError) console.warn('[EH] store tab menu failed:', browser.runtime.lastError.message); });
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

// ── Startup / Install ────────────────────────────────────────────────────────
browser.runtime.onStartup.addListener(async () => {
  await ensureContextMenus();
  await migrateStorage();
  const _s0 = await getSettings();
  _timeTrackingEnabled = _s0.timeTrackingEnabled !== false;
  _autoStoreEnabled    = _s0.autoStoreEnabled !== false;
  _autoStoreHours      = typeof _s0.autoStoreHours === 'number' ? _s0.autoStoreHours : 6;
  applyToolbarIcon(_s0.toolbarIcon);
  applyPopupMode(_s0.popupAsSidebar === true);
  // Flush any history from the previous session that wasn't saved by the periodic timer
  // (e.g. user browsed then shut down before the next flush interval ran)
  await flushTodayToHistory().catch(() => {});
  await finishSession();
  await beginSession();
  await resumeActiveTab();
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureContextMenus();
  await migrateStorage();
  if (reason === 'install') {
    browser.tabs.create({ url: browser.runtime.getURL('tutorial.html') });
  }
  const _s0 = await getSettings();
  _timeTrackingEnabled = _s0.timeTrackingEnabled !== false;
  _autoStoreEnabled    = _s0.autoStoreEnabled !== false;
  _autoStoreHours      = typeof _s0.autoStoreHours === 'number' ? _s0.autoStoreHours : 6;
  applyToolbarIcon(_s0.toolbarIcon);
  applyPopupMode(_s0.popupAsSidebar === true);
  await beginSession();
  await resumeActiveTab();
  
  // Always backfill browser history on install/update to ensure we have all history
  // This runs on first install, updates, and reinstalls
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
    //console.log(`[EH] Backfilled ${newOnes.length} entries`);
  } catch(e) { console.error('[EH] backfill',e); }
});

// ── History storage — switches between localStorage and IndexedDB ─────────────
async function _useIdb() {
  const r = await browser.storage.local.get(IDB_STORAGE_KEY);
  return r[IDB_STORAGE_KEY] === true;
}
async function getAll() {
  if (await _useIdb()) return EhIdb.getAll();
  const r = await browser.storage.local.get(HISTORY_KEY);
  return r[HISTORY_KEY] || [];
}
async function setAll(entries) {
  if (await _useIdb()) return EhIdb.setAll(entries);
  await browser.storage.local.set({ [HISTORY_KEY]: entries });
}
async function getSettings() { const r=await browser.storage.local.get(SETTINGS_KEY); return {...DEFAULT_SETTINGS,...(r[SETTINGS_KEY]||{})}; }
async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await browser.storage.local.set({ [SETTINGS_KEY]: merged });
  
  // NEW: If ignore list was just enabled/disabled, clean history immediately if enabled
  if (newSettings.hasOwnProperty('ignoreListEnabled')) {
    if (newSettings.ignoreListEnabled) {
      // Just enabled - clean ignored URLs from history
      await cleanIgnoredFromHistory();
    }
    // If disabled, we don't need to do anything - URLs will just be allowed
  }

  if (newSettings.hasOwnProperty('toolbarIcon')) {
    applyToolbarIcon(merged.toolbarIcon);
  }
  if (newSettings.hasOwnProperty('popupAsSidebar')) {
    applyPopupMode(merged.popupAsSidebar === true);
  }
  if (newSettings.hasOwnProperty('contextMenuEnabled')) {
    await ensureContextMenus();
  }
}
// ── Title back-fill from browser history ──────────────────────────────────────
// browser's own history DB has the correct title for every URL it has seen.
// We query it and write the result into any recent entry that still lacks a title.
// Write title for the most recent entry matching this URL within the last 2 minutes.
// Always overwrites — if tabs.onUpdated fires twice, the second (final) title wins.
// If no entry exists yet (title fired before recordVisit), retry once after 1.5s.
async function backfillTitle(url, title, _isRetry = false) {
  if (!url || !title || !isTrackable(url)) return;
  if (title === 'New Tab' || title === 'Loading…' || title === 'Loading...') return;
  const norm = normalizeUrl(url);
  const entries = await getAll();
  const now = Date.now();
  let bestIdx = -1, bestTime = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.url !== norm) continue;
    if ((now - e.visitTime) > 300000) continue; // 5 min window (was 2 min)
    if (e.visitTime > bestTime) { bestTime = e.visitTime; bestIdx = i; }
  }
  if (bestIdx === -1) {
    // Entry not recorded yet — retry once after 1.5s (covers fast title updates like Google Search)
    if (!_isRetry) setTimeout(() => backfillTitle(url, title, true), 1500);
    return;
  }
  entries[bestIdx].title = title;
  await setAll(entries);
}

function normalizeUrl(url) { try { const u=new URL(url); u.hash=''; return u.toString().replace(/\/$/,''); } catch { return url; } }

async function recordVisit(url, title, tabId) {
  if (!isTrackable(url)) return;
  if (await shouldIgnoreUrl(url, title)) return;
  const settings = await getSettings();
  const now      = Date.now();
  const syncInterval = typeof settings.syncInterval === 'number' ? settings.syncInterval : 30;

  // ── Deferred mode (syncInterval > 0): today's visits are served live from
  //    the browser history API and flushed in bulk on a timer. No per-visit write.
  if (syncInterval > 0) {
    // Still backfill title into existing entries if we have one within 5 min
    if (title) {
      const cutoff5 = now - 5000;
      const norm = normalizeUrl(url);
      const entries = await getAll();
      const idx = entries.findLastIndex(e => e.url === norm && e.visitTime >= cutoff5);
      if (idx !== -1 && !entries[idx].title) {
        entries[idx].title = title;
        await setAll(entries);
      }
    }
    return;
  }

  // ── Legacy mode (syncInterval === 0): write every visit immediately ──────
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
  // Check ignore list FIRST - before browser commits to history
  if (await shouldIgnoreUrl(url)) {
    await cleanupIgnoredUrlFromNativeHistory(url);
    return; // Don't record in extension
  }
  try { const tab=await browser.tabs.get(details.tabId); title=tab?.title||''; } catch {}
  await recordVisit(details.url, title, details.tabId);
});

browser.webNavigation.onCompleted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
  if (await shouldIgnoreUrl(details.url)) {
    await cleanupIgnoredUrlFromNativeHistory(details.url);
  }
  // Title back-fill is handled by tabs.onUpdated — no timer needed here.
});

// ── SPA / pushState navigation (YouTube, etc.) ──────────────────────────────
// onCommitted doesn't fire for history.pushState — use onHistoryStateUpdated.
browser.webNavigation.onHistoryStateUpdated.addListener(async details => {
  if (details.frameId !== 0 || !isTrackable(details.url)) return;
  if (await shouldIgnoreUrl(details.url)) return;
  await recordVisit(details.url, '', details.tabId);
  // Title will arrive via tabs.onUpdated
});

// ── Message API ──────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg,_s,respond)=>{ handle(msg).then(respond).catch(err=>respond({error:err.message})); return true; });

async function handle(msg) {
  switch(msg.type) {
    case 'SEARCH': {
      const {query='',mode='all',startDate,endDate,limit=5000,offset=0}=msg;

      // Split source: today live from browser API, past days from local storage.
      // This ensures today's entries are always current (no per-visit storage writes)
      // while older history is served from the fast local store.
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayMs = todayStart.getTime();

      const [todayEntries, allStored] = await Promise.all([
        getTodayFrombrowserApi(),
        getAll(),
      ]);
      // Only keep past days from local storage — today comes from browser API
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

      // 1. Remove from local storage
      const all = await getAll();
      const removed = all.filter(e => s.has(e.id));
      await setAll(all.filter(e => !s.has(e.id)));

      // 2. Delete from browser history — every URL variant we know about:
      //    - urls passed directly from the UI (covers today's live entries)
      //    - url + rawUrl from local storage entries
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

      // 1. Remove matching entries from local storage
      const allStored = await getAll();
      const toDelete = allStored.filter(matchesFilter);
      await setAll(allStored.filter(e => !toDelete.find(d => d.id === e.id)));

      // 2. Also match today's live entries from browser API
      const todayLive = await getTodayFrombrowserApi();
      const toDeleteToday = todayLive.filter(matchesFilter);

      // 3. Delete every URL variant from browser history (covers both past + today)
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
      // Delete from extension storage
      let entries = await getAll();
      const before = entries.length;
      entries = entries.filter(e => !(e.visitTime >= startTime && e.visitTime <= endTime));
      await setAll(entries);
      const deleted = before - entries.length;
      // Delete from browser native history
      try { await browser.history.deleteRange({ startTime, endTime }); } catch {}
      // Optionally clear cookies and cache
      if (clearCookies || clearCache) {
        const since = startTime;
        const dataTypes = {};
        if (clearCookies) { dataTypes.cookies = true; dataTypes.localStorage = true; dataTypes.indexedDB = true; }
        if (clearCache)   { dataTypes.cache = true; dataTypes.cacheStorage = true; }
        try { await browser.browsingData.remove({ since }, dataTypes); } catch {}
      }
      // Update today's history
      await updateTodayHistory();
      return { success: true, deleted };
    }
    case 'CLEAR_ALL': {
      await setAll([]);
      try { await browser.history.deleteAll(); } catch {}
      // Update today's history
      await updateTodayHistory();
      return { success: true };
    }
    case 'GET_STATS': {
      const entries=await getAll(); const used=await browser.storage.local.getBytesInUse(HISTORY_KEY);
      const oldest = entries.length ? entries.reduce((min, e) => e.visitTime < min ? e.visitTime : min, entries[0].visitTime) : null;
      const now=Date.now(); const daily={};
      for(let i=89;i>=0;i--) daily[new Date(now-i*86400000).toLocaleDateString('en-CA')]=0;
      for(const e of entries){const d=new Date(e.visitTime).toLocaleDateString('en-CA'); if(d in daily) daily[d]++;}
      return {totalEntries:entries.length,storageMB:(used/1048576).toFixed(1),oldestEntry:oldest,dailyActivity:daily};
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
    case 'GET_DEVICES': { try{return {devices:await browser.sessions.getDevices()};}catch{return {devices:[]};} }
    case 'GET_TODAY_HISTORY': {
      // Serve today's history live from browser API — no storage read needed.
      // Falls back to eh_today_history in storage if browser API fails.
      const liveEntries = await getTodayFrombrowserApi();
      if (liveEntries.length) return { entries: liveEntries };
      const r = await browser.storage.local.get(TODAY_HISTORY_KEY);
      return { entries: r[TODAY_HISTORY_KEY] || [] };
    }
    case 'GET_RECENT_HISTORY': {
      // Popup's Recent History (non-sidebar): plain browser.history.search()
      // with no startTime, i.e. the browser's own rolling ~24h window,
      // rather than a calendar-day cutoff.
      const liveEntries = await getRecentFromBrowserApi();
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
    case 'GET_FAVICON_CACHED': {
      // Returns a cached dataURL for the domain, or fetches+caches it from Google
      const { domain } = msg;
      if (!domain) return { dataUrl: null };
      const store = (await browser.storage.local.get(FAV_CACHE_KEY))[FAV_CACHE_KEY] || {};
      if (store[domain]) return { dataUrl: store[domain], cached: true };
      // Fetch from Google favicon service and convert to base64 data URL
      try {
        const googleUrl = `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(domain)}`;
        const resp = await fetch(googleUrl);
        if (!resp.ok) return { dataUrl: null };
        const buf = await resp.arrayBuffer();
        const mime = resp.headers.get('content-type') || 'image/png';
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const dataUrl = `data:${mime};base64,${b64}`;
        // Persist — cap store at 2000 domains to avoid storage bloat
        const keys = Object.keys(store);
        if (keys.length >= 2000) {
          // Evict oldest 200 entries (first inserted)
          keys.slice(0, 200).forEach(k => delete store[k]);
        }
        store[domain] = dataUrl;
        await browser.storage.local.set({ [FAV_CACHE_KEY]: store });
        return { dataUrl, cached: false };
      } catch { return { dataUrl: null }; }
    }
    case 'CLEAR_FAV_CACHE': {
      await browser.storage.local.remove(FAV_CACHE_KEY);
      return { success: true };
    }
    case 'RESTORE_TAB_STORAGE_ENTRIES': {
      // Remove entries from storage immediately, then open tabs in background
      // with a delay so the popup isn't stalled by tab creation
      const { ids, urls } = msg;
      if (ids && ids.length) {
        const r2 = await browser.storage.local.get(TAB_STORAGE_KEY);
        const remaining = (r2[TAB_STORAGE_KEY] || []).filter(e => !ids.includes(e.id));
        await browser.storage.local.set({ [TAB_STORAGE_KEY]: remaining });
      }
      // Open tabs in background one by one with 800ms gap — popup is not involved
      const urlList = urls || [];
      (async () => {
        for (let i = 0; i < urlList.length; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 800));
          try { await browser.tabs.create({ url: urlList[i], active: false }); } catch {}
        }
      })();
      return { success: true };
    }
    case 'SET_MAX_SESSIONS': {
      const val = Math.max(1, Math.min(20, parseInt(msg.value) || MAX_SESSIONS_DEFAULT));
      await browser.storage.local.set({ eh_max_sessions: val });
      // Trim existing sessions if new max is smaller
      const list = await getSessions();
      if (list.length > val) await browser.storage.local.set({ [SESSIONS_KEY]: list.slice(-val) });
      return { success: true, value: val };
    }
    case 'SET_AUTO_SAVE_INTERVAL': {
      const mins = parseInt(msg.minutes) || 0;
      const safe = mins === 0 ? 0 : Math.max(1, Math.min(1440, mins));
      await browser.storage.local.set({ [AUTO_SAVE_KEY]: safe });
      _lastAutoSave = 0; // reset so next tick recalculates
      return { success: true, minutes: safe };
    }
    case 'GET_SYNC_INTERVAL': {
      return { minutes: await getSyncInterval() };
    }
    case 'SET_SYNC_INTERVAL': {
      const mins = parseInt(msg.minutes);
      const safe = isNaN(mins) ? 30 : Math.max(0, Math.min(1440, mins));
      await saveSettings({ syncInterval: safe });
      _lastFlush = 0; // reset so next alarm tick re-evaluates
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
    case 'TRIGGER_AUTO_EXPORT': {
      const r = await checkAutoExport(true);
      return r;
    }
    case 'GET_AUTO_EXPORT_STATUS': {
      const settings = await getSettings();
      const interval = Number(settings.autoExportIntervalMonths) || 0;
      const entries = await getAll();
      if (!interval || !entries.length) {
        return { enabled: !!interval, monthsAccumulated: 0, retainMonths: AUTO_EXPORT_RETAIN_MONTHS, lastRunAt: settings.autoExportLastRunAt || 0 };
      }
      const now = Date.now();
      const oldest = oldestVisitTime(entries);
      const monthsAccumulated = (now - oldest) / MS_PER_MONTH;
      return {
        enabled: true,
        intervalMonths: interval,
        retainMonths: AUTO_EXPORT_RETAIN_MONTHS,
        monthsAccumulated,
        lastRunAt: settings.autoExportLastRunAt || 0,
      };
    }
    // ── Quick Filters ──────────────────────────────────────────────────────
    case 'GET_QUICK_FILTERS': {
      const r = await browser.storage.local.get(QUICK_FILTERS_KEY);
      return { filters: r[QUICK_FILTERS_KEY] || [] };
    }
    case 'ADD_QUICK_FILTER': {
      const name = (msg.name || '').trim();
      const patterns = (msg.patterns || []).map(p => p.trim()).filter(Boolean);
      if (!name) return { success: false, error: 'Please enter a filter name' };
      if (!patterns.length) return { success: false, error: 'Please add at least one domain, keyword, or URL' };
      const r = await browser.storage.local.get(QUICK_FILTERS_KEY);
      const list = r[QUICK_FILTERS_KEY] || [];
      if (list.some(f => f.name.toLowerCase() === name.toLowerCase())) {
        return { success: false, error: 'A filter with that name already exists' };
      }
      const filter = { id: `qf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, patterns };
      list.push(filter);
      await browser.storage.local.set({ [QUICK_FILTERS_KEY]: list });
      return { success: true, filter };
    }
    case 'UPDATE_QUICK_FILTER': {
      const { id } = msg;
      const name = (msg.name || '').trim();
      const patterns = (msg.patterns || []).map(p => p.trim()).filter(Boolean);
      if (!id) return { success: false, error: 'Missing filter id' };
      if (!name) return { success: false, error: 'Please enter a filter name' };
      if (!patterns.length) return { success: false, error: 'Please add at least one domain, keyword, or URL' };
      const r = await browser.storage.local.get(QUICK_FILTERS_KEY);
      let list = r[QUICK_FILTERS_KEY] || [];
      if (list.some(f => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
        return { success: false, error: 'A filter with that name already exists' };
      }
      list = list.map(f => f.id === id ? { ...f, name, patterns } : f);
      await browser.storage.local.set({ [QUICK_FILTERS_KEY]: list });
      return { success: true };
    }
    case 'REMOVE_QUICK_FILTER': {
      const { id } = msg;
      const r = await browser.storage.local.get(QUICK_FILTERS_KEY);
      let list = r[QUICK_FILTERS_KEY] || [];
      list = list.filter(f => f.id !== id);
      await browser.storage.local.set({ [QUICK_FILTERS_KEY]: list });
      return { success: true };
    }
    case 'SAVE_SETTINGS': {
      const cur=await getSettings(); 
      const next={...cur,...msg.settings};
      //console.log('[EH] SAVE_SETTINGS:', { current: cur, incoming: msg.settings, merged: next });
      await browser.storage.local.set({[SETTINGS_KEY]:next});
      // Update in-memory cache so event listeners pick it up immediately
      if (next.timeTrackingEnabled !== undefined) _timeTrackingEnabled = next.timeTrackingEnabled !== false;
      if (next.autoStoreEnabled !== undefined)    _autoStoreEnabled    = next.autoStoreEnabled !== false;
      if (next.autoStoreHours   !== undefined)    _autoStoreHours      = typeof next.autoStoreHours === 'number' ? next.autoStoreHours : 6;
      if (msg.settings.hasOwnProperty('toolbarIcon'))       applyToolbarIcon(next.toolbarIcon);
      if (msg.settings.hasOwnProperty('popupAsSidebar'))    applyPopupMode(next.popupAsSidebar === true);
      if (msg.settings.hasOwnProperty('contextMenuEnabled')) await ensureContextMenus();
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
      // Update today's history
      await updateTodayHistory();

      // ── Bookmark top domains into "Extended History" folder ──────────────
      try {
        // Count visits per domain across all history (imported + existing)
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
          // Find or create "Extended History" bookmark folder
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
            // Create at top-level bookmarks bar (id '1') or Other Bookmarks (id '2')
            const parentId = tree[0]?.children?.[0]?.id || '1';
            folder = await browser.bookmarks.create({ parentId, title: 'Extended History' });
          }

          // Collect URLs already in the folder to avoid duplicates
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
      // ────────────────────────────────────────────────────────────────────

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
        // removeTree handles both bookmarks and folders
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
    case 'OPEN_INCOGNITO': { try{await browser.windows.create({url:msg.url,incognito:true});}catch{} return {success:true}; }
    case 'GET_IGNORE_LIST': {
      return { list: await getIgnoreList(), enabled: await isIgnoreListEnabled() };
    }
    case 'ADD_IGNORE_PATTERN': {
      const result = await addIgnorePattern(msg.pattern);
      if (!result.success) return result;
      // Clean history in background (don't wait for it)
      const enabled = await isIgnoreListEnabled();
      if (enabled) {
        cleanIgnoredFromHistory().then(() => {
          //console.log('[EH] Cleaned ignored URLs from history for pattern:', result.pattern);
        }).catch(err => {
          //console.error('[EH] Error cleaning ignored history:', err);
        });
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
      // Commit whatever is running (if anything), then restart
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
    case 'MIGRATE_TO_IDB': {
      try {
        // Read from localStorage, write to IDB, then switch flag
        const r = await browser.storage.local.get(HISTORY_KEY);
        const entries = r[HISTORY_KEY] || [];
        await EhIdb.setAll(entries);
        await browser.storage.local.set({ [IDB_STORAGE_KEY]: true });
        return { success: true, migrated: entries.length };
      } catch(e) { return { error: e.message }; }
    }
    case 'MIGRATE_TO_LOCAL': {
      try {
        // Read from IDB, write to localStorage, then switch flag
        const entries = await EhIdb.getAll();
        await browser.storage.local.set({ [HISTORY_KEY]: entries, [IDB_STORAGE_KEY]: false });
        await EhIdb.clear();
        return { success: true, migrated: entries.length };
      } catch(e) { return { error: e.message }; }
    }
    case 'GET_STORAGE_BACKEND': {
      const r = await browser.storage.local.get(IDB_STORAGE_KEY);
      return { backend: r[IDB_STORAGE_KEY] === true ? 'idb' : 'local' };
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
// ══ EXTERNAL MESSAGING ══════════════════════════════════════════════════════
// Allows the "Extended Page" new-tab extension to query history data.
// The sender's ID must be listed in manifest.json > externally_connectable > ids.
const ALLOWED_EXTERNAL_TYPES = new Set([
  'GET_MOST_VISITED',
  'GET_TAB_STORAGE',
  'GET_SETTINGS',
  'REMOVE_TAB_STORAGE_ENTRY',
]);

browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!ALLOWED_EXTERNAL_TYPES.has(message.type)) {
    sendResponse({ error: 'Not allowed: ' + message.type });
    return false;
  }
  handle(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true; // Keep channel open for async response
});