/**
 * Extended History — background.js v3.3
 * Time tracking: purely event-driven per-tab, domain-bucketed by day.
 */
// database/eh-idb.js and database/eh-sql.js are loaded before this file (see "background.scripts" in manifest.json).
const IDB_STORAGE_KEY = 'eh_use_idb';
const SQL_STORAGE_KEY = 'eh_use_sqlite';
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
  popupQuickFilters: true,
  retentionDays: 365,
  maxEntries:    2000000,
  accentColor:   '#3b9eff',
  accentColor2:  '#2dd4a0',
  font:          'system-ui',
  fontSize:      15,
  theme:         'dark',
  language:      'en', // Default language
  ignoreListEnabled: true, // Toggle for ignore list
  ignoreListInvert: false, // Allow-list mode: ignore EVERY site except the ones in the list
  syncInterval: 30,        // Minutes between flushing today's browser history → local storage (0 = every visit)
  timeTrackingEnabled: true, // Whether to track time spent per domain
  autoStoreEnabled: false,   // Auto-store tabs idle for too long
  autoStoreHours: 6,         // Hours of no focus before a tab is auto-stored
  toolbarIcon: 'default',    // Toolbar icon variant: default|bw|emerald|green|gold|pink|red|orange|blue|purple
  contextMenuEnabled: true,  // Whether right-click context menu shows on web pages
  fadeInListOnDateChange: true, // Fade the list in when switching dates (on by default)
  datePillsWheelScroll: false, // Let a vertical mouse wheel scroll the horizontal date-pill bar
  datePillsWheelSensitivity: 1, // Days moved per wheel "click" (1-6) when the above is enabled
  popupAsSidebar: false,     // Open Extended History in the browser's side panel instead of the popup
  sidebarAutoHide: true,     // Close the sidebar automatically when the mouse leaves it
  roundedCorners: true,      // UI rounded corners on the sidebar/main panels (default on)
  navIcons: true,            // Show the icons in the sidebar navigation (off = text only)
  matchUiColors: true,       // History list uses the same colour as the rest of the UI instead of its own shade
  calendarMode: false,       // Replace date/hour pill nav with a right-side calendar sidebar
  hideIgnoredInTimeSpent: false, // Hide (not delete) ignore-list-matched domains from the Time Spent view
  autoExportIntervalMonths: 0, // 0 = disabled. When set (e.g. 4), a .json export of everything new
                                // since the previous export is downloaded every N months. Nothing is deleted.
  autoExportMode: 'full',      // 'full' = all history every time, 'incremental' = only what's new since the last export
  autoExportZip: false,        // wrap the exported .json in a .zip
  autoExportDestination: 'local', // 'local', 'webdav', or 'both'
  autoExportWebDavUrl: '',
  autoExportWebDavUsername: '',
  autoExportWebDavPassword: '',
  autoExportLastRunAt: 0,      // timestamp of the last successful auto-export
  autoSwitchSqlite: true,      // a history too big for Local Storage/IndexedDB moves itself to SQLite automatically
  autoExportLastCoveredTo: 0,  // visitTime watermark: the next export only contains entries newer than this
  autoExportEncrypt: false,    // incremental auto exports are encrypted with a password (see encryptExportParts)
  autoExportEncKey: '',        // base64 of the DOUBLE-HASHED password (PBKDF2 → SHA-256) = the AES key; the password itself is never stored
  autoExportEncSalt: '',       // base64 salt of that PBKDF2 (also written into every encrypted file so import can derive the key)
  autoExportLastIncremental: null, // {since, until, at, count} of the last incremental export → "Re-download last incremental backup"
};
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
  purple:     'icons/icon_purple.png',
  orange:     'icons/icon_orange.png',
  blue:     'icons/icon_darkblue.png',
};
function applyToolbarIcon(variant) {
  const file = TOOLBAR_ICON_FILES[variant] || TOOLBAR_ICON_FILES.default;
  try {
    browser.browserAction.setIcon({ path: file });
  } catch (e) { console.warn('[EH] setIcon failed:', e); }
  //refreshActiveTabIcons();   // tabs on ignored sites keep the "filtered" icon
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "open_history_page") {
    browser.tabs.create({
      url: "moz-extension://866ee41c-05ab-4a86-8e73-6c77811b0c3d/html/history.html"
    });
  }
});

// ── "Filtered" toolbar icon ──────────────────────────────────────────────────
// While the current tab is on a site that the Ignore List would skip (domain,
// URL-path or kw: keyword pattern, same matcher as history saving), the toolbar
// shows icon_filtered.png instead of the chosen icon variant. Set per tab, so
// switching tabs / windows always shows the right icon.
// const FILTERED_ICON_FILE = '/icons/icon_filtered.png';

// async function updateIconForTab(tab) {
//   try {
//     if (!tab || tab.id == null || tab.id < 0) return;
//     const url = tab.url || tab.pendingUrl || '';
//     const ignored = !!url && isTrackable(url) && await shouldIgnoreUrl(url, tab.title);   // false when the ignore list is switched off
//     const variant = (await getSettings()).toolbarIcon;
//     const path = ignored ? FILTERED_ICON_FILE : (TOOLBAR_ICON_FILES[variant] || TOOLBAR_ICON_FILES.default);
//     await browser.browserAction.setIcon({ tabId: tab.id, path });
//   } catch (_) { /* tab closed meanwhile */ }
// }
// async function refreshActiveTabIcons() {
//   try {
//     for (const t of await browser.tabs.query({ active: true })) await updateIconForTab(t);
//   } catch (_) {}
// }
// browser.tabs.onActivated.addListener(async ({ tabId }) => {
//   try { await updateIconForTab(await browser.tabs.get(tabId)); } catch (_) {}
// });
// browser.tabs.onUpdated.addListener((tabId, info, tab) => {
//   if (info.url || info.title || info.status) updateIconForTab(tab);   // navigation (also resets per-tab icons) or title change (kw: patterns match titles)
// });
// // Ignore list edited / toggled, or icon variant changed (also fires on unlock)
// browser.storage.onChanged.addListener((ch, area) => {
//   if (area === 'local' && (ch[IGNORE_LIST_KEY] || ch[SETTINGS_KEY])) refreshActiveTabIcons();
// });
// refreshActiveTabIcons();   // service worker (re)started

// ── Popup / Sidebar mode ─────────────────────────────────────────────────────
// With "Use as sidebar" on, the toolbar button has no popup and a click toggles Firefox's
// sidebar instead; with it off, the button opens the normal popup again.
function applyPopupMode(sidebarMode) {
  try {
    browser.browserAction.setPopup({ popup: sidebarMode ? '' : 'html/popup.html' });
  } catch (e) { console.warn('[EH] setPopup failed:', e); }
}

// browserAction.onClicked only fires while no popup is set, i.e. in sidebar mode.
// sidebarAction.toggle() opens the sidebar if it is closed and closes it if it is open
// (older Firefox versions without toggle() can only open it). It has to be called
// synchronously inside the click handler, which is exactly what this is.
browser.browserAction.onClicked.addListener(() => {
  try {
    if (browser.sidebarAction && browser.sidebarAction.toggle) browser.sidebarAction.toggle();
    else if (browser.sidebarAction && browser.sidebarAction.open) browser.sidebarAction.open();
  } catch (e) { console.warn('[EH] sidebarAction.toggle failed:', e); }
});

// Keyboard shortcut (default Alt+Shift+H — Ctrl+Shift+H belongs to Firefox's Library window, see manifest "commands") — opens the sidebar
// regardless of the "Use as sidebar" toggle. sidebarAction.open() must be called synchronously
// inside a user-action handler, which onCommand is.
if (browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener((command) => {
    if (command !== 'open_sidebar') return;
    try { browser.sidebarAction.open(); } catch (e) { console.warn('[EH] sidebarAction.open failed:', e); }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// storage.local.getBytesInUse() only exists in recent Firefox versions (131+); otherwise estimate from the stored value.
async function bytesInUse(key) {
  try {
    if (typeof browser.storage.local.getBytesInUse === 'function') return await browser.storage.local.getBytesInUse(key);
  } catch (_) {}
  try {
    const v = (await browser.storage.local.get(key))[key];
    return v == null ? 0 : (Array.isArray(v) ? v.length * 250 : JSON.stringify(v).length);   // ≈250 bytes per history entry as JSON
  } catch (_) { return 0; }
}
// browsingData.remove(): Firefox only knows cache, cookies, downloads, formData, history, indexedDB,
// localStorage, passwords, pluginData and serviceWorkers — Chrome-only types (cacheStorage, webSQL,
// fileSystems...) make the whole call fail, so they are dropped here.
const FF_DATA_TYPES = new Set(['cache', 'cookies', 'downloads', 'formData', 'history', 'indexedDB', 'localStorage', 'passwords', 'pluginData', 'serviceWorkers']);
function removeBrowsingData(options, types) {
  const ok = {};
  for (const k of Object.keys(types || {})) if (types[k] && FF_DATA_TYPES.has(k)) ok[k] = true;
  if (!Object.keys(ok).length) return Promise.resolve();
  return browser.browsingData.remove({ since: (options && options.since) || 0 }, ok);
}
function todayKey() { return new Date().toLocaleDateString('en-CA'); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function isTrackable(url) {
  if (!url) return false;
  return !['about:', 'moz-extension://', 'chrome://', 'resource:', 'view-source:', 'data:', 'javascript:'].some(p => url.startsWith(p));
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
  // While locked this key holds an encrypted envelope (an object), not an array
  const list = Array.isArray(r[IGNORE_LIST_KEY]) ? r[IGNORE_LIST_KEY] : [];
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
// Allow-list mode (setting ignoreListInvert): the list names the sites to KEEP and everything else is ignored.
async function isIgnoreInvert() {
  const r = await browser.storage.local.get(SETTINGS_KEY);
  return !!(r[SETTINGS_KEY] && r[SETTINGS_KEY].ignoreListInvert === true);
}
// Is this URL ignored? An empty list never ignores anything (in allow-list mode that would otherwise ignore the whole web).
function ignoredBy(list, url, title, invert) {
  if (!list || !list.length) return false;
  const hit = list.some(p => matchesIgnorePattern(url, p, title));
  return invert ? !hit : hit;
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
  return ignoredBy(ignoreList, url, title, await isIgnoreInvert());
}

// Time Spent data is stored aggregated per-domain (no per-page path), so this
// is a lighter sibling of matchesIgnorePattern() — no URL/title to check,
// just a bare hostname. A path-specific ignore pattern (e.g. "example.com/x")
// still hides the whole domain here, since we can't filter at a granularity
// finer than what's actually tracked.
function domainMatchesIgnorePattern(domain, pattern) {
  try {
    if (pattern.startsWith('kw:')) {
      const kw = pattern.slice(3).toLowerCase();
      return !!kw && (domain || '').toLowerCase().includes(kw);
    }
    const parsed = parseIgnorePattern(pattern);
    if (!parsed) return false;
    return hostMatchesPattern(domain, parsed.host, true);
  } catch {
    return false;
  }
}

// Returns the ignore list to filter Time Spent domains against, or null if
// the "hide ignored domains" option is off / there's nothing to hide.
async function getTimeSpentIgnoreList() {
  const settings = await getSettings();
  if (!settings.hideIgnoredInTimeSpent) return null;
  const ignoreList = await getIgnoreList();
  return ignoreList.length ? ignoreList : null;
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
    await deleteUrlSafe(target);
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
    const invert = await isIgnoreInvert();
    const recent = await browser.history.search({
      text: host,
      startTime: Date.now() - 10 * 60 * 1000,
      maxResults: 250,
    });

    for (const item of recent) {
      if (!item.url || !isTrackable(item.url)) continue;
      if (!ignoredBy(ignoreList, item.url, item.title, invert)) continue;
      await deleteUrlFromNativeHistory(item.url);
    }
  } catch {}
}

// ── Ignore-cleanup progress bubble ────────────────────────────────────────────
// Purging ignored URLs from a large history can take a while (one native
// browser.history.deleteUrl call per matched entry), and history won't
// re-load correctly while it's mid-purge. This state makes that visible even
// if every extension page/popup gets closed while the cleanup keeps running
// in the background — the badge on the toolbar icon persists regardless.
let _ignoreCleanupActive = false;
let _ignoreCleanupProgress = { done: 0, total: 0 };

function broadcastCleanupStatus() {
  try {
    browser.runtime.sendMessage({
      type: 'CLEANUP_PROGRESS',
      active: _ignoreCleanupActive,
      done: _ignoreCleanupProgress.done,
      total: _ignoreCleanupProgress.total,
    }).catch(() => {}); // no listeners is fine
  } catch {}
}

function setCleanupBadge(active, done, total) {
  try {
    if (active) {
      browser.browserAction.setBadgeBackgroundColor({ color: '#e0a030' });
      // Badge text is limited to ~4 visible chars by browser anyway; fall back
      // to a plain "working" indicator once the done/total count gets long.
      const label = total ? `${done}/${total}` : '…';
      browser.browserAction.setBadgeText({ text: label.length <= 4 ? label : '…' });
    } else {
      browser.browserAction.setBadgeText({ text: '' });
    }
  } catch {}
}

// Clean all ignored URLs from history
// In allow-list mode "ignored" means "not on the list", so cleaning would delete everything else: it only runs
// when the user explicitly asks for it (force) — never as a side effect of adding a pattern or switching the list on.
async function cleanIgnoredFromHistory(force) {
  const enabled = await isIgnoreListEnabled();
  if (!enabled) return { removed: 0 };
  const invert = await isIgnoreInvert();
  if (invert && force !== true) return { removed: 0, skipped: 'allowlist' };
  const ignoreList = await getIgnoreList();
  if (!ignoreList.length) return { removed: 0 };
  
  const sqlMode = await _useSql();
  const toKeep = [];
  const toDelete = [];
  const isIgnored = (e) => ignoredBy(ignoreList, e.url, e.title, invert);
  if (sqlMode) {                                  // scan in slices, keep only the matches
    await EhStore.forEachSlice(rows => { for (const e of rows) if (isIgnored(e)) toDelete.push(e); });
  } else {
    for (const e of await getAll()) { if (isIgnored(e)) toDelete.push(e); else toKeep.push(e); }
  }

  if (!toDelete.length) return { removed: 0 };

  _ignoreCleanupActive = true;
  _ignoreCleanupProgress = { done: 0, total: toDelete.length };
  setCleanupBadge(true, 0, toDelete.length);
  broadcastCleanupStatus();

  try {
    if (sqlMode) { await EhStore.removeIds(toDelete.map(e => e.id)); _entriesCache = null; }
    else await setAll(toKeep);
    await updateTodayHistory();

    // Also remove from browser native history
    for (const e of toDelete) {
      await deleteUrlSafe(e.url);
      _ignoreCleanupProgress.done++;
      // Throttle badge/broadcast updates so we're not hammering these APIs
      if (_ignoreCleanupProgress.done % 10 === 0 || _ignoreCleanupProgress.done === toDelete.length) {
        setCleanupBadge(true, _ignoreCleanupProgress.done, toDelete.length);
        broadcastCleanupStatus();
      }
    }
  } finally {
    _ignoreCleanupActive = false;
    setCleanupBadge(false, 0, 0);
    broadcastCleanupStatus();
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

// ── Live history fetch: read straight from the browser API (no per-visit storage writes) ──
// Returns entries in the same shape as eh_history entries. Shared by the
// calendar-day "today" fetch and the rolling-24h popup fetch below.
// Firefox answers history.search slowly and the same query is repeated by every popup/page refresh, so a result
// is reused for a couple of seconds (dropped at once when a visit is added or removed).
let _liveCache = new Map();
try {
  browser.history.onVisited.addListener(() => { _liveCache.clear(); });
  browser.history.onVisitRemoved.addListener(() => { _liveCache.clear(); });
} catch (_) {}
async function _liveHistoryEntries(searchParams) {
  const key = JSON.stringify(searchParams || {});
  const hit = _liveCache.get(key);
  if (hit && Date.now() - hit.t < 3000) return hit.p.then(list => list.slice());
  const p = _liveHistoryEntriesRaw(searchParams);
  _liveCache.set(key, { t: Date.now(), p });
  if (_liveCache.size > 8) _liveCache.delete(_liveCache.keys().next().value);
  return p.then(list => list.slice());
}
async function _liveHistoryEntriesRaw(searchParams) {
  try {
    const items = await browser.history.search({
      text: '',
      maxResults: 10000,
      ...searchParams,
    });

    const ignoreEnabled = await isIgnoreListEnabled();
    const ignoreList = ignoreEnabled ? await getIgnoreList() : [];
    const ignoreInvert = ignoreEnabled && ignoreList.length ? await isIgnoreInvert() : false;
    const seed = await getSeedWindow();

    const entries = [];
    for (const item of items) {
      if (!item.url || !isTrackable(item.url)) continue;
      // Skip visits we synthesised ourselves when unlocking (see unlockHistory)
      if (seed && item.lastVisitTime >= seed.start && (seed.end == null || item.lastVisitTime <= seed.end)
          && seed.urls.has(normalizeUrl(item.url))) continue;
      if (ignoredBy(ignoreList, item.url, item.title, ignoreInvert)) continue;
      entries.push({
        id: `live_${item.lastVisitTime}_${Math.random().toString(36).slice(2, 6)}`,
        url: normalizeUrl(item.url),
        ...rawUrlField(normalizeUrl(item.url), item.url),
        title: item.title || '',
        visitTime: item.lastVisitTime || Date.now(),
        domain: domainOf(item.url),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

// Calendar-day "today" (midnight → now). Used by flushTodayToHistory() for
// merging into eh_history, and by the sidebar day-nav once you step to a
// past date (via the SEARCH message, bounded to that day's midnight-midnight
// range) — NOT by the "Today" view itself, which uses the rolling-24h
// getRecentFromBrowserApi() below instead, in both the popup and the sidebar.
async function getTodayFromBrowserApi() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return _liveHistoryEntries({ startTime: todayStart.getTime() });
}

// Rolling last-24h window. Used by "Today" in both the popup and the
// sidebar's day-nav — the sidebar only switches to genuine calendar-day
// scoping once you navigate to a past date.
// omitting startTime lets browser.history.search() apply its own default
// window (last 24 hours) instead of a calendar-day cutoff.
async function getRecentFromBrowserApi() {
  return _liveHistoryEntries({});
}

// Legacy no-op shim — callers that still call updateTodayHistory() are safe.
// Today's data is now served live from the browser API; we don't need to cache it.
async function updateTodayHistory() {
  // No-op: today's history is read live via getTodayFromBrowserApi().
  // The periodic flush (flushTodayToHistory) handles persisting to eh_history.
}

// ── Periodic flush: merge today's browser history into eh_history ──────────────
// Runs every `syncInterval` minutes (default 30). Pulls all of today's visits
// from the browser history API and merges them into local storage, deduplicating
// by (normalizedUrl, 5-second bucket). This replaces per-visit storage writes.
// _lastFlush is cached in memory but backed by storage — MV3 service workers
// can be torn down between the once-a-minute eh_flush ticks, which would
// otherwise silently reset this to 0 and make the flush fire far more often
// than `syncInterval` actually calls for (and make a "time until next merge"
// stat useless, since it'd constantly read as overdue).
const LAST_FLUSH_KEY = 'eh_last_flush';
let _lastFlush = 0;
let _lastFlushLoaded = false;

async function getLastFlush() {
  if (!_lastFlushLoaded) {
    const r = await browser.storage.local.get(LAST_FLUSH_KEY);
    _lastFlush = r[LAST_FLUSH_KEY] || 0;
    _lastFlushLoaded = true;
  }
  return _lastFlush;
}

async function setLastFlush(ts) {
  _lastFlush = ts;
  _lastFlushLoaded = true;
  await browser.storage.local.set({ [LAST_FLUSH_KEY]: ts });
}

// Keeps the stored history within retention + maxEntries (IndexedDB backend) using only the
// visitTime index: finds the ids to drop without loading any entries, then deletes just those.
async function pruneStoredIdb(cutoff, maxEntries) {
  if (await _useSql()) {
    // SQLite: only the retention window applies. The entry-count cap (maxEntries, 2 million by default) exists for the
    // memory-bound backends — applying it here silently deleted the OLDEST part of any history above 2 million entries
    // (and the COUNT(*) it needed scanned the whole database on every merge).
    if (await EhStore.deleteBelow(cutoff)) { _entriesCache = null; _entriesLoading = null; }
    return;
  }
  const total = await EhStore.count();
  let threshold = cutoff;
  if (total > maxEntries) {                      // over the cap: also drop the oldest beyond it
    const t = await EhStore.visitTimeAtRank(total - maxEntries);
    if (t !== null && t > threshold) threshold = t;
  }
  const ids = await EhStore.keysBelow(threshold);
  if (!ids.length) return;
  await EhStore.removeIds(ids);
  if (_entriesCache) { const gone = new Set(ids); _entriesCache = _entriesCache.filter(e => !gone.has(e.id)); }
}

async function flushTodayToHistory() {
  if (_migrating || _dbBusy) return;
  const settings = await getSettings();
  const now = Date.now();
  const cutoff = now - settings.retentionDays * 86400000;

  const todayEntries = await getTodayFromBrowserApi();
  if (!todayEntries.length) { await setLastFlush(now); return; }     // nothing to merge is still a completed check

  let minT = Infinity;
  for (const e of todayEntries) if (e.visitTime < minT) minT = e.visitTime;
  minT -= 10000;

  const useIdb = await _useIdb();
  // Only stored entries from around the same time as today's visits can be duplicates of them.
  // IndexedDB: read just that window from the index (the full history is not loaded).
  const nearby = useIdb ? await getEntriesBetween(minT, now + 3600000) : null;
  let existing = useIdb ? null : await getAll();

  const existingSet = new Set();
  for (const e of (useIdb ? nearby : existing)) {
    if (e.visitTime >= minT) existingSet.add(`${e.url}|${Math.floor(e.visitTime / 5000)}`);
  }

  const fresh = [];
  for (const e of todayEntries) {
    const key = `${e.url}|${Math.floor(e.visitTime / 5000)}`;
    if (existingSet.has(key)) continue;
    existingSet.add(key);
    fresh.push({ ...e, id: `flush_${e.visitTime}_${Math.random().toString(36).slice(2, 6)}` });
  }
  if (!fresh.length) { await setLastFlush(now); return; }

  if (useIdb) {
    if (await _useSql()) { await EhStore.insertIgnore(fresh); _entriesCache = null; }   // the database skips duplicates itself
    else {
      await EhStore.putMany(fresh);                                 // only the new rows are written
      if (_entriesCache) for (const e of fresh) _entriesCache.push(e);   // keep a warm cache in step
    }
    await pruneStoredIdb(cutoff, settings.maxEntries);
  } else {
    // browser.storage.local keeps the whole history in one value, so it has to be rewritten.
    for (const e of fresh) existing.push(e);
    existing = existing.filter(e => e.visitTime >= cutoff);
    if (existing.length > settings.maxEntries) existing = existing.slice(existing.length - settings.maxEntries);
    existing.sort((a, b) => b.visitTime - a.visitTime);
    await setAll(existing);
  }
  await setLastFlush(now);
  //console.log(`[EH] Flushed ${fresh.length} new entries from today into history`);
}

// ── Auto history export ──────────────────────────────────────────────────────
// If the user sets an interval (months), a .json export is downloaded every N
// months. Mode "full" exports all history each time; mode "incremental"
// exports only what was recorded since the previous export (the very first
// export contains everything). Optionally wrapped in a .zip. Export only —
// NOTHING is ever deleted, neither from the extension's storage nor from
// the browser's native history.
let _autoExportRunning = false;

// Stack-safe replacement for Math.min(...arr) — spreading a huge history array
// as call arguments overflows the call stack once it gets into the hundreds of
// thousands of entries (which unlimitedStorage happily allows).
function oldestVisitTime(entries) {
  let oldest = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const t = entries[i].visitTime;
    if (t < oldest) oldest = t;
  }
  return oldest;
}

// Overlap between consecutive exports. Visits reach extension storage a little
// after they happen (periodic flush), so the watermark is set slightly in the
// past to make sure nothing slips between two exports. Duplicates across files
// are harmless: Import merges and de-duplicates.
const AUTO_EXPORT_OVERLAP_MS = 86400000;

// ── Chunked export transfer ──────────────────────────────────────────────────
// browser.runtime / browser.tabs messages are capped at 64 MiB, which a big history
// easily exceeds. So exports are never sent as one message: they're built as a
// list of ~4 MB string parts kept here, and the history page pulls them one at a
// time (EXPORT_PULL) and assembles the file itself.
const _exportJobs = new Map();

// What goes into an export file. Everything else on a stored entry is internal:
//  - id      : storage bookkeeping; Import generates fresh ones
//  - rawUrl  : only kept when it differs from url (it's needed to also delete the
//              exact native-history URL later); otherwise it's a pure duplicate
//  - tabId / source : never read by anything
function slimEntry(e) {
  const o = { url: e.url, title: e.title || '', visitTime: e.visitTime, domain: e.domain };
  if (e.rawUrl && e.rawUrl !== e.url) o.rawUrl = e.rawUrl;
  return o;
}
// Same idea for stored entries: only add rawUrl when it carries information.
const rawUrlField = (norm, raw) => (raw && raw !== norm ? { rawUrl: raw } : {});

// ── Batched import ───────────────────────────────────────────────────────────
// A big file can't be sent in one message (64 MiB cap), so the page sends it in
// batches: IMPORT_BEGIN → IMPORT_BATCH × n → IMPORT_HISTORY {job} (finish).
// The existing history + de-dupe set are built once, at BEGIN.
const _importJobs = new Map();
function importProcessBatch(job, list) {
  const fresh = [];
  for (const e of list) {
    if (!e || !e.url || !isTrackable(e.url)) { job.stats.invalid++; continue; }
    if (e.visitTime && e.visitTime < job.cutoff) {
      job.stats.old++;
      if (!job.stats.oldestOld || e.visitTime < job.stats.oldestOld) job.stats.oldestOld = e.visitTime;
      continue;
    }
    const raw  = e.rawUrl || e.url;   // slim exports only carry rawUrl when it differs from url
    const norm = normalizeUrl(raw);
    const vt   = e.visitTime || Date.now();
    if (job.existingSet) {                 // (SQLite jobs let the database skip duplicates instead)
      const key = `${norm}|${Math.floor(vt / 5000)}`;
      if (job.existingSet.has(key)) { job.stats.dup++; continue; }
      job.existingSet.add(key);
    }
    fresh.push({ id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, url: norm, ...rawUrlField(norm, raw),
                 title: e.title || '', visitTime: vt, domain: domainOf(raw) });
  }
  job.stats.imported += fresh.length;
  return fresh;
}

function registerExportJob(parts) {
  const id = 'x' + Date.now() + Math.random().toString(36).slice(2, 6);
  _exportJobs.set(id, parts);
  setTimeout(() => _exportJobs.delete(id), 30 * 60000);
  return id;
}
// meta: object written before "entries"; tailJson: raw JSON fragment (starting with ',') written after it.
// SQLite export: parts are produced lazily, one slice of the table at a time, as the page
// pulls them — the whole export is never held in memory at once.
async function* sqlExportParts(meta, tailJson, filter) {
  const metaJson = JSON.stringify(meta);
  let cur = metaJson.slice(0, -1) + (metaJson.length > 2 ? ',' : '') + '"entries":[';
  let first = true, after = null;
  for (;;) {
    const rows = await EhSql.rpc('getSlice', { ...filter, after, limit: 20000 });
    for (const r of rows) {
      cur += (first ? '' : ',') + JSON.stringify(slimEntry(r));
      first = false;
      if (cur.length > 4e6) { yield cur; cur = ''; }
    }
    if (rows.length < 20000) break;
    const last = rows[rows.length - 1];
    after = [last.visitTime, last.seq];
  }
  yield cur + ']' + (tailJson || '') + '}';
}
function buildExportParts(meta, entries, tailJson) {
  const parts = [];
  const metaJson = JSON.stringify(meta);
  let cur = metaJson.slice(0, -1) + (metaJson.length > 2 ? ',' : '') + '"entries":[';
  let first = true;
  for (let i = 0; i < entries.length; i++) {
    cur += (first ? '' : ',') + JSON.stringify(entries[i]);
    first = false;
    if (cur.length > 4e6) { parts.push(cur); cur = ''; }
  }
  cur += ']' + (tailJson || '') + '}';
  parts.push(cur);
  return parts;
}

function broadcastAutoExportProgress(label, pct, error) {
  try {
    browser.runtime.sendMessage({ type: 'AUTO_EXPORT_PROGRESS', label, pct, error: !!error }).catch(() => {});
  } catch (_) {}
}

// Collects an export into a Blob. A 1 GB history can never be ONE JavaScript string (the engine's limit is far
// lower), so the text is handed to Blob storage in batches — the browser keeps those off the JS heap — and the
// request body is the Blob.
async function materializeExportContent(content, onProgress, mime) {
  const blobs = [];
  let batch = [], batchLen = 0, n = 0;
  const push = (str) => {
    batch.push(str); batchLen += str.length;
    if (batchLen > 32e6) { blobs.push(new Blob(batch)); batch = []; batchLen = 0; }
  };
  if (content && content.lazy) {
    for await (const part of content.lazy) {
      push(part); n++;
      if (onProgress) onProgress(Math.min(55, 10 + n * 2));
    }
  } else if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      push(content[i]);
      if (onProgress && (i % 8 === 0 || i === content.length - 1)) onProgress(10 + Math.round(45 * (i + 1) / content.length));
    }
  } else {
    push(String(content || ''));
    if (onProgress) onProgress(55);
  }
  if (batch.length) blobs.push(new Blob(batch));
  return new Blob(blobs, { type: mime || 'application/json' });
}

function webDavTargetUrl(baseUrl, filename) {
  const raw = String(baseUrl || '').trim();
  if (!raw) throw new Error('WebDAV URL is empty');
  const u = new URL(raw);
  // The URL is a FOLDER (the file name is added here) — with or without the trailing slash. Only an address that
  // clearly names a file (…/history.json) is used as it is. (Without this, "https://host/dav/history" was
  // uploaded AS a file called "history", which servers answer with 409 / 405.)
  const last = u.pathname.split('/').filter(Boolean).pop() || '';
  const looksLikeFile = /\.[A-Za-z0-9]{1,5}$/.test(last) && !/\/$/.test(u.pathname);
  if (!looksLikeFile) {
    if (!/\/$/.test(u.pathname)) u.pathname += '/';
    u.pathname += encodeURIComponent(filename);
  }
  return u.toString();
}

// "user:password" → Basic auth header, safe for non-Latin-1 characters (plain btoa() throws on those)
function webDavAuthHeader(username, password) {
  if (!username && !password) return null;
  const bytes = new TextEncoder().encode(`${username || ''}:${password || ''}`);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}
function webDavStatusText(status) {
  switch (status) {
    case 401: return 'Login failed (401) — check the username and password';
    case 403: return 'Access denied (403) — this account may not be allowed to write here';
    case 404: return 'Folder not found (404) — check the URL / create the folder first';
    case 405: return 'The server does not accept uploads at this URL (405) — is it a WebDAV address?';
    case 409: return 'The target folder does not exist (409) — create it on the server first';
    case 413: return 'The server refused the file because it is too large (413)';
    case 507: return 'The server is out of storage space (507)';
    default:  return `The server answered with an error (${status})`;
  }
}
async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// PUT that creates missing folders: servers answer 409 (or 404) when the target folder does not exist.
// In that case MKCOL every folder of the URL path (parents first; "already exists" answers are fine) and retry once.
async function webDavPut(target, headers, body, timeoutMs) {
  const put = () => fetchWithTimeout(target, { method: 'PUT', headers, body }, timeoutMs);
  let res = await put();
  if (res.status !== 409 && res.status !== 404) return { res, created: false };
  const u = new URL(target);
  const dirs = u.pathname.split('/').filter(Boolean).slice(0, -1);        // folders only, not the file name
  const auth = headers.Authorization ? { Authorization: headers.Authorization } : {};
  let path = '', created = false;
  const mkLog = [];
  for (const seg of dirs) {
    path += '/' + seg;
    try {
      const m = await fetchWithTimeout(u.origin + path + '/', { method: 'MKCOL', headers: auth }, 15000);
      mkLog.push(m.status);
      if (m.status === 201) created = true;
      else if (m.status === 401) return { res: m, created };               // wrong login — report it
      // 405 = already exists, 403/other on the upper levels = not ours to create; the final PUT decides
    } catch (_) { /* network hiccup on one level — the retry below reports the real problem */ }
  }
  res = await put();
  return { res, created, tried: u.pathname, mk: mkLog.join(',') };
}

// Settings → "Test upload": PUT a tiny file, then delete it again.
async function testWebDav({ url, username, password }) {
  const t0 = Date.now();
  let target;
  try { target = webDavTargetUrl(url, `eh-webdav-test-${Date.now()}.txt`); }
  catch (e) { return { ok: false, message: 'The server URL is not valid' }; }
  const headers = { 'Content-Type': 'text/plain', 'Overwrite': 'T' };
  const auth = webDavAuthHeader(username, password);
  if (auth) headers.Authorization = auth;
  try {
    const { res, created, tried, mk } = await webDavPut(target, headers, 'Extended History WebDAV test ' + new Date().toISOString(), 20000);
    if (!res.ok) return { ok: false, message: webDavStatusText(res.status) + (tried ? ` [PUT ${tried}; folder creation answers: ${mk || 'none'}]` : '') };
    let cleaned = true;
    try { const d = await fetchWithTimeout(target, { method: 'DELETE', headers: auth ? { Authorization: auth } : {} }, 10000); cleaned = d.ok || d.status === 404; } catch (_) { cleaned = false; }
    return { ok: true, ms: Date.now() - t0, message: 'Upload works' + (created ? ' — the folder did not exist and was created' : '') + (cleaned ? '' : ' (the test file could not be removed again — you can delete "eh-webdav-test-*.txt" yourself)') };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, message: 'The server did not answer within 20 seconds' };
    return { ok: false, message: 'Could not reach the server — check the address, your network, and that it allows this extension' };
  }
}

async function uploadWebDavExport(content, filename, mime, settings) {
  broadcastAutoExportProgress('Preparing WebDAV export…', 5);
  try {
    const body = await materializeExportContent(content, pct => broadcastAutoExportProgress('Preparing WebDAV export…', Math.min(60, pct)), mime);
    const headers = { 'Content-Type': mime || 'application/json', 'Overwrite': 'T' };
    const auth = webDavAuthHeader(settings.autoExportWebDavUsername, settings.autoExportWebDavPassword);
    if (auth) headers.Authorization = auth;
    const mb = body.size / 1048576;
    // fetch() cannot report upload progress, so the upload stage is shown as an animated bar with the size
    broadcastAutoExportProgress(`Uploading ${mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB ' : (mb >= 0.1 ? mb.toFixed(1) + ' MB ' : '')}to WebDAV…`, null);
    const { res } = await webDavPut(webDavTargetUrl(settings.autoExportWebDavUrl, filename), headers, body, 30 * 60000);
    if (!res.ok) throw new Error(webDavStatusText(res.status));
    broadcastAutoExportProgress('WebDAV upload complete', 100);
    return true;
  } catch (e) {
    broadcastAutoExportProgress('WebDAV upload failed: ' + e.message, 100, true);
    throw e;
  }
}

// ── Encrypted auto exports ───────────────────────────────────────────────────
// Format "v2 / kdf dh" — the same chunked text format as encrypted manual exports (history.js reads it), plus "kdf":"dh":
// the AES-256-GCM key is the double hash SHA-256(PBKDF2-SHA256(password, salt)) of the password. The background stores that
// key (autoExportEncKey) so unattended exports can be encrypted without the password; importing asks for the password
// and derives the very same key from it and the salt in the file header.
function _u8b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function _b64u8(b) { const bin = atob(b), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const EXPORT_ENC_CHUNK = 8e6;                          // characters of plain text per encrypted piece
async function* encryptExportParts(source, keyB64, saltB64) {
  const key = await crypto.subtle.importKey('raw', _b64u8(keyB64), 'AES-GCM', false, ['encrypt']);
  const seal = async (text) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
    return JSON.stringify({ iv: _u8b64(iv), ct: _u8b64(ct) });
  };
  yield '{"__eh_encrypted":true,"v":2,"kdf":"dh","salt":"' + saltB64 + '",\n"chunks":[\n';
  let acc = '', pending = null;
  const push = async (text) => { const line = await seal(text); const out = pending === null ? null : pending + ',\n'; pending = line; return out; };
  const feed = async function* (str) {
    acc += str;
    while (acc.length >= EXPORT_ENC_CHUNK) {
      const out = await push(acc.slice(0, EXPORT_ENC_CHUNK)); acc = acc.slice(EXPORT_ENC_CHUNK);
      if (out !== null) yield out;
    }
  };
  if (source && source.lazy) { for await (const part of source.lazy) yield* feed(part); }
  else for (const part of (Array.isArray(source) ? source : [String(source || '')])) yield* feed(part);
  if (acc || pending === null) { const out = await push(acc); if (out !== null) yield out; }
  yield pending + '\n]}\n';
}
// → content in the same shape makeJson() returns, encrypted when the settings ask for it (incremental exports only)
function maybeEncryptExport(content, settings, mode) {
  if (mode !== 'incremental' || settings.autoExportEncrypt !== true || !settings.autoExportEncKey || !settings.autoExportEncSalt) return { content, encrypted: false };
  return { content: { lazy: encryptExportParts(content, settings.autoExportEncKey, settings.autoExportEncSalt) }, encrypted: true };
}

// Settings → "Re-download last incremental backup": rebuilds the file of the last incremental export — everything
// recorded in (since, until] of that run — and saves it again (encrypted too when that is switched on).
async function redownloadLastIncremental() {
  if (_autoExportRunning) return { error: 'An export is already running — try again in a moment' };
  const settings = await getSettings();
  const last = settings.autoExportLastIncremental;
  if (!last || !last.until) return { error: 'No incremental backup has been made yet' };
  _autoExportRunning = true;
  try {
    const sqlMode = await _useSql();
    const filter = { lo: Number(last.since) || 0, loOpen: true, hi: last.until };
    const entries = sqlMode ? null : (await getAll()).filter(e => e.visitTime > filter.lo && e.visitTime <= filter.hi);
    const count = sqlMode ? (await EhStore.page({ ...filter, limit: 0 })).total : entries.length;
    if (!count) return { error: 'The last incremental backup contained no entries any more (they were deleted since)' };
    const meta = { exportedAt: new Date(last.until).toISOString(), totalEntries: count, auto: true, autoExportMode: 'incremental', redownload: true };
    const raw = sqlMode ? { lazy: sqlExportParts(meta, '', filter) } : buildExportParts(meta, entries.map(slimEntry));
    const { content, encrypted } = maybeEncryptExport(raw, settings, 'incremental');
    const useZip = settings.autoExportZip === true;
    const baseName = `extended-history-auto_incremental_${new Date(last.until).toISOString().slice(0, 10)}${encrypted ? '_enc' : ''}`;
    const ok = useZip
      ? await downloadViaPage(content, `${baseName}.zip`, 'application/zip', { zipEntryName: `${baseName}.json` })
      : await downloadViaPage(content, `${baseName}.json`, 'application/json');
    return ok ? { success: true, exported: count, encrypted } : { error: 'Could not save the file. Try again.' };
  } finally {
    _autoExportRunning = false;
  }
}

const _swStartedAt = Date.now();
async function checkAutoExport(force) {
  if (_autoExportRunning) return { skipped: true };
  // Never start a (possibly huge) export while the browser is still starting up.
  if (!force && Date.now() - _swStartedAt < 5 * 60000) return { skipped: true, reason: 'startup' };
  const settings = await getSettings();
  const interval = Number(settings.autoExportIntervalMonths) || 0;
  if (interval <= 0) return { skipped: true, reason: 'disabled' };

  _autoExportRunning = true;
  try {
    const sqlMode = await _useSql();
    const entries = sqlMode ? null : await getAll();
    const nonEmpty = sqlMode ? await EhSql.rpc('hasRows') : entries.length > 0;     // not COUNT(*): that scans the whole database
    if (!nonEmpty) return { skipped: true, reason: 'empty' };

    const now       = Date.now();
    const lastRunAt = Number(settings.autoExportLastRunAt) || 0;
    const since     = Number(settings.autoExportLastCoveredTo) || 0;

    // Due once `interval` months have passed since the last export — or, before
    // the first export, once the oldest entry is `interval` months old.
    if (!force) {
      // Before the first export the clock starts when auto-export is first checked — NOT at the oldest entry, or importing an
      // old history made a full export of everything "due" immediately (a multi-GB job that exhausted the browser's memory).
      let baseline = lastRunAt || Number(settings.autoExportBaselineAt) || 0;
      if (!baseline) { baseline = now; await saveSettings({ autoExportBaselineAt: now }); }
      if ((now - baseline) < interval * MS_PER_MONTH) {
        return { skipped: true, reason: 'not_due', nextDueAt: baseline + interval * MS_PER_MONTH };
      }
    }

    const mode = settings.autoExportMode === 'incremental' ? 'incremental' : 'full';
    const dest = ['local', 'webdav', 'both'].includes(settings.autoExportDestination) ? settings.autoExportDestination : 'local';
    const useZip = settings.autoExportZip === true && dest !== 'webdav';
    const exportFilter = mode === 'incremental' ? { lo: since, loOpen: true } : {};
    const toExport = sqlMode ? null : (mode === 'incremental' ? entries.filter(e => e.visitTime > since) : entries);
    const exportCount = sqlMode ? (await EhStore.page({ ...exportFilter, limit: 0 })).total : toExport.length;
    if (!exportCount) return { skipped: true, reason: 'nothing_new' };

    const exportData = {
      exportedAt: new Date(now).toISOString(),
      totalEntries: exportCount,
      entries: toExport,
      auto: true,
      autoExportMode: mode,
      autoExportIntervalMonths: interval,
    };

    // Download via the same mechanism session auto-save uses — an open (or
    // briefly-opened) history.html tab pulls the data in chunks and saves it via
    // a Blob + <a download> click. Avoids needing the "downloads" permission.
    const { entries: _omit, ...meta } = exportData;
    const encryptThis = mode === 'incremental' && settings.autoExportEncrypt === true && !!settings.autoExportEncKey && !!settings.autoExportEncSalt;
    const makeJson = () => {
      const raw = sqlMode
        ? { lazy: sqlExportParts(meta, '', exportFilter) }        // SQLite: streamed slice by slice
        : buildExportParts(meta, toExport.map(slimEntry));        // array of string parts, not one big string
      return maybeEncryptExport(raw, settings, mode).content;
    };
    const baseName = `extended-history-auto_${mode === 'incremental' ? 'incremental' : 'full'}_${new Date(now).toISOString().slice(0, 10)}${encryptThis ? '_enc' : ''}`;
    const filename = useZip ? `${baseName}.zip` : `${baseName}.json`;
    let downloaded = false;
    let uploaded = false;
    if (dest === 'local' || dest === 'both') {
      downloaded = useZip
        ? await downloadViaPage(makeJson(), filename, 'application/zip', { zipEntryName: `${baseName}.json` })
        : await downloadViaPage(makeJson(), filename, 'application/json');
      if (!downloaded) return { skipped: true, reason: 'download_failed' };
    }
    if (dest === 'webdav' || dest === 'both') {
      const webDavName = useZip ? filename.replace(/\.zip$/i, '.json') : filename;
      try { await uploadWebDavExport(makeJson(), webDavName, 'application/json', settings); }
      catch (e) { uploaded = false; return { skipped: true, reason: 'webdav_failed', error: e.message }; }
      uploaded = true;
    }

    await saveSettings({ autoExportLastRunAt: now, autoExportLastCoveredTo: now - AUTO_EXPORT_OVERLAP_MS,
                         ...(mode === 'incremental' ? { autoExportLastIncremental: { since, until: now, at: now, count: exportCount } } : {}) });
    return { success: true, exported: exportCount, filename, uploaded, downloaded, encrypted: encryptThis };
  } finally {
    _autoExportRunning = false;
  }
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
  if (alarm.name === 'eh_auto_export_check') {
    await checkAutoExport().catch(() => {});
    return;
  }
  if (alarm.name === 'eh_flush') {
    const intervalMins = await getSyncInterval();
    // intervalMins === 0 means "flush on every visit" (legacy mode) — skip timer flush
    const last = await getLastFlush();
    if (intervalMins > 0 && Date.now() - last >= intervalMins * 60 * 1000) {
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

// Downloads content by handing it to an open (or briefly-opened) history.html
// tab, which does the actual save via a Blob + <a download> click. This is how
// session auto-save has always worked, and it means the extension never needs
// the "downloads" permission at all. Used for both session auto-save and
// history auto-export.
async function downloadViaPage(content, filename, mime, opts) {
  const extPageUrl = browser.runtime.getURL('html/history.html');

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
    console.warn('[EH] downloadViaPage: could not get tab:', e.message);
    return false;
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

  let ok = true;
  let jobId = null;
  try {
    const payload = {
      type: 'AUTO_SAVE_DOWNLOAD',
      mime: mime || 'text/html',
      filename,
      zipEntryName: opts && opts.zipEntryName ? opts.zipEntryName : undefined, // set → page zips the data first
    };
    if (content && content.lazy) {      // SQLite export: generated on demand as the page pulls
      jobId = registerExportJob({ gen: content.lazy });
      payload.pullId = jobId;
    } else if (Array.isArray(content)) {       // big payload: the page pulls the parts itself
      jobId = registerExportJob(content);
      payload.pullId = jobId;
      payload.pullCount = content.length;
    } else {
      payload.content = content;
    }
    // New-style pages answer once the file has been handed to the browser; old ones answer nothing.
    const resp = await browser.tabs.sendMessage(tabId, payload);
    if (resp && resp.ok === false) { console.warn('[EH] downloadViaPage: page failed:', resp.error); ok = false; }
  } catch (e) {
    console.warn('[EH] downloadViaPage: send failed:', e.message);
    ok = false;
  } finally {
    if (jobId) _exportJobs.delete(jobId);
  }

  // Close the tab we opened (leave user's existing tab alone)
  if (didOpen) {
    setTimeout(async () => {
      try { await browser.tabs.remove(tabId); } catch {}
    }, 3000);
  }
  return ok;
}

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

  const ok = await downloadViaPage(htmlBody, 'extended-history-session.html', 'text/html');
  if (ok) _lastAutoSave = Date.now();
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
  return Array.isArray(r[TAB_STORAGE_KEY]) ? r[TAB_STORAGE_KEY] : [];   // envelope object while locked
}
async function removeTabStorageEntry(id) {
  const stored = await getTabStorage();
  const next = stored.filter(e => e.id !== id);
  await browser.storage.local.set({ [TAB_STORAGE_KEY]: next });
  return next;
}
// ── Auto-store: idle detection via accumulated browser-running time ──────────
// IMPORTANT: we deliberately do NOT use `now - tab.lastAccessed` directly.
// tab.lastAccessed is a wall-clock timestamp, so if the PC/browser is off or
// asleep for the night, that entire downtime silently counts as "idle" the
// moment the browser wakes up, causing tabs to get auto-stored almost
// instantly even though they were only idle a few real minutes while the
// browser was actually running.
//
// Instead we keep a persisted idle-time accumulator that only advances while
// the extension itself is actually ticking (eh_tick fires every ~30s, and
// only while browser is running). Each tick we add the elapsed time since the
// last tick, but CAP that delta — if the gap since the last tick is
// unusually large, the browser/PC was almost certainly off or suspended in
// between, so we don't count that gap as idle-while-running time.
//
// KEYED BY NORMALIZED URL, NOT tab.id: browser hands out brand-new tab.id
// values on every full browser restart (closing browser from the taskbar,
// or a hard power-off/reboot) — even though browser.storage.local persists
// fine across a restart, an id-keyed accumulator would find no match for
// any restored tab and silently reset every tab to 0 idle time on every
// reboot. Keying by URL survives that, since the restored tab has the same
// URL as before. Tradeoff: two simultaneously-open tabs with the exact same
// URL share one accumulator (rare, and low-stakes if it happens).
//
// Resets are event-driven (see the onActivated/onUpdated listeners below)
// rather than inferred by comparing tab.lastAccessed — lastAccessed's exact
// behavior across a session restore isn't reliably documented, so trusting
// it as a "was this tab actually used" signal risks the same reset-on-
// reboot bug this whole scheme exists to avoid.
const TAB_IDLE_TRACK_KEY = 'eh_tab_idle_track';
const TAB_IDLE_TICK_CAP_MS = 5 * 60 * 1000; // ignore gaps longer than this between ticks

async function getTabIdleTrack() {
  const r = await browser.storage.local.get(TAB_IDLE_TRACK_KEY);
  const track = r[TAB_IDLE_TRACK_KEY] || { lastCheck: Date.now(), tabs: {} };
  // Defensive: discard anything left over from the old tab.id-keyed schema
  // (values used to be {idleMs, lastAccessed} objects; now they're plain numbers).
  for (const k of Object.keys(track.tabs)) {
    if (typeof track.tabs[k] !== 'number') delete track.tabs[k];
  }
  return track;
}

// Reset a URL's idle accumulator to 0 the moment it's actually used —
// called from real tab-activation/navigation events, never inferred.
async function resetTabIdle(url) {
  if (!url || !isTrackable(url)) return;
  const norm = normalizeUrl(url);
  const track = await getTabIdleTrack();
  if (track.tabs[norm] === 0) return; // nothing to change, skip the write
  track.tabs[norm] = 0;
  await browser.storage.local.set({ [TAB_IDLE_TRACK_KEY]: track });
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab?.url) await resetTabIdle(tab.url);
  } catch {}
});
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) resetTabIdle(info.url).catch(() => {});
});

async function runAutoStore() {
  if (!_autoStoreEnabled) return;
  if (await isLocked()) return;
  const thresholdMs = _autoStoreHours * 3600000;
  const now = Date.now();

  let tabs;
  try {
    tabs = await browser.tabs.query({});
  } catch { return; }

  const stored = await getTabStorage();
  const storedUrls = new Set(stored.map(e => e.url));

  const track = await getTabIdleTrack();

  // Elapsed time since the previous tick, capped so sleep/shutdown gaps
  // between ticks are never counted as "browser running" idle time.
  const rawDelta = now - (track.lastCheck || now);
  const delta = Math.max(0, Math.min(rawDelta, TAB_IDLE_TICK_CAP_MS));
  track.lastCheck = now;

  const liveUrls = new Set();
  const toStore = [];

  for (const tab of tabs) {
    if (!tab.url || !isTrackable(tab.url)) continue;
    const norm = normalizeUrl(tab.url);
    liveUrls.add(norm);

    if (tab.active) {
      // Never auto-store the currently active tab, and make sure its
      // accumulator reads 0 (the onActivated listener already does this on
      // the switch itself; this just keeps things consistent every tick).
      track.tabs[norm] = 0;
      continue;
    }

    const idleMs = (track.tabs[norm] || 0) + delta;
    track.tabs[norm] = idleMs;

    if (storedUrls.has(norm)) continue; // already in tab storage

    // Two independent gates must BOTH clear the threshold before storing:
    //  1) idleMs        — our accumulator, immune to PC-off/sleep inflation
    //  2) wallIdleMs     — raw now-vs-tab.lastAccessed, immune to a stale
    //                      accumulator that never got reset (e.g. the browser
    //                      restores a background/discarded tab with the
    //                      same URL after a reboot without ever firing
    //                      onActivated/onUpdated for it, since it hasn't
    //                      actually reloaded — our event-driven reset would
    //                      silently miss that tab, but tab.lastAccessed
    //                      itself still reflects the real, recent access).
    // Neither gate is trustworthy alone (idleMs can go stale; lastAccessed
    // alone is exactly the original wall-clock-inflation bug) — requiring
    // both is what makes this safe.
    const wallIdleMs = now - (tab.lastAccessed ?? now);
    if (idleMs >= thresholdMs && wallIdleMs >= thresholdMs) {
      toStore.push({ tab, norm });
    }
  }

  // Garbage-collect tracking entries for URLs no longer open in any tab.
  for (const norm of Object.keys(track.tabs)) {
    if (!liveUrls.has(norm)) delete track.tabs[norm];
  }

  await browser.storage.local.set({ [TAB_IDLE_TRACK_KEY]: track });

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
    delete track.tabs[norm];
  }
  await browser.storage.local.set({ [TAB_STORAGE_KEY]: stored, [TAB_IDLE_TRACK_KEY]: track });
}

async function getSessions() {
  const r = await browser.storage.local.get(SESSIONS_KEY);
  return Array.isArray(r[SESSIONS_KEY]) ? r[SESSIONS_KEY] : [];         // envelope object while locked
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
  if (await isLocked()) return;   // else a restart while locked writes open-tab URLs to eh_cur_session in plaintext
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
  if (settings.contextMenuEnabled === false || await isLocked()) {
    // Right-click menu disabled by the user, or the extension is locked — just clear it out.
    browser.contextMenus.removeAll();
    return;
  }
  await browser.contextMenus.removeAll().catch(() => {});
  const made = (what) => () => { if (browser.runtime.lastError) console.warn('[EH] ' + what + ' failed:', browser.runtime.lastError.message); };
  browser.contextMenus.create({
    id: CONTEXT_MENU_PARENT_ID,
    title: 'Extended History',
    contexts: ['page', 'frame'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  }, made('context menu parent'));

  browser.contextMenus.create({
    id: CONTEXT_MENU_IGNORE_DOMAIN_ID,
    parentId: CONTEXT_MENU_PARENT_ID,
    title: "Don't keep this domain in history",
    contexts: ['page', 'frame'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  }, made('ignore menu'));

  browser.contextMenus.create({
    id: CONTEXT_MENU_STORE_TAB_ID,
    parentId: CONTEXT_MENU_PARENT_ID,
    title: 'Store this tab',
    contexts: ['page', 'frame'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  }, made('store tab menu'));
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

// The background page is persistent and reloads with the browser, but toolbar icon / popup mode are not remembered by
// the browser — apply them whenever this page starts (also covers the extension being reloaded or updated).
getSettings().then(s0 => { applyToolbarIcon(s0.toolbarIcon); applyPopupMode(s0.popupAsSidebar === true); }).catch(() => {});

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
    browser.tabs.create({ url: browser.runtime.getURL('html/tutorial.html') });
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
      url:normalizeUrl(i.url), ...rawUrlField(normalizeUrl(i.url), i.url), title:i.title||'',
      visitTime:i.lastVisitTime||Date.now(), domain:domainOf(i.url),
    }));
    if (await _useSql()) {
      if (await EhStore.insertIgnore(entries)) { _entriesCache = null; await updateTodayHistory(); }
    } else {
      const existing    = await getAll();
      const existingSet = new Set(existing.map(e=>`${e.url}|${Math.floor(e.visitTime/5000)}`));
      const newOnes     = entries.filter(e=>!existingSet.has(`${e.url}|${Math.floor(e.visitTime/5000)}`));
      if (newOnes.length) {
        await setAll([...existing,...newOnes].sort((a,b)=>b.visitTime-a.visitTime));
        await updateTodayHistory();
      }
    }
    await browser.storage.local.set({ [BACKFILL_KEY]:true });
    //console.log(`[EH] Backfilled ${newOnes.length} entries`);
  } catch(e) { console.error('[EH] backfill',e); }
});

// ══ LOCK / UNLOCK ════════════════════════════════════════════════════════════
// "Lock" first merges today's native history into the extension's history, then
// encrypts history entries, sessions, stored tabs, the ignore list and quick
// filters (and nothing else) with the same AES-GCM + PBKDF2 scheme as encrypted
// exports, stores the ciphertext in browser.storage.local, wipes the plaintext
// copies and deletes the browser's native history (optionally cookies/site data too). While locked, getAll() returns [] and every
// write path is a no-op, and handle() rejects everything except the messages in
// LOCK_ALLOWED_TYPES. "Unlock" decrypts, restores the data, then re-seeds native
// history with the most visited URLs/domains.
const LOCK_STATE_KEY  = 'eh_locked';        // true while locked
const LOCK_BLOB_KEY   = 'eh_locked_blob';   // { __eh_encrypted, salt, iv, ct, lockedAt, totalEntries }
const LOCK_KEEP_SAVING_KEY = 'eh_lock_keep_saving'; // true if "Keep saving history while locked" was ticked
const LOCK_SKIP_SEED_KEY = 'eh_lock_skip_seed'; // true → after unlocking, don't put the most visited URLs/domains back into the browser's history
const SEED_WINDOW_KEY = 'eh_seed_window';   // URLs we re-added to native history on unlock
const RESTORED_AT_KEY = 'eh_restored_at';   // time of the last unlock; only used so the Today views can show pre-lock visits (see restoredEntriesSince)
// How much native history to re-create on unlock (browser.history.addUrl is one
// call per URL and can only stamp "now", so keep this modest for huge histories).
const RESTORE_TOP_URLS    = 250;
const RESTORE_TOP_DOMAINS = 250;
const RESTORE_BATCH_SIZE  = 25;
const LOCK_ALLOWED_TYPES  = new Set(['GET_LOCK_STATUS', 'GET_LOCK_PLAN', 'GET_MIGRATION_STATUS', 'UNLOCK_HISTORY', 'GET_SETTINGS', 'GET_CLEANUP_STATUS']);

let _lockedCache = null;
let _lockBusy    = false;
let _keepSavingCache = null;
async function isLocked() {
  if (_lockedCache === null) {
    const r = await browser.storage.local.get(LOCK_STATE_KEY);
    _lockedCache = r[LOCK_STATE_KEY] === true;
  }
  return _lockedCache;
}
// "Keep saving history while locked" — opt-in, unchecked by default. Doesn't change
// any write-gating (native browser.history keeps recording regardless of this flag —
// the browser does that on its own and no extension can stop it); what it changes is
// unlockHistory()'s behavior: with it on, whatever browser.history accumulated between
// lockedAt and now is pulled in and merged into the restored history instead of being
// thrown away. The UI itself stays fully hidden while locked either way.
async function lockKeepSaving() {
  if (_keepSavingCache === null) {
    const r = await browser.storage.local.get(LOCK_KEEP_SAVING_KEY);
    _keepSavingCache = r[LOCK_KEEP_SAVING_KEY] === true;
  }
  return _keepSavingCache;
}

function _lkB64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}
function _lkU8(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function _lkKey(password, salt, usage) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
async function _lkEncrypt(plaintext, password) {   // same output shape as ehEncrypt() in history.js
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await _lkKey(password, salt, 'encrypt');
  const ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { salt: _lkB64(salt), iv: _lkB64(iv), ct: _lkB64(ct) };
}
async function _lkDecrypt({ salt, iv, ct }, password) {
  const key   = await _lkKey(password, _lkU8(salt), 'decrypt');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _lkU8(iv) }, key, _lkU8(ct));
  return new TextDecoder().decode(plain);
}

// Visits we re-create in native history on unlock all carry "now" as their visit
// time. Remember them so the Today view / periodic flush don't mistake them for
// real browsing and copy them into the extension's history as fresh visits.
let _seedWin;   // undefined = not loaded yet, null = none
async function getSeedWindow() {
  if (_seedWin !== undefined) return _seedWin;
  const w = (await browser.storage.local.get(SEED_WINDOW_KEY))[SEED_WINDOW_KEY];
  _seedWin = w ? { start: w.start, end: w.end, urls: new Set(w.urls || []) } : null;
  return _seedWin;
}
async function setSeedWindow(w) {
  _seedWin = w ? { start: w.start, end: w.end, urls: new Set(w.urls) } : null;
  await browser.storage.local.set({ [SEED_WINDOW_KEY]: w ? { start: w.start, end: w.end, urls: [...w.urls] } : null });
}

// After an unlock, the browser's own history no longer contains the visits from before the
// lock (it was deleted), but "Today" / rolling-24h views read only from the browser's live
// history. Add back the stored entries newer than sinceMs and older than the unlock time.
async function restoredEntriesSince(sinceMs, liveEntries) {
  const floor = (await browser.storage.local.get(RESTORED_AT_KEY))[RESTORED_AT_KEY] || 0;
  if (!floor) return [];
  const seen = new Set(liveEntries.map(e => `${e.url}|${Math.floor(e.visitTime / 5000)}`));
  return (await getEntriesBetween(sinceMs, floor)).filter(e => e.visitTime < floor
                                   && !seen.has(`${e.url}|${Math.floor(e.visitTime / 5000)}`));
}

function pickRestoreUrls(entries) {
  const urlCounts = new Map(), domCounts = new Map();
  for (const e of entries) {
    if (!e.url || !isTrackable(e.url)) continue;
    urlCounts.set(e.url, (urlCounts.get(e.url) || 0) + 1);
    const d = e.domain || domainOf(e.url);
    if (d) domCounts.set(d, (domCounts.get(d) || 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
  const out = new Map();   // normalized url → url to add (dedupes "https://x.com" vs "https://x.com/")
  for (const u of top(urlCounts, RESTORE_TOP_URLS)) out.set(normalizeUrl(u), u);
  for (const d of top(domCounts, RESTORE_TOP_DOMAINS)) { const u = `https://${d}/`; if (!out.has(normalizeUrl(u))) out.set(normalizeUrl(u), u); }
  return out;
}
async function addUrlSafe(url) {
  try { await browser.history.addUrl({ url }); } catch (_) {}
}

// ── Bookmarks: snapshot / delete / recreate (folder structure preserved) ─────────
// Nodes are stored as { title, url } or { title, children: [...] }.
// Firefox names its root folders (and has no folderType); they are mapped to the same type names
// Chrome uses, so exports and the lock snapshot stay interchangeable between the two browsers.
const BM_ROOT_TYPES = { toolbar_____: 'bookmarks-bar', unfiled_____: 'other', mobile______: 'mobile', menu________: 'menu' };
const bmRootType = r => r.folderType || BM_ROOT_TYPES[r.id] || '';
async function bmRoots() { const [root] = await browser.bookmarks.getTree(); return root.children || []; }
function bmRootByType(roots, type) {
  return roots.find(r => bmRootType(r) === type);
}
async function snapshotBookmarks() {
  const strip = n => n.url ? { title: n.title, url: n.url }
                           : { title: n.title, children: (n.children || []).filter(c => !c.unmodifiable).map(strip) };
  return (await bmRoots()).filter(r => !r.unmodifiable && r.folderType !== 'managed').map((r, i) => ({
    index: i, id: r.id, folderType: bmRootType(r), title: r.title,
    children: (r.children || []).filter(c => !c.unmodifiable).map(strip),
  }));
}
async function deleteAllBookmarks() {
  const ids = [];
  for (const r of await bmRoots()) {
    if (r.unmodifiable || r.folderType === 'managed') continue;
    for (const c of (r.children || [])) if (!c.unmodifiable) ids.push(c.id);
  }
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map(id => browser.bookmarks.removeTree(id).catch(() => {})));
  }
}
// Creates nodes under parentId in order; sub-folders are filled concurrently. Returns # of bookmarks created.
async function createBookmarkNodes(parentId, nodes) {
  let count = 0; const subs = [];
  for (const n of (nodes || [])) {
    try {
      if (n.url) { await browser.bookmarks.create({ parentId, title: n.title || n.url, url: n.url }); count++; }
      else if (Array.isArray(n.children)) { const f = await browser.bookmarks.create({ parentId, title: n.title || '' }); subs.push([f.id, n.children]); }
    } catch {}
  }
  const counts = await Promise.all(subs.map(([id, ch]) => createBookmarkNodes(id, ch)));
  return count + counts.reduce((a, b) => a + b, 0);
}
async function restoreBookmarkRoots(saved) {
  const roots = await bmRoots(); let count = 0;
  for (const s of saved) {
    const target = (s.folderType && roots.find(r => bmRootType(r) === s.folderType)) || roots.find(r => r.id === s.id) || roots[s.index];
    if (target) count += await createBookmarkNodes(target.id, s.children);
  }
  return count;
}
// Imports a parsed Netscape-HTML tree. Top-level folders flagged (or named) as a root merge into that root;
// everything else goes to "Other bookmarks", as the old flat import did.
async function importBookmarkTree(tree) {
  const roots = await bmRoots();
  const other = bmRootByType(roots, 'other') || roots[0];
  const flat = [];
  for (const n of tree) (n.children && !n.title && !n.rootType) ? flat.push(...n.children) : flat.push(n);   // old exports wrap everything in an untitled folder
  let count = 0; const loose = [];
  for (const n of flat) {
    const target = n.children && ((n.rootType && bmRootByType(roots, n.rootType)) ||
                                  roots.find(r => r.title && r.title === n.title && !r.unmodifiable));
    if (target) count += await createBookmarkNodes(target.id, n.children); else loose.push(n);
  }
  return count + await createBookmarkNodes(other.id, loose);
}

// Encrypting the history means holding all of it as ONE string (JS caps strings at ~512 MB →
// "invalid string length") and running AES over it, so above this size the history itself is
// left where it is — unencrypted — and only the UI is locked. Sessions, tabs, time data etc. are
// still encrypted either way.
const LOCK_ENCRYPT_LIMIT_MB = 250;
async function lockPlan() {
  const b = await _backend();
  if (b === 'sqlite') {      // the database file's real size — no COUNT(*) over a huge table
    let bytes = 0;
    try { bytes = await withTimeout(EhStore.size(), 20000, 'size'); } catch (_) {}
    const mb = bytes / 1048576;
    return { entries: null, sizeMB: Math.round(mb), limitMB: LOCK_ENCRYPT_LIMIT_MB, encryptHistory: mb <= LOCK_ENCRYPT_LIMIT_MB };
  }
  const entries = b === 'local' ? ((await browser.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || []).length : await EhStore.count();
  const mb = b === 'local' ? (await bytesInUse(HISTORY_KEY)) / 1048576 : entries * 250 / 1048576;   // ≈250 bytes per entry as JSON
  return { entries, sizeMB: Math.round(mb), limitMB: LOCK_ENCRYPT_LIMIT_MB, encryptHistory: mb <= LOCK_ENCRYPT_LIMIT_MB };
}

// Big history (above the limit): only the interface is locked. NOTHING else is read or encrypted — touching
// sessions / tabs / time data is pointless next to a plaintext multi-hundred-MB database and made locking slow.
// A tiny encrypted blob is still stored so the password can be verified on unlock.
async function lockBigHistory(password, clearSiteData, hideBookmarks, keepSaving) {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), historyKept: true, minimal: true, entries: [],
    bookmarks: hideBookmarks ? await snapshotBookmarks() : undefined });
  const enc = await _lkEncrypt(payload, password);
  await browser.storage.local.set({ [LOCK_BLOB_KEY]: { __eh_encrypted: true, ...enc, lockedAt: Date.now(), totalEntries: 0, historyKept: true } });
  await browser.storage.local.set({ [LOCK_STATE_KEY]: true, [LOCK_KEEP_SAVING_KEY]: !!keepSaving });
  _lockedCache = true; _keepSavingCache = !!keepSaving;
  try { browser.contextMenus.removeAll(); } catch {}
  _entriesCache = null; _entriesLoading = null;
  sessionId = null; sessionTabs = {}; sessionStart = null;
  await browser.storage.local.remove([TODAY_HISTORY_KEY, CURRENT_SESSION_KEY, 'eh_cur_session', SEED_WINDOW_KEY]);
  _seedWin = null;
  try { await browser.history.deleteAll(); } catch (e) { console.error('[EH] lock: history.deleteAll', e); }
  if (hideBookmarks) { try { await deleteAllBookmarks(); } catch (e) { console.error('[EH] lock: deleting bookmarks', e); } }
  if (clearSiteData) {
    try { await removeBrowsingData({ since: 0 }, { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true }); }
    catch (e) { console.error('[EH] lock: browsingData.remove', e); }
  }
  return { success: true, locked: 0, historyEncrypted: false };
}

async function lockHistory(password, clearSiteData, hideBookmarks, keepSaving, acceptUnencrypted) {
  if (typeof password !== 'string' || password.length < 4) throw new Error('Password must be at least 4 characters');
  if (_lockBusy) throw new Error('Lock already in progress');
  if (await isLocked()) throw new Error('Already locked');
  _lockBusy = true;
  let flagSet = false;
  try {
    const plan = await lockPlan();
    const big = !plan.encryptHistory;
    if (big && !acceptUnencrypted) return { error: `History is too big to encrypt (${plan.sizeMB} MB, limit ${plan.limitMB} MB). It will stay unencrypted; only the interface is locked. Confirm to continue.`, needsConfirm: true, plan };
    // 1. Merge first: pull today's native history into the extension's own history so
    //    nothing browsed since the last periodic flush is lost when native history is wiped.
    //    If this throws, we abort here and nothing has been deleted.
    await flushTodayToHistory();
    if (big) return await lockBigHistory(password, clearSiteData, hideBookmarks, keepSaving);
    try { await finishSession(); } catch {}          // so the current session is part of the snapshot

    // 2. Snapshot exactly what gets encrypted: history, sessions, stored tabs, ignore list,
    //    quick filters, and time-tracking data (eh_time — per-domain browsing time is just as
    //    revealing as the history entries themselves, so it has to be swept too, not left as
    //    the one plaintext dataset sitting next to everything else that's encrypted).
    const entries  = big ? [] : await getAll(true);
    const sessions = await getSessions();
    const st = await browser.storage.local.get([TAB_STORAGE_KEY, IGNORE_LIST_KEY, QUICK_FILTERS_KEY, TIME_KEY]);
    const payload  = JSON.stringify({
      exportedAt: new Date().toISOString(), totalEntries: big ? plan.entries : entries.length, historyKept: big, entries, sessions,
      bookmarks:    hideBookmarks ? await snapshotBookmarks() : undefined,
      tabStorage:   st[TAB_STORAGE_KEY]   || [],
      ignoreList:   st[IGNORE_LIST_KEY]   || [],
      quickFilters: st[QUICK_FILTERS_KEY] || [],
      timeData:     st[TIME_KEY]          || {},
    });

    const enc = await _lkEncrypt(payload, password);
    await browser.storage.local.set({ [LOCK_BLOB_KEY]: { __eh_encrypted: true, ...enc, lockedAt: Date.now(), totalEntries: big ? plan.entries : entries.length, historyKept: big } });

    // Read the ciphertext back and decrypt it BEFORE deleting anything.
    const back  = (await browser.storage.local.get(LOCK_BLOB_KEY))[LOCK_BLOB_KEY];
    const check = await _lkDecrypt(back, password);
    if (check.length !== payload.length) throw new Error('Encrypted copy failed verification — nothing was deleted');

    // The five small datasets are ALSO encrypted in place, under their own storage keys, so
    // nothing readable is left there. The blob above still holds a copy of each, and unlock
    // restores from the blob, so a stray write to one of these keys while locked can't lose data.
    const inPlace = {};
    for (const [key, val] of [[SESSIONS_KEY, sessions], [TAB_STORAGE_KEY, st[TAB_STORAGE_KEY] || []],
                              [IGNORE_LIST_KEY, st[IGNORE_LIST_KEY] || []], [QUICK_FILTERS_KEY, st[QUICK_FILTERS_KEY] || []],
                              [TIME_KEY, st[TIME_KEY] || {}]]) {
      inPlace[key] = { __eh_encrypted: true, ...(await _lkEncrypt(JSON.stringify(val), password)) };
    }

    // ── Point of no return ──
    await browser.storage.local.set({ [LOCK_STATE_KEY]: true, [LOCK_KEEP_SAVING_KEY]: !!keepSaving });
    flagSet = true; _lockedCache = true; _keepSavingCache = !!keepSaving;
    await browser.storage.local.set(inPlace);     // overwrites the plaintext values with ciphertext
    try { browser.contextMenus.removeAll(); } catch {}    // no right-click menu while locked

    _entriesCache = null; _entriesLoading = null;
    sessionId = null; sessionTabs = {}; sessionStart = null;
    if (!big) { try { if (await _useIdb()) await EhStore.clear(); } catch (e) { console.error('[EH] lock: idb clear', e); } }
    await browser.storage.local.remove([...(big ? [] : [HISTORY_KEY]), TODAY_HISTORY_KEY, CURRENT_SESSION_KEY, 'eh_cur_session', SEED_WINDOW_KEY]);
    _seedWin = null;
    try { await browser.history.deleteAll(); } catch (e) { console.error('[EH] lock: history.deleteAll', e); }
    if (hideBookmarks) {
      try { await deleteAllBookmarks(); } catch (e) { console.error('[EH] lock: deleting bookmarks', e); }
    }
    if (clearSiteData) {
      // "Logout everywhere": cookies + site data for regular websites (default originTypes,
      // so this never touches the extension's own storage/IndexedDB).
      try {
        await removeBrowsingData({ since: 0 }, { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: true });
      } catch (e) { console.error('[EH] lock: browsingData.remove', e); }
    }
    return { success: true, locked: big ? plan.entries : entries.length, historyEncrypted: !big };
  } catch (err) {
    if (!flagSet) await browser.storage.local.remove(LOCK_BLOB_KEY).catch(() => {});
    throw err;
  } finally { _lockBusy = false; }
}

async function unlockHistory(password, skipSeedArg) {
  if (_lockBusy) throw new Error('Busy — try again in a moment');
  if (!(await isLocked())) return { success: true, alreadyUnlocked: true };
  _lockBusy = true;
  try {
    const blob = (await browser.storage.local.get(LOCK_BLOB_KEY))[LOCK_BLOB_KEY];
    if (!blob) throw new Error('No locked data found');
    let data;
    try { data = JSON.parse(await _lkDecrypt(blob, String(password || ''))); }
    catch { throw new Error('Wrong password'); }

    const kept = data.historyKept === true || blob.historyKept === true;     // big history was never removed/encrypted
    let entries = Array.isArray(data.entries) ? data.entries : [];
    const keepSaving = await lockKeepSaving();
    let mergedCount = 0;
    if (keepSaving && blob.lockedAt) {
      // browser keeps recording native history the whole time locked no matter what —
      // no extension setting can stop that. With "Keep saving" on, pull in whatever
      // accumulated since lock time and merge it into the restored set instead of
      // throwing it away (the plain deleteAll() below, when this option is off).
      // Bounded to visits after lockedAt, so there's no overlap with the pre-lock
      // `entries` above — a plain concat is enough, no dedup needed.
      try {
        const since = await _liveHistoryEntries({ startTime: blob.lockedAt });
        if (since.length) { entries = entries.concat(since); mergedCount = since.length; }
      } catch (e) { console.error('[EH] unlock: merging locked-period history', e); }
    }
    if (kept) { if (entries.length && await _useSql()) await EhStore.insertIgnore(entries); }
    else await setAll(entries, true);
    const restore = {};
    if (!data.minimal) {            // a "minimal" lock (big history) never touched these, so there is nothing to restore
    restore[SESSIONS_KEY] = Array.isArray(data.sessions) ? data.sessions : [];
    if (Array.isArray(data.tabStorage))   restore[TAB_STORAGE_KEY]   = data.tabStorage;
    if (Array.isArray(data.ignoreList))   restore[IGNORE_LIST_KEY]   = data.ignoreList;
    if (Array.isArray(data.quickFilters)) restore[QUICK_FILTERS_KEY] = data.quickFilters;
    }
    // Always restore eh_time explicitly (rather than only when present) so that unlocking a
    // blob locked before eh_time was swept in doesn't leave its in-place ciphertext behind —
    // falls back to {} for those older blobs instead of leaving unreadable garbage under the key.
    if (!data.minimal) restore[TIME_KEY] = (data.timeData && typeof data.timeData === 'object') ? data.timeData : {};
    restore[RESTORED_AT_KEY] = Date.now();
    await browser.storage.local.set(restore);
    if (Array.isArray(data.bookmarks)) await restoreBookmarkRoots(data.bookmarks);   // "Hide bookmarks" was ticked when locking

    // Without "Keep saving": wipe whatever browser recorded while locked (nothing is
    // merged), then re-create the top URLs/domains in batches. With it on, the
    // locked-period browsing is already sitting in browser.history and already merged
    // into `entries` above — don't delete it, just layer the pre-lock URLs back in
    // alongside it.
    if (!keepSaving) {
      try { await browser.history.deleteAll(); } catch (e) { console.error('[EH] unlock: history.deleteAll', e); }
    }
    const skipSeed = typeof skipSeedArg === 'boolean' ? skipSeedArg : (await browser.storage.local.get(LOCK_SKIP_SEED_KEY))[LOCK_SKIP_SEED_KEY] === true;
    let seed = new Map();
    if (skipSeed) {
      // "Don't put the most visited sites back into the browser history": the browser's own history stays empty.
    } else if (kept) {          // history is still in the database: pick the most-visited from there
      if (await _useSql()) {
        for (const x of await EhStore.topBy({ column: 'url', limit: RESTORE_TOP_URLS })) if (x.identifier && isTrackable(x.identifier)) seed.set(normalizeUrl(x.identifier), x.identifier);
        for (const x of await EhStore.topBy({ column: 'domain', limit: RESTORE_TOP_DOMAINS })) { const u = `https://${x.identifier}/`; if (!seed.has(normalizeUrl(u))) seed.set(normalizeUrl(u), u); }
      }
    } else seed = pickRestoreUrls(entries);
    const list = [...seed.values()];
    if (list.length) {
      await setSeedWindow({ start: Date.now() - 1000, end: null, urls: [...seed.keys()] });
      for (let i = 0; i < list.length; i += RESTORE_BATCH_SIZE) {
        await Promise.all(list.slice(i, i + RESTORE_BATCH_SIZE).map(addUrlSafe));
      }
      await setSeedWindow({ start: _seedWin.start, end: Date.now() + 1000, urls: [...seed.keys()] });
    }

    // Now unlock the UI. The ciphertext is removed only after everything is restored.
    await browser.storage.local.set({ [LOCK_STATE_KEY]: false });
    _lockedCache = false;
    _keepSavingCache = null;
    await browser.storage.local.remove([LOCK_BLOB_KEY, LOCK_KEEP_SAVING_KEY, LOCK_SKIP_SEED_KEY]);
    await ensureContextMenus();

    try { await beginSession(); } catch {}
    return { success: true, restored: kept ? (blob.totalEntries || 0) : entries.length, seeded: list.length, merged: mergedCount };
  } finally { _lockBusy = false; }
}

// ── History storage — switches between localStorage and IndexedDB ─────────────
// Three possible stores for the history:
//   'sqlite' — SQLite (WASM) on disk, queried with SQL; nothing is held in JS memory (best for big histories)
//   'idb'    — IndexedDB
//   'local'  — one big array in browser.storage.local
let _backendKind = null;
async function _backend() {
  if (_backendKind) return _backendKind;
  const r = await browser.storage.local.get([IDB_STORAGE_KEY, SQL_STORAGE_KEY]);
  _backendKind = r[SQL_STORAGE_KEY] === true ? 'sqlite' : (r[IDB_STORAGE_KEY] === true ? 'idb' : 'local');
  return _backendKind;
}
browser.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && (ch[IDB_STORAGE_KEY] || ch[SQL_STORAGE_KEY])) _backendKind = null;
});
async function _useIdb() { return (await _backend()) !== 'local'; }    // "a database store" (IndexedDB or SQLite)
async function _useSql() { return (await _backend()) === 'sqlite'; }
// Same API on both database stores — calls go to whichever is active.
const EhStore = new Proxy({}, {
  get: (_t, name) => async (...args) => {
    const store = (await _backend()) === 'sqlite' ? EhSql : EhIdb;
    if (typeof store[name] !== 'function') throw new Error(`${name}() is not available on this storage backend`);
    return store[name](...args);
  },
});
// In-memory mirror of full history, kept warm for the life of the service worker.
// This is the actual reason date-switching was slow: every SEARCH call used to
// re-read + re-parse the entire history blob from browser.storage/IndexedDB from
// scratch. Reading Mode felt fast because it never touches storage at all after
// the initial file load — this cache gives normal History that same behavior
// without duplicating the whole dataset into the page's memory.
// Races a promise against a timeout so a stuck browser.* call (storage write,
// history.deleteUrl, IDB transaction, etc.) can't hang a message handler
// forever — the caller gets a rejected promise instead of silence.
// browser.history.deleteUrl() *should* return a Promise when called without a
// callback, but empirically that form was hanging indefinitely here — never
// resolving, never rejecting, silently stalling whatever awaited it. Using the
// traditional explicit callback form is the one calling convention every
// browser version has always supported correctly for this API, so use that
// instead everywhere we delete a URL from native history.
async function deleteUrlSafe(url) {
  try { await browser.history.deleteUrl({ url }); }
  catch (e) { console.log('[EH][bg] deleteUrl failed for', url, ':', e && e.message); }
}

// Deletes a batch of URLs from native browser history with limited concurrency.
// Firing hundreds/thousands of browser.history.deleteUrl() calls all at once via
// a single unbounded Promise.all() can overwhelm the browser's history backend —
// this processes them in small chunks instead.
async function deleteUrlsBatched(urls, concurrency = 8) {
  const arr = Array.isArray(urls) ? urls : [...urls];
  for (let i = 0; i < arr.length; i += concurrency) {
    const chunk = arr.slice(i, i + concurrency);
    await Promise.all(chunk.map(url => deleteUrlSafe(url)));
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

let _entriesCache = null;

// Whole history in memory. Only the heavy analytics handlers need this; the main page
// (SEARCH / GET_STATS / flush) is answered from IndexedDB indexes instead — see below.
// Concurrent callers share ONE load: several requests arriving while the cache was cold
// used to each load their own full copy of the history (multiples of GB).
let _entriesLoading = null;
let _cacheTimer = null, _lastLegacyPrune = 0;
// Don't keep millions of entries resident after a heavy panel closes — drop the copy when idle.
function _touchCache() { clearTimeout(_cacheTimer); _cacheTimer = setTimeout(() => { _entriesCache = null; }, 120000); }
async function getAll(force) {
  if (_migrating) return [];
  if (!force && await isLocked()) return [];      // locked: the extension has no history to show
  if (_entriesCache) { _touchCache(); return _entriesCache; }
  if (!_entriesLoading) {
    _entriesLoading = (async () => {
      try {
        const loaded = (await _useIdb())
          ? await EhStore.getAll()
          : ((await browser.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || []);
        if (!_entriesCache) _entriesCache = loaded;    // an import/write may have set it meanwhile
        _touchCache();
        return _entriesCache;
      } finally { _entriesLoading = null; }
    })();
  }
  return _entriesLoading;
}
// True when history lives in IndexedDB and is NOT loaded in memory — then reads should go
// to the indexes (cheap) rather than trigger a full load.
async function coldIdb() { return !(await isLocked()) && ((await _useSql()) || (!_entriesCache && await _useIdb())); }
// Stored entries with lo <= visitTime <= hi, from the cache if it's warm, else from the index.
async function getEntriesBetween(lo, hi) {
  if (lo > hi) return [];
  if (await coldIdb()) { try { return await EhStore.getRange(lo, hi); } catch (e) { console.warn('[EH] index read failed, loading all:', e.message); } }
  return (await getAll()).filter(e => e.visitTime >= lo && e.visitTime <= hi);
}
async function setAll(entries, force) {
  if (!force && await isLocked()) return;         // locked: never write plaintext history
  _entriesCache = entries; // update the in-memory copy immediately, before the (slower) persisted write
  if (await _useIdb()) return EhStore.setAll(entries);
  await browser.storage.local.set({ [HISTORY_KEY]: entries });
}

// Removes entries matching any id in idSet or any url in urlSet.
// On the IndexedDB backend this deletes only the affected rows (fast,
// regardless of total history size). On the browser.storage.local backend
// there's no way around rewriting the whole blob — that storage model only
// exposes a single key for the whole array — so this is the one place that
// can still be slow for very large histories on that backend; migrating to
// IndexedDB in Settings avoids it entirely.
async function removeEntries(idSet, urlSet) {
  if (await _useSql()) {                         // find just the matching rows, delete just those
    const found = await EhStore.findByIdsOrUrls(idSet, urlSet);
    if (!found.length) return { removed: [] };
    await EhStore.removeIds(found.map(e => e.id));
    _entriesCache = null;
    return { removed: found };
  }
  const all = await getAll();
  const toRemove = all.filter(e => idSet.has(e.id) || urlSet.has(e.url));
  if (!toRemove.length) return { removed: [] };

  if (await _useIdb()) {
    const removeIdSet = new Set(toRemove.map(e => e.id));
    await withTimeout(EhStore.removeIds([...removeIdSet]), 10000, 'EhStore.removeIds()');
    _entriesCache = all.filter(e => !removeIdSet.has(e.id));
  } else {
    const removeIdSet = new Set(toRemove.map(e => e.id));
    await withTimeout(setAll(all.filter(e => !removeIdSet.has(e.id))), 10000, 'setAll()');
  }
  return { removed: toRemove };
}
// Quick filters (named groups of domains / keywords / URL fragments) are applied here, in the background,
// so they cover the WHOLE history — not just the page of results the history page happens to have loaded.
// Same rules as quick-filters.js: keywords match whole words only ("ana" ≠ "ananas"/"banana"); "ana*" = starts with,
// "*ana" = ends with, "*ana*" = contains. Dotted patterns without space/slash/* are domains.
function qfKeywordRegex(p) {
  let openL = false, openR = false;
  if (p.startsWith('*')) { openL = true; p = p.replace(/^\*+/, ''); }
  if (p.endsWith('*'))   { openR = true; p = p.replace(/\*+$/, ''); }
  if (!p) return null;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const W = '\\p{L}\\p{N}';
  const left  = (!openL && new RegExp('^[' + W + ']', 'u').test(p)) ? '(?<![' + W + '])' : '';
  const right = (!openR && new RegExp('[' + W + ']$', 'u').test(p)) ? '(?![' + W + '])'  : '';
  return new RegExp(left + esc + right, 'iu');
}
function qfMakeMatcher(patterns) {
  const ps = (Array.isArray(patterns) ? patterns : []).map(p => String(p || '').trim().toLowerCase()).filter(Boolean)
    .map(p => (p.includes('.') && !p.includes(' ') && !p.includes('/') && !p.includes('*')) ? { dom: p } : { re: qfKeywordRegex(p) })
    .filter(x => x.dom || x.re);
  if (!ps.length) return null;
  return (e) => {
    const url = String(e.url || '').toLowerCase(), title = String(e.title || '').toLowerCase();
    let domain = String(e.domain || '').toLowerCase();
    if (!domain) { try { domain = new URL(e.url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) {} }
    return ps.some(x => x.dom ? (domain === x.dom || domain.endsWith('.' + x.dom)) : (x.re.test(url) || x.re.test(title)));
  };
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
// the browser's own history DB has the correct title for every URL it has seen.
// We query it and write the result into any recent entry that still lacks a title.
// Write title for the most recent entry matching this URL within the last 2 minutes.
// Always overwrites — if tabs.onUpdated fires twice, the second (final) title wins.
// If no entry exists yet (title fired before recordVisit), retry once after 1.5s.
async function backfillTitle(url, title, _isRetry = false) {
  if (!url || !title || !isTrackable(url)) return;
  if (title === 'New Tab' || title === 'Loading…' || title === 'Loading...') return;
  const norm = normalizeUrl(url);
  if (await _useSql()) {
    const found = await EhStore.updateTitle({ url: norm, title, sinceMs: Date.now() - 300000, onlyIfEmpty: false });
    if (!found && !_isRetry) setTimeout(() => backfillTitle(url, title, true), 1500);   // entry not recorded yet — retry once
    return;
  }
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
      if (await _useSql()) { await EhStore.updateTitle({ url: norm, title, sinceMs: cutoff5, onlyIfEmpty: true }); return; }
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
  if (await _useSql()) {
    const norm = normalizeUrl(url);
    await EhStore.insertIgnore([{ id: `${now}_${Math.random().toString(36).slice(2, 6)}`, url: norm, ...rawUrlField(norm, url), title: title || '', visitTime: now, domain: domainOf(url) }]);
    if (title) await EhStore.updateTitle({ url: norm, title, sinceMs: now - 5000, onlyIfEmpty: true });
    if (now - _lastLegacyPrune > 600000) { _lastLegacyPrune = now; await pruneStoredIdb(cutoff, settings.maxEntries); }
    return;
  }
  let entries    = await getAll();
  const norm     = normalizeUrl(url);
  const dup      = entries.findIndex(e=>e.url===norm && (now-e.visitTime)<5000);
  if (dup !== -1) { if (title && !entries[dup].title) { entries[dup].title=title; await setAll(entries); } return; }
  entries.push({ id:`${now}_${Math.random().toString(36).slice(2,6)}`, url:norm, ...rawUrlField(norm, url), title:title||'', visitTime:now, domain:domainOf(url) });
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

// ── Delete-History domain exceptions ─────────────────────────────────────────
// Domains listed here are skipped by "Delete History" (time-range deletion):
// their history entries, native browser history visits, cookies and site data
// all survive. An exception for example.com also covers its subdomains.
const DELETE_EXCEPTIONS_KEY = 'eh_delete_exceptions';

async function getDeleteExceptions() {
  try {
    const r = await browser.storage.local.get(DELETE_EXCEPTIONS_KEY);
    const list = r[DELETE_EXCEPTIONS_KEY];
    return Array.isArray(list) ? list.filter(d => typeof d === 'string' && d) : [];
  } catch { return []; }
}

function makeExceptionMatcher(exceptions) {
  if (!exceptions.length) return () => false;
  return (url) => {
    const host = domainOf(url);
    return !!host && exceptions.some(d => host === d || host.endsWith('.' + d));
  };
}

// browser.history.deleteRange has no "except" option, so instead we find every
// visit that belongs to an excepted domain inside the range and delete only the
// gaps between them (each excepted visit is fenced off with a tiny 10-microsecond margin).
async function deleteNativeHistoryRangeExcept(startTime, endTime, isExcepted) {
  let items = [];
  try { items = await browser.history.search({ text: '', startTime, endTime, maxResults: 100000 }); } catch {}

  const keepTimes = [];
  for (const it of items) {
    if (!it.url || !isExcepted(it.url)) continue;
    try {
      const visits = await browser.history.getVisits({ url: it.url });
      for (const v of visits) {
        if (v.visitTime >= startTime && v.visitTime <= endTime) keepTimes.push(v.visitTime);
      }
    } catch {}
  }

  if (!keepTimes.length) {
    await browser.history.deleteRange({ startTime, endTime });
    return;
  }

  keepTimes.sort((a, b) => a - b);
  const MARGIN = 0.01; // ms fence (10us) around each protected visit - visit times have us precision
  let cursor = startTime;
  for (const t of keepTimes) {
    if (t - MARGIN > cursor) await browser.history.deleteRange({ startTime: cursor, endTime: t - MARGIN });
    cursor = Math.max(cursor, t + MARGIN);
  }
  if (endTime > cursor) await browser.history.deleteRange({ startTime: cursor, endTime });
}

// ── Omnibox ("q" keyword) ──────────────────────────────────────────────────
// Type "q" then Tab (or Space) in the browser's address bar to search this
// extension's full history (not just the browser's native, capped-90-days one)
// and jump straight to a result with the arrow keys + Enter.
function _omniXmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _omniEscapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function _omniPathOf(url) {
  try { return new URL(url).pathname.toLowerCase(); }
  catch { return String(url || '').split(/[?#]/)[0].toLowerCase(); }
}

async function getOmniboxMatches(query, limit = 8) {
  if (await isLocked()) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const primary = words[0];
  const wordStartRe = new RegExp('(^|[^a-z0-9])' + _omniEscapeRegex(primary));

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const [todayEntries, allStored] = await Promise.all([
    getTodayFromBrowserApi(),
    (async () => {                       // SQLite: only the newest rows that contain the first word, never the whole history
      if (await _useSql()) return (await EhStore.page({ words: [primary], mode: 'all', hi: todayStart.getTime(), hiOpen: true, offset: 0, limit: 1500 })).entries;
      return getAll();
    })(),
  ]);
  const pastEntries = allStored.filter(e => e.visitTime < todayStart.getTime());
  const entries = [...todayEntries, ...pastEntries];
  entries.sort((a, b) => b.visitTime - a.visitTime); // recency tiebreaker within a rank

  // "Most visited" exception for the title-dedup step below — top 20 URLs by total
  // visit count in this same merged set (needs more than one visit to count).
  const visitCounts = new Map();
  for (const e of entries) {
    if (!e.url) continue;
    visitCounts.set(e.url, (visitCounts.get(e.url) || 0) + 1);
  }
  const mostVisited = new Set(
    [...visitCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).filter(([, c]) => c > 1).map(([u]) => u)
  );

  const seen = new Set();       // dedupe by URL — keep only the most recent visit of each
  const seenTitles = new Set(); // dedupe by title too — two suggestions shouldn't read the same
  const ranked = [];
  for (const e of entries) {
    if (!e.url || seen.has(e.url)) continue;
    const domain = (e.domain || '').toLowerCase();
    const title  = (e.title || '').toLowerCase();
    const path   = _omniPathOf(e.url); // query string/hash intentionally excluded
    const hay = domain + ' ' + title + ' ' + path;
    if (!words.every(w => hay.includes(w))) continue;

    let rank;
    if (domain.startsWith(primary)) rank = 0;
    else if (wordStartRe.test(title)) rank = 1;
    else if (domain.includes(primary)) rank = 2;
    else if (wordStartRe.test(path)) rank = 3;
    else if (title.includes(primary)) rank = 4;
    else continue; // domain/path-only mid-word match — too noisy, skip it

    // Distinct titles, same as distinct URLs — unless this URL is one of your most
    // visited, in which case it's still worth surfacing even if its title repeats
    // one already in the list (e.g. several tabs/visits all titled "Inbox").
    const titleKey = title.trim();
    if (titleKey && seenTitles.has(titleKey) && !mostVisited.has(e.url)) continue;

    seen.add(e.url);
    if (titleKey) seenTitles.add(titleKey);
    ranked.push({ e, rank });
    // Cap how many candidates we rank — entries are already recency-sorted, so a
    // few dozen is enough to guarantee limit's worth of well-ranked results without
    // scanning an entire multi-hundred-thousand-entry history on every keystroke.
    if (ranked.length >= limit * 8) break;
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 0 || a.rank === 2) {
      const ca = visitCounts.get(a.e.url) || 0, cb = visitCounts.get(b.e.url) || 0;
      if (ca !== cb) return cb - ca;
    }
    return 0; 
  });
  return ranked.slice(0, limit).map(r => r.e);
}

if (browser.omnibox) {
  browser.omnibox.setDefaultSuggestion({
    description: 'Search Extended History for %s'
  });

  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    const query = text.trim();
    if (!query) { suggest([]); return; }
    getOmniboxMatches(query, 8).then(matches => {
      suggest(matches.map(e => ({
        content: e.url,
        description: _omniXmlEscape(e.title || e.url) + ' <url>' + _omniXmlEscape(e.url) + '</url>'
      })));
    }).catch(() => suggest([]));
  });

  browser.omnibox.onInputEntered.addListener(async (text, disposition) => {
    let url = text.trim();
    // The user picked one of our suggestions — its `content` is already the
    // literal URL to open.
    if (!/^https?:\/\//i.test(url)) {
      // Free-typed text with no suggestion selected: jump to the best match
      // if we have one, otherwise fall back to the extension's own search
      // page so the query isn't just silently dropped.
      const matches = await getOmniboxMatches(url, 1).catch(() => []);
      url = matches[0] ? matches[0].url : browser.runtime.getURL('html/history.html') + '?q=' + encodeURIComponent(url);
    }
    if (disposition === 'newForegroundTab') browser.tabs.create({ url });
    else if (disposition === 'newBackgroundTab') browser.tabs.create({ url, active: false });
    else browser.tabs.update({ url });
  });
}

// ── Message API ──────────────────────────────────────────────────────────────
// One entry point for both routes: runtime messages (below) and direct calls from extension pages that
// reach this background page via browser.runtime.getBackgroundPage() (see js/theme-init.js). The direct route
// skips Firefox's message serialisation through the parent process, which is what made big pages (search
// results, import batches) slow.
function ehOnMessage(msg) {
  return handle(msg).then(r => {
    if (r && typeof r.error === 'string' && /being repaired/.test(r.error)) { _dbBusy = _dbBusy || { done: 0, total: 0 }; setTimeout(pollDbBusy, 500); return { error: 'Repairing the history database…', migrating: true }; }
    return r;
  }).catch(err => ({ error: /being repaired/.test(err.message) ? 'Repairing the history database…' : err.message, migrating: /being repaired/.test(err.message) }));
}
globalThis.EH_DIRECT = ehOnMessage;
browser.runtime.onMessage.addListener((msg,_s,respond)=>{
  if (msg && msg.target === 'eh-sql') return;      // addressed to the database worker (answered in database/eh-sql.js), not to us
  ehOnMessage(msg).then(respond); return true;
});

const MIGRATION_ALLOWED = new Set(['GET_DB_PROGRESS', 'RESET_SQLITE_HARD', 'GET_MIGRATION_STATUS', 'GET_LOCK_STATUS', 'GET_SETTINGS', 'GET_CLEANUP_STATUS']);
async function handle(msg) {
  await autoMigrateCheck();
  if (_dbBusy && !_migrating && !MIGRATION_ALLOWED.has(msg.type)) return { error: 'Upgrading the history database… ' + (_dbBusy.total ? Math.round(100 * _dbBusy.done / _dbBusy.total) + '%' : ''), migrating: true };
  if (_migrating && !MIGRATION_ALLOWED.has(msg.type)) return { error: 'Moving your history to SQLite… ' + (_migrating.total ? Math.round(100 * _migrating.done / _migrating.total) + '%' : ''), migrating: true };
  if (!LOCK_ALLOWED_TYPES.has(msg.type) && await isLocked()) return { error: 'locked', locked: true };
  switch(msg.type) {
    case 'GET_LOCK_STATUS': {
      const locked = await isLocked();
      const blob = locked ? (await browser.storage.local.get(LOCK_BLOB_KEY))[LOCK_BLOB_KEY] : null;
      const skipSeed = locked ? (await browser.storage.local.get(LOCK_SKIP_SEED_KEY))[LOCK_SKIP_SEED_KEY] === true : false;
      return { locked, lockedAt: blob?.lockedAt || null, totalEntries: blob?.totalEntries ?? null, skipSeed };
    }
    case 'GET_LOCK_PLAN':  return await lockPlan();
    case 'LOCK_HISTORY':   await browser.storage.local.set({ [LOCK_SKIP_SEED_KEY]: msg.skipSeed === true });
                           return await lockHistory(msg.password, msg.clearSiteData === true, msg.hideBookmarks === true, msg.keepSaving === true, msg.acceptUnencrypted === true);
    case 'UNLOCK_HISTORY': return await unlockHistory(msg.password, msg.skipSeed);
    case 'SEARCH': {
      const {query='',mode='all',startDate,endDate,limit=5000,offset=0}=msg;
      const qfPatterns = Array.isArray(msg.qf) && msg.qf.length ? msg.qf : null;
      const qfMatch = qfMakeMatcher(qfPatterns);

      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayMs = todayStart.getTime();

      const qWords = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const qMatch = (e) => {
        const hay = (mode==='title')  ? (e.title||'').toLowerCase()
                  : (mode==='url')    ? e.url.toLowerCase()
                  : (mode==='domain') ? (e.domain||'').toLowerCase()
                  : (e.url+' '+(e.title||'')+' '+(e.domain||'')).toLowerCase();
        return qWords.every(w => hay.includes(w));
      };

      // Past days come from local storage. When the whole history is NOT in memory, ask the
      // IndexedDB indexes for just what this request needs instead of loading millions of rows.
      if (await _useSql()) {
        // SQLite all-time browsing/searching stays entirely in SQLite. Explicit
        // date views that include today still merge the live browser day so the
        // today page remains fresh between periodic flushes.
        const includeLiveToday = !!(startDate || endDate) && (!endDate || endDate >= todayMs);
        const hiReq = endDate || null;
        const hiCap = includeLiveToday && (hiReq === null || hiReq >= todayMs) ? todayMs : hiReq;
        const hiOpen = includeLiveToday && hiCap === todayMs;
        let top = [];
        if (includeLiveToday) {
          const todayEntries = await getTodayFromBrowserApi();
          const restoredToday = await restoredEntriesSince(todayMs, todayEntries);
          top = [...todayEntries, ...restoredToday]
            .filter(e => (!startDate || e.visitTime >= startDate) && (!endDate || e.visitTime <= endDate))
            .filter(e => !qWords.length || qMatch(e))
            .filter(e => !qfMatch || qfMatch(e))
            .sort((a, b) => b.visitTime - a.visitTime);
        }
        const topPart = Math.max(0, Math.min(limit, top.length - offset));
        const past = await EhStore.page({ lo: startDate || null, hi: hiCap, hiOpen, words: qWords, mode,
                                          offset: Math.max(0, offset - top.length), limit: limit - topPart,
                                          qf: qfPatterns, needTotal: !msg.noTotal, cid: msg.cid, token: msg.token });
        if (past.cancelled) return { cancelled: true, total: 0, entries: [] };     // a newer keystroke superseded this search
        return { total: past.total == null ? null : top.length + past.total, entries: [...top.slice(offset, offset + limit), ...past.entries] };
      }

      // Split source: today live from the browser API, past days from local storage.
      // This ensures today's entries are always current (no per-visit storage writes)
      // while older history is served from the fast local store.
      const todayEntries = await getTodayFromBrowserApi();
      // ...plus today's visits from before the last unlock, which browser no longer has
      const restoredToday = await restoredEntriesSince(todayMs, todayEntries);

      let pastEntries;
      if (await coldIdb() && !qfMatch) {
        const lo = startDate || 0;
        const hi = Math.min(endDate || Infinity, todayMs);
        const dayRange = startDate && ((endDate || Date.now()) - startDate) <= 400 * 86400000;
        try {
          if (lo >= todayMs) {
            pastEntries = [];
          } else if (dayRange) {                       // a day / week / month: one index range read
            pastEntries = (await EhStore.getRange(lo, hi)).filter(e => e.visitTime < todayMs);
          } else if (qWords.length) {                  // wide text search: stream through, keep only matches
            pastEntries = await EhStore.filterAll(e => e.visitTime < todayMs && e.visitTime >= lo && e.visitTime <= hi && qMatch(e));
          } else {                                     // wide, no query: just the requested page, newest first
            const pastCount = await EhStore.countRange(lo, hi, hi >= todayMs);
            const top = [...todayEntries, ...restoredToday]
              .filter(e => (!startDate || e.visitTime >= startDate) && (!endDate || e.visitTime <= endDate))
              .sort((a, b) => b.visitTime - a.visitTime);
            const from = Math.max(offset, top.length), to = Math.min(offset + limit, top.length + pastCount);
            const page = to > from ? await EhStore.newest(lo, hi, hi >= todayMs, from - top.length, to - from) : [];
            return { total: top.length + pastCount, entries: [...top.slice(offset, offset + limit), ...page] };
          }
        } catch (e) {
          console.warn('[EH] SEARCH index read failed, loading all:', e.message);
          pastEntries = null;
        }
      }
      if (!pastEntries) pastEntries = (await getAll()).filter(e => e.visitTime < todayMs);
      let entries = [...todayEntries, ...restoredToday, ...pastEntries];

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
      if (qfMatch) entries = entries.filter(qfMatch);
      entries.sort((a,b)=>b.visitTime-a.visitTime);
      return {total:entries.length,entries:entries.slice(offset,offset+limit)};
    }
    case 'DELETE_IDS': {
      console.log('[EH][bg] DELETE_IDS received, ids:', msg.ids?.length, 'urls:', msg.urls);
      const s = new Set(msg.ids);
      // Today's entries are served live from the the browser History API with a fresh
      // random id every SEARCH call (see getTodayFromBrowserApi). If the periodic
      // flush has already written that visit into local storage under a
      // *different* stable id before the user deletes it, id-only matching misses
      // it — the local copy survives and the item reappears next time. Matching
      // by normalized URL as well closes that gap.
      const urlSet = new Set((msg.urls || []).map(u => { try { return normalizeUrl(u); } catch { return u; } }).filter(Boolean));

      const t0 = Date.now();
      const { removed } = await removeEntries(s, urlSet);
      console.log('[EH][bg] DELETE_IDS: removeEntries() done in', Date.now() - t0, 'ms, removed from storage:', removed.length);

      // Delete from browser history — every URL variant we know about:
      //  - urls passed directly from the UI (covers today's live entries)
      //  - url + rawUrl from local storage entries
      const urlsToDelete = new Set([
        ...(msg.urls || []),
        ...removed.flatMap(e => [e.url, e.rawUrl]),
      ].filter(Boolean));
      console.log('[EH][bg] DELETE_IDS: deleting', urlsToDelete.size, 'url(s) from browser history...');
      await withTimeout(
        deleteUrlsBatched(urlsToDelete),
        20000, 'browser.history.deleteUrl() batch'
      );
      console.log('[EH][bg] DELETE_IDS done. removedFromStorage:', removed.length, 'deletedUrls:', urlsToDelete.size);
      return { success: true, removedFromStorage: removed.length, deletedUrls: urlsToDelete.size };
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
      let toDelete;
      if (await _useSql()) {
        if (!words.length && !startDate && !endDate) {          // "delete everything": drop the database file (frees the disk space) + native history
          const n = await EhStore.count();
          await EhStore.clear();
          _entriesCache = null; _entriesLoading = null;
          try { await browser.history.deleteAll(); } catch {}
          await updateTodayHistory();
          return { success: true, deleted: n };
        }
        const urls = new Set();                                 // only the distinct URLs are remembered (for the browser's own history)
        await EhStore.forEachSlice(rows => { for (const e of rows) { urls.add(e.url); if (e.rawUrl) urls.add(e.rawUrl); } },
                                   { words, mode, lo: startDate || null, hi: endDate || null });
        const n = await EhStore.deleteWhere({ words, mode, lo: startDate || null, hi: endDate || null });
        _entriesCache = null;
        const todayLiveSql = (await getTodayFromBrowserApi()).filter(matchesFilter);
        for (const e of todayLiveSql) { urls.add(e.url); if (e.rawUrl) urls.add(e.rawUrl); }
        const list = [...urls];
        if (list.length <= 3000) await deleteUrlsBatched(list);
        else deleteUrlsBatched(list).catch(() => {});           // thousands of URLs: let browser work through them in the background
        return { success: true, deleted: n + todayLiveSql.length };
      } else {
        const allStored = await getAll();
        toDelete = allStored.filter(matchesFilter);
        await removeEntries(new Set(toDelete.map(e => e.id)), new Set());
      }

      // 2. Also match today's live entries from the browser API
      const todayLive = await getTodayFromBrowserApi();
      const toDeleteToday = todayLive.filter(matchesFilter);

      // 3. Delete every URL variant from browser history (covers both past + today)
      const urlsToDelete = new Set(
        [...toDelete, ...toDeleteToday].flatMap(e => [e.url, e.rawUrl]).filter(Boolean)
      );
      // Throttled batches instead of one giant Promise.all — firing hundreds/
      // thousands of concurrent deleteUrl() calls at once can overwhelm the browser's
      // history backend.
      await deleteUrlsBatched(urlsToDelete);
      return { success: true, deleted: toDelete.length + toDeleteToday.length };
    }
    case 'DELETE_HISTORY_RANGE': {
      const { startTime, endTime, clearCookies, clearCache } = msg;
      const exceptions = await getDeleteExceptions();
      const isExcepted = makeExceptionMatcher(exceptions);
      // Delete from extension storage (entries on excepted domains are kept)
      let deleted;
      if (await _useSql()) {
        if (!exceptions.length) deleted = await EhStore.deleteRange(startTime, endTime);
        else {
          const ids = [];
          await EhStore.forEachSlice(rows => { for (const e of rows) if (!isExcepted(e.url)) ids.push(e.id); }, { lo: startTime, hi: endTime });
          deleted = await EhStore.removeIds(ids);
        }
        _entriesCache = null;
      } else {
        let entries = await getAll();
        const before = entries.length;
        entries = entries.filter(e => !(e.visitTime >= startTime && e.visitTime <= endTime) || isExcepted(e.url));
        await setAll(entries);
        deleted = before - entries.length;
      }
      // Delete from browser native history
      try {
        if (exceptions.length) await deleteNativeHistoryRangeExcept(startTime, endTime, isExcepted);
        else if (startTime <= 0) await browser.history.deleteAll();            // whole history: far faster than a range delete
        else await browser.history.deleteRange({ startTime, endTime });
      } catch {}
      // Optionally clear cookies and cache
      if (clearCookies || clearCache) {
        const since = startTime;
        const dataTypes = {};
        if (clearCookies) { dataTypes.cookies = true; dataTypes.localStorage = true; dataTypes.indexedDB = true; }
        if (clearCache)   { dataTypes.cache = true; }
        // Firefox's browsingData API cannot exclude origins (Chrome's excludeOrigins), so with domain
        // exceptions cookies and site data are left alone rather than wiping data the user asked to
        // protect; the cache holds nothing worth protecting and is still cleared.
        if (exceptions.length) { delete dataTypes.cookies; delete dataTypes.localStorage; delete dataTypes.indexedDB; }
        try { await removeBrowsingData({ since }, dataTypes); } catch {}
      }
      // Update today's history
      await updateTodayHistory();
      return { success: true, deleted };
    }
    case 'CLEAR_ALL': {
      await setAll([]);
      await dropLegacyCopies();
      try { await browser.history.deleteAll(); } catch {}
      // Update today's history
      await updateTodayHistory();
      return { success: true };
    }
    case 'GET_STATS': {
      if (await coldIdb()) {
        try {
          const used = (await _useSql()) ? await EhStore.size() : await bytesInUse(HISTORY_KEY);
          const now = Date.now(); const daily = {}; const days = [];
          for (let i = 89; i >= 0; i--) {
            const d0 = new Date(now - i * 86400000); const key = d0.toLocaleDateString('en-CA');
            if (key in daily) continue;
            daily[key] = 0;
            d0.setHours(0, 0, 0, 0); const lo = d0.getTime();
            const d1 = new Date(lo); d1.setDate(d1.getDate() + 1);
            days.push([key, lo, d1.getTime()]);
          }
          const counts = await Promise.all(days.map(([, lo, hi]) => EhStore.countRange(lo, hi, true)));
          days.forEach(([key], i) => { daily[key] = counts[i]; });
          return { totalEntries: await EhStore.count(), storageMB: (used / 1048576).toFixed(1), oldestEntry: await EhStore.oldestVisitTime(), dailyActivity: daily };
        } catch (e) { console.warn('[EH] index stats failed, falling back:', e.message); }
      }
      const entries=await getAll(); const used=await bytesInUse(HISTORY_KEY);
      const oldest = entries.length ? entries.reduce((min, e) => e.visitTime < min ? e.visitTime : min, entries[0].visitTime) : null;
      const now=Date.now(); const daily={};
      for(let i=89;i>=0;i--) daily[new Date(now-i*86400000).toLocaleDateString('en-CA')]=0;
      const statsFrom = now - 91*86400000;   // only the last 90 days are charted — skip the rest of a huge history
      for(const e of entries){ if(e.visitTime < statsFrom) continue; const d=new Date(e.visitTime).toLocaleDateString('en-CA'); if(d in daily) daily[d]++; }
      return {totalEntries:entries.length,storageMB:(used/1048576).toFixed(1),oldestEntry:oldest,dailyActivity:daily};
    }
    case 'GET_HOURLY_AVG': {
      // Average number of visits in each hour of the day (local time) over the whole stored history.
      // Today is left out (still partial); days without any visit count as 0 because the divisor is every calendar day
      // from the oldest stored visit up to yesterday.
      const t0 = new Date(); t0.setHours(0, 0, 0, 0); const hi = t0.getTime();
      const B = 900000, buckets = new Map(); let oldest = null;
      const add = (b, c) => buckets.set(b, (buckets.get(b) || 0) + c);
      if (await _useSql()) {
        for (const [b, c] of await EhSql.rpc('hourBuckets', { hi })) add(b, c);
        oldest = await EhSql.oldestVisitTime();
      } else {
        const scan = e => { const t = e.visitTime; if (!(t < hi)) return; add(Math.floor(t / B), 1); if (oldest === null || t < oldest) oldest = t; };
        if (await _useIdb()) await EhStore.forEachSlice(rows => { for (const e of rows) scan(e); });
        else for (const e of await getAll()) scan(e);
      }
      const counts = new Array(24).fill(0);
      for (const [b, c] of buckets) counts[new Date(b * B + B / 2).getHours()] += c;
      let days = 0;
      if (oldest !== null && oldest < hi) { const d0 = new Date(oldest); d0.setHours(0, 0, 0, 0); days = Math.max(1, Math.round((hi - d0.getTime()) / 86400000)); }
      return { avg: counts.map(c => days ? c / days : 0), counts, days };
    }
    case 'GET_TIME_DATA': {
      const {days=30, date}=msg; const r=await browser.storage.local.get(TIME_KEY); const map=r[TIME_KEY]||{};
      const dateSet=new Set();
      if (date) {
        // Explicit single calendar day (YYYY-MM-DD) — the Today/date-arrow view in the
        // Time Spent panel asks for exactly one day at a time instead of a rolling window.
        dateSet.add(date);
      } else {
        const now=Date.now();
        for(let i=0;i<days;i++) dateSet.add(new Date(now-i*86400000).toLocaleDateString('en-CA'));
      }

      // "Hide ignored domains from Time Spent" — display-only filter, never
      // touches the underlying eh_time storage. A domain is excluded here
      // purely based on whether it currently matches an ignore pattern.
      const hideList = await getTimeSpentIgnoreList();
      const hideInvert = hideList ? await isIgnoreInvert() : false;
      const isHidden = hideList
        ? (domain) => hideList.some(p => domainMatchesIgnorePattern(domain, p)) !== hideInvert
        : () => false;

      const totals={};
      for(const [domain,dayMap] of Object.entries(map)){
        if (isHidden(domain)) continue;
        let t=0; for(const [date,ms] of Object.entries(dayMap)){if(dateSet.has(date)) t+=ms;} if(t>0) totals[domain]=t;
      }
      const sorted=Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,20)
      .map(([domain,ms])=>({domain,ms,minutes:Math.round(ms/60000),hours:(ms/3600000).toFixed(1)}));
      const dailyMap={};
      for(const [domain,dayMap] of Object.entries(map)){
        if (isHidden(domain)) continue;
        for(const [date,ms] of Object.entries(dayMap)){
          if(!dateSet.has(date)) continue;
          if(!dailyMap[date]) dailyMap[date]={};
          dailyMap[date][domain]=(dailyMap[date][domain]||0)+ms;
        }
      }
      // Average time per weekday over ALL stored time data (independent of the day filter above).
      // Every calendar day from the first tracked day up to yesterday counts (days without browsing = 0 h),
      // today is left out while it is still partial (unless it is the only day with data).
      const dayTotals={};
      for(const [domain,dayMap] of Object.entries(map)){
        if (isHidden(domain)) continue;
        for(const [d,ms] of Object.entries(dayMap)) dayTotals[d]=(dayTotals[d]||0)+ms;
      }
      const weekdayMs=[0,0,0,0,0,0,0], weekdayDays=[0,0,0,0,0,0,0];
      const keys=Object.keys(dayTotals).sort();
      if(keys.length){
        const todayK=new Date().toLocaleDateString('en-CA');
        let lastK=keys[keys.length-1];
        if(lastK>=todayK && keys.length>1) lastK=keys.filter(k=>k<todayK).pop()||lastK;
        const cur=new Date(keys[0]+'T12:00:00'), end=new Date(lastK+'T12:00:00');
        while(cur<=end){
          const k=cur.toLocaleDateString('en-CA'), wd=cur.getDay();
          weekdayMs[wd]+=dayTotals[k]||0; weekdayDays[wd]++;
          cur.setDate(cur.getDate()+1);
        }
      }
      const weekdayAvg=weekdayMs.map((ms,i)=>weekdayDays[i]?ms/weekdayDays[i]:0);   // ms per day, index = Date.getDay() (0 = Sunday)
      return {topSites:sorted,dailyMap,weekdayAvg,weekdayDays};
    }
    case 'GET_DEVICES': { try{return {devices:await browser.sessions.getDevices()};}catch{return {devices:[]};} }
    case 'GET_TODAY_HISTORY': {
      // Calendar-day (midnight → now) live fetch. Not currently used for the
      // "Today" view anywhere (see GET_RECENT_HISTORY below) — kept available
      // for anything that specifically wants a calendar-day cutoff.
      const liveEntries0 = await getTodayFromBrowserApi();
      const t0s = new Date(); t0s.setHours(0, 0, 0, 0);
      const liveEntries = [...liveEntries0, ...await restoredEntriesSince(t0s.getTime(), liveEntries0)];
      if (liveEntries.length) return { entries: liveEntries };
      const r = await browser.storage.local.get(TODAY_HISTORY_KEY);
      return { entries: r[TODAY_HISTORY_KEY] || [] };
    }
    case 'GET_RECENT_HISTORY': {
      // "Today" in both the popup and the sidebar: plain browser.history.search()
      // with no startTime, i.e. the browser's own rolling ~24h window,
      // rather than a calendar-day cutoff.
      const liveEntries0 = await getRecentFromBrowserApi();
      const liveEntries = [...liveEntries0, ...await restoredEntriesSince(Date.now() - 86400000, liveEntries0)];
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
    // ── Dev Mode diagnostics ────────────────────────────────────────────────
    case 'GET_DEV_STATS': {
      const settings = await getSettings();
      const syncIntervalMins = await getSyncInterval();
      const lastFlushAt = await getLastFlush();
      const nextFlushAt = syncIntervalMins > 0 && lastFlushAt
        ? lastFlushAt + syncIntervalMins * 60 * 1000
        : null; // null = due on the very next minute-tick (no baseline yet)
      return {
        syncIntervalMins,
        lastFlushAt,
        nextFlushAt,
        now: Date.now(),
        autoStoreEnabled: _autoStoreEnabled,
        autoStoreHours: _autoStoreHours,
        ignoreCleanupActive: _ignoreCleanupActive,
        ignoreCleanupProgress: { ..._ignoreCleanupProgress },
      };
    }
    case 'GET_DEV_TAB_IDLE': {
      const thresholdMs = _autoStoreHours * 3600000;
      const track = await getTabIdleTrack();
      let tabs = [];
      try { tabs = await browser.tabs.query({}); } catch {}

      const stored = await getTabStorage();
      const storedUrls = new Set(stored.map(e => e.url));

      const result = tabs.map(tab => {
        const trackable = !!(tab.url && isTrackable(tab.url));
        const norm = trackable ? normalizeUrl(tab.url) : null;
        const idleMs = tab.active ? 0 : (trackable ? (track.tabs[norm] || 0) : 0);
        const wallIdleMs = tab.active ? 0 : Date.now() - (tab.lastAccessed ?? Date.now());
        return {
          id: tab.id,
          title: tab.title || tab.url || '(untitled)',
          url: tab.url || '',
          active: !!tab.active,
          trackable,
          alreadyStored: trackable ? storedUrls.has(norm) : false,
          idleMs,
          wallIdleMs,
          thresholdMs,
        };
      });
      // Most-idle first so the tabs closest to auto-store are easy to spot.
      result.sort((a, b) => b.idleMs - a.idleMs);
      return { tabs: result, autoStoreEnabled: _autoStoreEnabled, thresholdMs };
    }
    case 'SET_SYNC_INTERVAL': {
      const mins = parseInt(msg.minutes);
      const safe = isNaN(mins) ? 30 : Math.max(0, Math.min(1440, mins));
      await saveSettings({ syncInterval: safe });
      await setLastFlush(0); // reset so next alarm tick re-evaluates
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

      // Never pile the session into the window the user is currently in: every
      // original window becomes its own NEW window. Tabs are grouped by the
      // windowId they were saved with (first-seen order preserved); sessions
      // saved before windowId was tracked have none, so they share one group
      // and restore as a single window.
      const groups = new Map();
      for (const t of tabs) {
        if (!t || !t.url || !isTrackable(t.url)) continue;
        const key = t.windowId != null ? String(t.windowId) : '__none__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t.url);
      }

      let windows = 0, restored = 0;
      for (const urls of groups.values()) {
        let win;
        try {
          // First window takes focus; the rest open behind it so a 2-window
          // session doesn't yank focus back and forth while tabs load.
          win = await browser.windows.create({ url: urls[0], focused: windows === 0 });
        } catch { continue; }
        windows++; restored++;
        for (const url of urls.slice(1)) {
          try { await browser.tabs.create({ windowId: win.id, url, active: false }); restored++; } catch {}
        }
      }
      return { success: true, windows, restored };
    }
    case 'GET_SETTINGS': { return await getSettings(); }
    case 'REDOWNLOAD_LAST_INCREMENTAL': return await redownloadLastIncremental();
    case 'TRIGGER_AUTO_EXPORT': {
      const r = await checkAutoExport(true);
      return r;
    }
    case 'GET_AUTO_EXPORT_STATUS': {
      const settings = await getSettings();
      const interval = Number(settings.autoExportIntervalMonths) || 0;
      if (!interval) return { enabled: false };
      const lastRunAt = Number(settings.autoExportLastRunAt) || 0;
      const baseline = lastRunAt || Number(settings.autoExportBaselineAt) || Date.now();
      return { enabled: true, intervalMonths: interval, lastRunAt, nextDueAt: baseline + interval * MS_PER_MONTH };
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
      // runAutoStore() garbage-collects closed tabs out of the idle-time
      // tracking store on every tick, but only while auto-store is enabled
      // (it returns early otherwise). Wipe the store here so turning the
      // feature off doesn't leave stale per-tab tracking data sitting
      // around indefinitely until it's turned back on.
      if (next.autoStoreEnabled === false) await browser.storage.local.remove(TAB_IDLE_TRACK_KEY);
      if (msg.settings.hasOwnProperty('toolbarIcon'))       applyToolbarIcon(next.toolbarIcon);
      if (msg.settings.hasOwnProperty('popupAsSidebar'))    applyPopupMode(next.popupAsSidebar === true);
      if (msg.settings.hasOwnProperty('contextMenuEnabled')) await ensureContextMenus();
      return {success:true,settings:next};
    }
    case 'EXPORT_BEGIN': {
      if (await _useSql()) {
        const tdr = await browser.storage.local.get(TIME_KEY); const sess = await getSessions();
        const tail = ',"timeData":' + JSON.stringify(tdr[TIME_KEY] || {}) + ',"sessions":' + JSON.stringify(sess);
        const total = await EhStore.count();
        const gen = sqlExportParts({ exportedAt: new Date().toISOString(), totalEntries: total }, tail, {});
        return { id: registerExportJob({ gen }), count: null, totalEntries: total };
      }
      const entries = await getAll(); const tdr = await browser.storage.local.get(TIME_KEY); const sess = await getSessions();
      const tail = ',"timeData":' + JSON.stringify(tdr[TIME_KEY] || {}) + ',"sessions":' + JSON.stringify(sess);
      const parts = buildExportParts({ exportedAt: new Date().toISOString(), totalEntries: entries.length }, entries.map(slimEntry), tail);
      return { id: registerExportJob(parts), count: parts.length, totalEntries: entries.length };
    }
    case 'EXPORT_PULL': {
      const parts = _exportJobs.get(msg.id);
      if (!parts) return { error: 'Export expired — please try again' };
      if (!Array.isArray(parts)) {                 // lazy (SQLite) export: pulled strictly in order, with one part of look-ahead
        if (parts.cur === undefined) parts.cur = await parts.gen.next();
        const out = parts.cur.value;
        parts.cur = await parts.gen.next();
        if (parts.cur.done) _exportJobs.delete(msg.id);
        return { part: out, last: parts.cur.done };
      }
      const part = parts[msg.i];
      if (part === undefined) return { error: 'Invalid export chunk' };
      if (msg.i === parts.length - 1) _exportJobs.delete(msg.id);
      return { part, last: msg.i === parts.length - 1 };
    }
    case 'EXPORT': {
      const entries=await getAll(); const tr=await browser.storage.local.get(TIME_KEY); const sess=await getSessions();
      return {exportedAt:new Date().toISOString(),totalEntries:entries.length,entries,timeData:tr[TIME_KEY]||{},sessions:sess};
    }
    case 'IMPORT_BEGIN': {
      if (await _useSql()) {                  // no in-memory copy of history needed: UNIQUE(url, 5s-bucket) de-dupes
        const st = await getSettings();
        const sid = 'i' + Date.now() + Math.random().toString(36).slice(2, 6);
        const cutoff = Date.now() - st.retentionDays * 86400000;
        try { await EhSql.rpc('ping'); } catch (e) { return { error: 'SQLite could not start: ' + e.message }; }   // also waits for a pending upgrade
        const bulk = msg.bulk === true;           // big file: indexes are rebuilt once at the end instead of per row
        if (bulk) { try { await EhSql.bulkBegin(); } catch (e) { return { error: 'SQLite: ' + e.message }; } }
        else { try { await EhSql.rpc('ftsDeferBegin'); } catch (_) {} EhSql.setCache(160).catch(() => {}); }
        _importJobs.set(sid, { sql: true, bulk, defer: !bulk, cutoff, stats: { imported: 0, dup: 0, old: 0, invalid: 0, oldestOld: 0 } });
        setTimeout(() => _importJobs.delete(sid), 6 * 60 * 60000);
        // direct: the page sends batches straight to the database (no service-worker hop) and reports the totals at the end
        return { id: sid, direct: true, cutoff };
      }
      const existing = await getAll(); const settings = await getSettings();
      const job = {
        existing,
        existingSet: new Set(existing.map(e => `${e.url}|${Math.floor(e.visitTime / 5000)}`)),
        cutoff: Date.now() - settings.retentionDays * 86400000,
        useIdb: await _useIdb(),
        added: [],
        stats: { imported: 0, dup: 0, old: 0, invalid: 0, oldestOld: 0 },
      };
      const id = 'i' + Date.now() + Math.random().toString(36).slice(2, 6);
      _importJobs.set(id, job);
      setTimeout(() => _importJobs.delete(id), 60 * 60000);
      return { id };
    }
    case 'IMPORT_BATCH': {
      const job = _importJobs.get(msg.id);
      if (!job) return { error: 'Import session expired — please try again' };
      if (job.sql) {
        const st = await EhSql.rpc('importBatch', { entries: Array.isArray(msg.entries) ? msg.entries : [], cutoff: job.cutoff });
        for (const k of Object.keys(st)) { if (k === 'oldestOld') { if (st.oldestOld && (!job.stats.oldestOld || st.oldestOld < job.stats.oldestOld)) job.stats.oldestOld = st.oldestOld; } else job.stats[k] += st[k]; }
        return { ok: true, imported: job.stats.imported };
      }
      const fresh = importProcessBatch(job, Array.isArray(msg.entries) ? msg.entries : []);
      if (fresh.length) {
        if (job.useIdb) {                       // IndexedDB: write just these rows, no full rewrite
          await EhStore.putMany(fresh);
          for (const e of fresh) job.existing.push(e);   // job.existing IS the in-memory cache
        } else {
          for (const e of fresh) job.added.push(e);      // storage.local: written once at the end
        }
      }
      return { ok: true, imported: job.stats.imported };
    }
    case 'IMPORT_HISTORY': {
      let count = 0, stats = null;
      if (msg.job) {                            // finish a batched import
        const job = _importJobs.get(msg.job);
        if (!job) return { error: 'Import session expired — please try again' };
        if (job.sql) {
          if (msg.stats) job.stats = msg.stats;
          if (job.bulk || job.defer) {            // rebuild the indexes; this also drops the duplicates the bulk load let through
            _dbBusy = { phase: 'indexing', since: Date.now(), done: 0, total: 0, upgrade: true }; setTimeout(pollDbBusy, 700);
            let removed = 0;
            try { ({ removed } = await EhSql.bulkEnd()); } finally { _dbBusy = null; }
            try { await EhSql.rpc('flush'); await EhSql.recycle(); } catch (_) {}      // durable, and the worker's grown memory is released
            job.stats.imported -= removed; job.stats.dup += removed;
          } else { EhSql.setCache(32).catch(() => {}); try { await EhSql.rpc('flush'); await EhSql.recycle(); } catch (_) {} }
          _entriesCache = null; _entriesLoading = null;
        }
        else if (!job.useIdb && job.added.length) {
          for (const e of job.added) job.existing.push(e);
          job.existing.sort((a, b) => b.visitTime - a.visitTime);
          await setAll(job.existing);
        }
        count = job.stats.imported; stats = job.stats;
        _importJobs.delete(msg.job);
      } else {                                  // legacy single-message import (small files)
      const {entries:imported}=msg;
      if(!Array.isArray(imported)||!imported.length) return {success:false,error:'No entries'};
      const existing=await getAll(); const settings=await getSettings();
      const cutoff=Date.now()-settings.retentionDays*86400000;
      const existingSet=new Set(existing.map(e=>`${e.url}|${Math.floor(e.visitTime/5000)}`));
      for(const e of imported){
        if(!e.url||!isTrackable(e.url)) continue;
        if(e.visitTime&&e.visitTime<cutoff) continue;
        const raw=e.rawUrl||e.url;
        const norm=normalizeUrl(raw); const key=`${norm}|${Math.floor((e.visitTime||Date.now())/5000)}`;
        if(existingSet.has(key)) continue;
        existing.push({id:`imp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,url:norm,...rawUrlField(norm,raw),title:e.title||'',visitTime:e.visitTime||Date.now(),domain:domainOf(raw)});
        existingSet.add(key); count++;
      }
      existing.sort((a,b)=>b.visitTime-a.visitTime); await setAll(existing);
      }
      // Update today's history
      await updateTodayHistory();

      // ── Bookmark top domains into "Extended History" folder ──────────────
      try {
        // Count visits per domain across all history (imported + existing)
        let topDomains;
        if (await _useSql()) {
          topDomains = (await EhStore.topBy({ column: 'domain', limit: 20 })).map(x => x.identifier);
        } else {
          const allEntries = await getAll();
          const domainCounts = {};
          for (const e of allEntries) {
            const d = e.domain || domainOf(e.url);
            if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
          }
          topDomains = Object.entries(domainCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([domain]) => domain);
        }

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

      return {success:true,imported:count,stats};
    }
    case 'RE_BACKFILL': {
      try {
        await browser.storage.local.remove(BACKFILL_KEY);
        const items = await browser.history.search({ text: '', startTime: 0, maxResults: 100000 });
        const entries = items.filter(i => isTrackable(i.url)).map(i => ({
          id:        `bf_${i.lastVisitTime}_${Math.random().toString(36).slice(2, 6)}`,
          url:       normalizeUrl(i.url),
          ...rawUrlField(normalizeUrl(i.url), i.url),
          title:     i.title || '',
          visitTime: i.lastVisitTime || Date.now(),
          domain:    domainOf(i.url),
        }));
        let importedCount;
        if (await _useSql()) {
          importedCount = await EhStore.insertIgnore(entries);
          _entriesCache = null;
        } else {
          const existing    = await getAll();
          const existingSet = new Set(existing.map(e => `${e.url}|${Math.floor(e.visitTime / 5000)}`));
          const newOnes     = entries.filter(e => !existingSet.has(`${e.url}|${Math.floor(e.visitTime / 5000)}`));
          if (newOnes.length) await setAll([...existing, ...newOnes].sort((a, b) => b.visitTime - a.visitTime));
          importedCount = newOnes.length;
        }
        await browser.storage.local.set({ [BACKFILL_KEY]: true });
        await updateTodayHistory();
        return { success: true, imported: importedCount };
      } catch (e) { return { error: e.message }; }
    }
    case 'GET_BOOKMARKS': { try{return {tree:await browser.bookmarks.getTree()};}catch{return {tree:[]};} }
    case 'MOVE_BOOKMARK': {
      try {
        // index is only passed for in-list reordering (dragging a bookmark
        // between two others in its current folder) — omitted for plain
        // folder-to-folder moves, which drop the bookmark at the end.
        const wantIndex = (msg.index !== undefined && msg.index !== null) ? msg.index : undefined;
        const dest = { parentId: msg.parentId };
        if (wantIndex !== undefined) dest.index = wantIndex;
        let moved = await browser.bookmarks.move(msg.id, dest);
        // browser has a long-standing quirk where asking to move a bookmark
        // forward within its own folder can silently land it short of the
        // requested index (the exact behaviour has shifted across the browser
        // versions and is still debated upstream). Rather than hard-code an
        // adjustment and hope it matches the installed browser version,
        // check where the bookmark actually ended up and nudge it again if
        // it's not where we asked — self-correcting instead of guessing.
        let guard = 0;
        while (wantIndex !== undefined && moved.parentId === msg.parentId &&
               moved.index !== wantIndex && guard < 3) {
          const nudge = wantIndex + (wantIndex - moved.index);
          moved = await browser.bookmarks.move(msg.id, { parentId: msg.parentId, index: nudge });
          guard++;
        }
        return { success: true, index: moved.index };
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
      if (Array.isArray(msg.tree)) return { success: true, imported: await importBookmarkTree(msg.tree) };
      const {bookmarks}=msg; let imported=0;
      for(const bm of (bookmarks||[])) if(bm.url){try{await browser.bookmarks.create({title:bm.title||bm.url,url:bm.url});imported++;}catch{}}
      return {success:true,imported};
    }
    case 'OPEN_INCOGNITO': { try{await browser.windows.create({url:msg.url,incognito:true});}catch{} return {success:true}; }
    case 'GET_IGNORE_LIST': {
      const settings = await getSettings();
      return {
        list: await getIgnoreList(),
        enabled: await isIgnoreListEnabled(),
        invert: settings.ignoreListInvert === true,
        hideInTimeSpent: settings.hideIgnoredInTimeSpent === true,
      };
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
      const res = await cleanIgnoredFromHistory(msg.force === true);
      return { success: true, removed: res.removed || 0, skipped: res.skipped || null };
    }
    case 'GET_NEWEST_VISIT': {
      const now = Date.now();
      try {
        let t = 0;
        if (await _useIdb()) t = (await EhStore.newestVisitTime(now)) || 0;     // SQLite or IndexedDB
        else { const all = await getAll(); for (const e of all) if (e.visitTime > t && e.visitTime <= now) t = e.visitTime; }
        return { time: t || now, found: !!t };
      } catch (e) { return { time: now, found: false, err: String(e && e.message || e) }; }
    }
    case 'TEST_WEBDAV': return testWebDav({ url: msg.url, username: msg.username, password: msg.password });
    case 'GET_DB_PROGRESS': {            // live progress of a long database job (bulk delete, index rebuild…)
      if (!(await _useSql())) return { phase: 'ready', done: 0, total: 0 };
      try { return await withTimeout(EhSql.status(), 3000, 'status'); } catch (_) { return { phase: 'busy', done: 0, total: 0 }; }
    }
    case 'GET_CLEANUP_STATUS': {
      return { active: _ignoreCleanupActive, done: _ignoreCleanupProgress.done, total: _ignoreCleanupProgress.total };
    }
    case 'TOGGLE_IGNORE_LIST': {
      const settings = await getSettings();
      const newEnabled = !settings.ignoreListEnabled;
      await saveSettings({ ignoreListEnabled: newEnabled });
      return { success: true, enabled: newEnabled };
    }
    case 'SET_IGNORE_INVERT': {
      await saveSettings({ ignoreListInvert: msg.value === true });
      return { success: true, invert: msg.value === true };
    }
    case 'TOGGLE_HIDE_IGNORED_TIMESPENT': {
      const settings = await getSettings();
      const newEnabled = !settings.hideIgnoredInTimeSpent;
      await saveSettings({ hideIgnoredInTimeSpent: newEnabled });
      return { success: true, enabled: newEnabled };
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
    case 'MIGRATE_TO_IDB':    return migrateBackend('idb');
    case 'MIGRATE_TO_LOCAL':  return migrateBackend('local');
    case 'MIGRATE_TO_SQLITE': return migrateBackend('sqlite');
    case 'GET_STORAGE_BACKEND': return { backend: await _backend() };
    case 'RESET_SQLITE_HARD': {          // last resort when the database cannot be opened/repaired: delete it and start empty
      EhSql.reset();                                  // terminates the database worker
      let err = null;
      for (let i = 0; i < 8; i++) {
        await sleep(600);
        try { const root = await navigator.storage.getDirectory(); await root.removeEntry('.eh-sqlite', { recursive: true }); err = null; break; }
        catch (e) { if (e && e.name === 'NotFoundError') { err = null; break; } err = e; }
      }
      if (err) return { error: 'Could not delete the database: ' + err.message };
      _dbBusy = null; _entriesCache = null; _entriesLoading = null;
      return { success: true };
    }
    case 'GET_MIGRATION_STATUS': {
      if (_migrating) return { migrating: true, ..._migrating };
      if (_dbBusy) return { migrating: true, target: 'sqlite', upgrade: true, phase: _dbBusy.phase, pctOnly: _dbBusy.pctOnly, step: _dbBusy.step, busySecs: Math.round((Date.now() - (_dbBusy.since || Date.now())) / 1000), done: _dbBusy.done, total: _dbBusy.total };
      if ((await _backend()) === 'sqlite') {          // the database may be upgrading an older file
        try { const st = await withTimeout(EhSql.status(), 1500, 'status'); if (st.phase && st.phase !== 'ready' && st.phase !== 'deleting') return { migrating: true, target: 'sqlite', phase: st.phase, pctOnly: !!st.pctOnly, step: st.step || '', done: st.done, total: st.total, upgrade: true }; } catch (_) {}
      }
      return { migrating: false };
    }
        case 'GET_MOST_VISITED': {
      const {viewType='url',period='all'}=msg;
      if (await _useSql()) {
        const d = period === '10' ? 10 : period === '30' ? 30 : 0;
        const items = await EhStore.topBy({ column: viewType === 'domain' ? 'domain' : 'url', since: d ? Date.now() - d * 86400000 : 0, limit: 50 });
        return { items };
      }
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
// ── Move the whole history between storage backends ─────────────────────────
// Copies in slices (never the whole history in memory for the database stores), clears the
// target first so deleted entries can't come back, flips the active backend only after the
// copy succeeded, and leaves the old store's data untouched as a safety net.
let _migrating = null;      // { target, done, total, auto } while a migration runs — everything else waits
const AUTOSWITCH_FAIL_KEY = 'eh_autoswitch_fail';
const AUTOSWITCH_LOCAL_BYTES = 40 * 1048576;     // browser.storage.local history bigger than this → SQLite
const AUTOSWITCH_IDB_ENTRIES = 250000;

// Removes the copies of the history that belong to a store that is no longer the active one,
// so the disk space is really given back (this is what made "storage" show GBs).
async function dropLegacyCopies() {
  try {
    const b = await _backend();
    if (b === 'sqlite') {
      // Safety net: never delete the previous copy of the history unless SQLite really holds data.
      let has = false;
      try { has = await withTimeout(EhSql.rpc('hasRows'), 60000, 'hasRows'); } catch (_) { return; }
      if (!has) return;
    }
    if (b !== 'local') await browser.storage.local.remove([HISTORY_KEY]);
    if (b !== 'idb') await EhIdb.destroy();
  } catch (e) { console.warn('[EH] dropLegacyCopies:', e.message); }
}

// Recovery: SQLite is the active store but is empty while an older copy of the history still exists
// (e.g. an earlier migration did not complete). Switch back to the old store so nothing is lost; the
// automatic migration then runs again (and this time verifies the copy before touching the original).
async function recoverEmptySqlite() {
  try {
    if ((await _backend()) !== 'sqlite') return;
    const has = await withTimeout(EhSql.rpc('hasRows'), 60000, 'hasRows');   // not COUNT(*): that scans the whole 1 GB file and every request waits for it
    if (has) return;
    const localBytes = await bytesInUse(HISTORY_KEY);
    let idbCount = 0;
    try { idbCount = await EhIdb.count(); } catch (_) {}
    if (idbCount > 0)        await browser.storage.local.set({ [SQL_STORAGE_KEY]: false, [IDB_STORAGE_KEY]: true });
    else if (localBytes > 64) await browser.storage.local.set({ [SQL_STORAGE_KEY]: false, [IDB_STORAGE_KEY]: false });
    else return;
    await browser.storage.local.remove(AUTOSWITCH_FAIL_KEY);
    _backendKind = null; _entriesCache = null; _entriesLoading = null;
    console.warn('[EH] SQLite was empty but an older copy of the history exists — switched back to it');
  } catch (e) { console.warn('[EH] recoverEmptySqlite:', e.message); }
}

async function migrateBackend(target, auto) {
  if (_migrating) return { error: 'A migration is already running' };
  _migrating = { target, done: 0, total: 0, auto: !!auto, phase: 'preparing', since: Date.now() };     // claimed immediately: no other request may touch the data meanwhile
  const phase = (p) => { if (_migrating) { _migrating.phase = p; try { browser.runtime.sendMessage({ type: 'MIGRATE_PROGRESS', done: _migrating.done, total: _migrating.total, phase: p }).catch(() => {}); } catch (_) {} } };
  try {
    if (await isLocked()) return { error: 'Unlock history first' };
    const from = await _backend();
    if (from === target) return { success: true, migrated: 0 };
    _entriesCache = null; _entriesLoading = null;
    let localRows = [];
    const progress = () => { try { browser.runtime.sendMessage({ type: 'MIGRATE_PROGRESS', done: _migrating.done, total: _migrating.total, phase: _migrating.phase }).catch(() => {}); } catch (_) {} };

    // Know the total first, so the progress bar has a real denominator from the start.
    phase('reading');
    let localArr = null;
    if (from === 'local')       { localArr = (await browser.storage.local.get(HISTORY_KEY))[HISTORY_KEY] || []; _migrating.total = localArr.length; }
    else if (from === 'sqlite') _migrating.total = await EhSql.count();
    else                        _migrating.total = await EhIdb.count();
    const sourceTotal = _migrating.total;

    if (target === 'sqlite') {                     // prove SQLite can start before copying anything
      phase('starting');
      try { await EhSql.rpc('ping'); await EhSql.status(); }
      catch (e) { return { error: 'SQLite could not start: ' + e.message }; }
    }

    const readSource = async (fn) => {
      if (from === 'sqlite') return EhSql.forEachSlice(fn);
      if (from === 'idb')    return EhIdb.forEachSlice(fn);
      for (let i = 0; i < localArr.length; i += 20000) await fn(localArr.slice(i, i + 20000));
    };
    phase('copying');
    if (target === 'sqlite') await EhSql.clear();
    if (target === 'idb')    await EhIdb.clear();

    let added = 0;
    await readSource(async (rows) => {
      if (target === 'sqlite')    added += (await EhSql.insertIgnore(rows)) || 0;
      else if (target === 'idb')  await EhIdb.putMany(rows);
      else                        for (const r of rows) localRows.push(r);
      _migrating.done += rows.length; progress();
    });
    const migrated = _migrating.done;

    // Verify the copy BEFORE switching over and before the original is touched. Nothing is deleted
    // unless the new store provably holds the history.
    phase('verifying');
    if (target === 'sqlite') {
      await EhSql.rpc('flush');                                   // make sure the data is really on disk
      const n = await EhSql.count();
      if (sourceTotal > 0 && (n === 0 || n < added)) throw new Error(`Verification failed: the new database holds ${n} of ${sourceTotal} entries — your original history was left untouched`);
    } else if (target === 'idb') {
      const n = await EhIdb.count();
      if (sourceTotal > 0 && n === 0) throw new Error('Verification failed: the new database is empty — your original history was left untouched');
    }
    localArr = null;

    phase('finishing');
    if (target === 'local') await browser.storage.local.set({ [HISTORY_KEY]: localRows, [IDB_STORAGE_KEY]: false, [SQL_STORAGE_KEY]: false });
    else if (target === 'idb') await browser.storage.local.set({ [IDB_STORAGE_KEY]: true, [SQL_STORAGE_KEY]: false });
    else await browser.storage.local.set({ [SQL_STORAGE_KEY]: true, [IDB_STORAGE_KEY]: false });
    _backendKind = null; _entriesCache = null; _entriesLoading = null;
    if (from === 'sqlite' && target !== 'sqlite') { try { await EhSql.clear(); } catch (_) {} }
    await dropLegacyCopies();                       // only removes the old copy if the active store holds data
    await browser.storage.local.remove(AUTOSWITCH_FAIL_KEY);
    return { success: true, migrated };
  } catch (e) {
    if (auto) await browser.storage.local.set({ [AUTOSWITCH_FAIL_KEY]: Date.now() });
    return { error: e.message };
  } finally { _migrating = null; }
}

// A history that is too big for Local Storage / IndexedDB moves itself to SQLite — from the
// service worker, before any page asks for the data. (Opening the history page used to load
// the whole thing into memory, so the user could never even reach the Settings to switch.)
// While the SQLite worker is still starting / upgrading an older database file it cannot answer
// queries (they would just hang until it is done). Track that, so requests get a clear
// "busy" answer — the history page shows its progress overlay instead of "Loading…" forever.
let _dbBusy = null;
async function pollDbBusy() {
  try {
    const st = await withTimeout(EhSql.status(), 4000, 'status');
    _dbBusy = st.phase === 'ready' ? null : { phase: st.phase, since: (_dbBusy && _dbBusy.since) || Date.now(), done: st.done || 0, total: st.total || 0, upgrade: true, pctOnly: !!st.pctOnly, step: st.step || '' };
  } catch (_) { /* worker busy in a long step: keep the previous state */ }
  if (_dbBusy) setTimeout(pollDbBusy, 400);
}
let _autoChecked = null;
function autoMigrateCheck() {
  if (!_autoChecked) _autoChecked = (async () => {
    try {
      if (await isLocked()) return;
      const b = await _backend();
      if (b === 'sqlite') {
        await pollDbBusy();
        // Runs in the BACKGROUND: it has to wait for the database to finish starting, and nothing else
        // (settings, date pills, the first search) may be held up behind that.
        recoverEmptySqlite().then(async () => { if ((await _backend()) === 'sqlite') setTimeout(dropLegacyCopies, 60000); }).catch(() => {});
        return;
      }
      const st = await getSettings();
      if (st.autoSwitchSqlite === false) return;
      const fail = (await browser.storage.local.get(AUTOSWITCH_FAIL_KEY))[AUTOSWITCH_FAIL_KEY] || 0;
      if (Date.now() - fail < 3600000) return;
      let big = false;
      if (b === 'local') big = (await bytesInUse(HISTORY_KEY)) > AUTOSWITCH_LOCAL_BYTES;
      else big = (await EhIdb.count()) > AUTOSWITCH_IDB_ENTRIES;
      if (!big) return;
      migrateBackend('sqlite', true).then(r => console.log('[EH] auto-migration to SQLite:', r));   // sets _migrating synchronously
    } catch (e) { console.warn('[EH] autoMigrateCheck:', e.message); }
  })();
  return _autoChecked;
}
autoMigrateCheck();

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