/**
 * Extended History — background.js v3.3
 * Time tracking: purely event-driven per-tab, domain-bucketed by day.
 */

const HISTORY_KEY  = 'eh_history';
const TODAY_HISTORY_KEY = 'eh_today_history';  // Separate storage for today's history
const TIME_KEY     = 'eh_time';
const SETTINGS_KEY = 'eh_settings';
const SESSIONS_KEY = 'eh_sessions';
const BACKFILL_KEY = 'eh_backfilled';
const CURRENT_SESSION_KEY = 'eh_current_session'; // Single current session (overwritten)
const IGNORE_LIST_KEY = 'eh_ignore_list'; // List of URL patterns to ignore
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
  language:      'en', // Default language
  ignoreListEnabled: true, // NEW: Toggle for ignore list
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
  out = out.replace(/^['"`]+|['"`]+$/g, ''); // allow users to paste quoted values
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
  const r = await chrome.storage.local.get(IGNORE_LIST_KEY);
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
  await chrome.storage.local.set({ [IGNORE_LIST_KEY]: normalized });
}
// Check if ignore list is enabled
async function isIgnoreListEnabled() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = r[SETTINGS_KEY] || DEFAULT_SETTINGS;
  return settings.ignoreListEnabled !== false; // Default to true if not set
}
// Check if URL matches any ignore pattern
function matchesIgnorePattern(url, pattern) {
  try {
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

async function shouldIgnoreUrl(url) {
  const enabled = await isIgnoreListEnabled();
  if (!enabled) return false;
  const ignoreList = await getIgnoreList();
  return ignoreList.some(pattern => matchesIgnorePattern(url, pattern));
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
    try { await chrome.history.deleteUrl({ url: target }); } catch {}
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
    const recent = await chrome.history.search({
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
    if (ignoreList.some(pattern => matchesIgnorePattern(e.url, pattern))) {
      toDelete.push(e);
    } else {
      toKeep.push(e);
    }
  }
  
  if (toDelete.length) {
    await setAll(toKeep);
    await updateTodayHistory();
    
    // Also remove from Chrome native history
    for (const e of toDelete) {
      try { await chrome.history.deleteUrl({ url: e.url }); } catch {}
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

async function commitSegment() {
  if (!activeDomain || !segmentStart || !windowFocused) {
    segmentStart = null;
    return;
  }
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
  activeTabId   = tabId;
  activeDomain  = domain;
  segmentStart  = Date.now();
}

// Called on startup/install to pick up wherever we are
async function resumeActiveTab() {
  try {
    const wins = await chrome.windows.getAll({ populate: false });
    const focused = wins.find(w => w.focused);
    if (!focused) { windowFocused = false; return; }
    windowFocused = true;
    const [tab] = await chrome.tabs.query({ active: true, windowId: focused.id });
    if (tab && isTrackable(tab.url)) {
      startSegment(tab.id, domainOf(tab.url));
    }
  } catch {}
}

async function addTime(domain, ms) {
  if (!domain) return;
  const r   = await chrome.storage.local.get(TIME_KEY);
  const map = r[TIME_KEY] || {};
  const day = todayKey();
  if (!map[domain]) map[domain] = {};
  map[domain][day] = (map[domain][day] || 0) + ms;
  await chrome.storage.local.set({ [TIME_KEY]: map });
}

// Safety-net alarm every 30s:
// - segment running → commit + restart
// - no segment (e.g. after SW restart) → resumeActiveTab to self-heal
// - save current session (overwrite, not append)
chrome.alarms.create('eh_tick', { periodInMinutes: 0.5 });

const AUTO_SAVE_KEY = 'eh_auto_save_interval'; // minutes, 0 = disabled
let _lastAutoSave   = 0; // timestamp of last auto-save
let _lastSessionSave = 0; // timestamp of last session save

// Helper to update today's history separately (stores ALL of today's entries)
async function updateTodayHistory() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  
  const all = await getAll();
  const todayEntries = all.filter(e => e.visitTime >= todayMs);
  //console.log('[EH] updateTodayHistory: Storing', todayEntries.length, 'entries from today');
  await chrome.storage.local.set({ [TODAY_HISTORY_KEY]: todayEntries });
}

async function getAutoSaveInterval() {
  const r = await chrome.storage.local.get(AUTO_SAVE_KEY);
  return r[AUTO_SAVE_KEY] ?? 0;
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'eh_tick') return;
  if (activeDomain && segmentStart && windowFocused) {
    await commitSegment();
    segmentStart = Date.now();
  } else if (!segmentStart) {
    await resumeActiveTab();
  }
  
  // Save current session every 30s (overwrite same storage)
  const now = Date.now();
  if (now - _lastSessionSave >= 30000) { // 30 seconds
    await saveCurrentSession();
    _lastSessionSave = now;
  }
  
  // Only auto-save when browser window is focused — don't interrupt games etc.
  const mins = await getAutoSaveInterval();
  if (mins >= 1 && Date.now() - _lastAutoSave >= mins * 60 * 1000) {
    try {
      const win = await chrome.windows.getLastFocused({ populate: false });
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

  const label    = chrome.i18n.getMessage("current_session") + ' – ' + new Date().toLocaleString();
  const htmlBody = buildSessionHtml(label, openTabs);
  const extPageUrl = chrome.runtime.getURL('history.html');

  // Check if the history page is already open
  let tabId = null;
  let didOpen = false;
  try {
    const existing = await chrome.tabs.query({ url: extPageUrl });
    if (existing.length > 0) {
      tabId = existing[0].id;
    } else {
      // Open it hidden in the background
      const t = await chrome.tabs.create({ url: extPageUrl, active: false });
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
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });

  try {
    await chrome.tabs.sendMessage(tabId, {
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
      try { await chrome.tabs.remove(tabId); } catch {}
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
  await chrome.storage.local.set({
    [CURRENT_SESSION_KEY]: {
      id: sessionId,
      start: sessionStart,
      tabs: openTabs,
      lastSaved: Date.now()
    }
  });
}

function buildSessionHtml(label, tabs) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const domainOf2 = url => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; } };
  const rows = tabs.map(t => {
    const dom = domainOf2(t.url);
    //return ${chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent("https://" + dom)}&size=16`)}
    return `<a href="${esc(t.url)}"><img class="fav" src="https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(dom)}" loading="lazy" onerror="this.style.display='none'"/><span class="title">${esc(t.title||t.url)}</span><span class="domain">${esc(dom)}</span></a>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${esc(label)}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0d0d10;color:#f0eee8;padding:40px 32px}
h1{font-size:1.3rem;font-weight:700;color:#3b9eff;margin-bottom:4px}.meta{font-size:.78rem;color:#a09eb0;margin-bottom:28px}
.links{display:flex;flex-direction:column;gap:3px}a{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;text-decoration:none;color:#f0eee8;background:#18181f;border:1px solid rgba(255,255,255,.06);transition:background .1s}
a:hover{background:#1f1f28}.fav{width:16px;height:16px;border-radius:3px;flex-shrink:0}.title{flex:1;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.domain{font-size:.7rem;color:#a09eb0;flex-shrink:0;font-family:monospace}footer{margin-top:36px;font-size:.7rem;color:#5a5870}</style></head>
<body><h1>📋 ${esc(label)}</h1><div class="meta">${tabs.length} tabs · Saved ${new Date().toLocaleString()}</div>
<div class="links">${rows}</div><footer>Auto-saved by Extended History</footer></body></html>`;
}

// ── Tab activated (user switches tabs) ───────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await commitSegment();
  activeTabId = null; activeDomain = null;

  if (!windowFocused) return;            // window not focused — don't start timing

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && isTrackable(tab.url)) {
      startSegment(tabId, domainOf(tab.url));
    }
  } catch {}
});

// ── Tab URL changed (navigation within same tab) ─────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (tabId !== activeTabId) return;
  if (!info.url) return;                 // not a URL change, ignore
  if (!isTrackable(info.url)) {
    await commitSegment();
    activeDomain = null;
    return;
  }
  await commitSegment();
  startSegment(tabId, domainOf(info.url));
});

// ── Tab closed ───────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== activeTabId) return;
  await commitSegment();
  activeTabId = null; activeDomain = null;
});

// ── Window focus changes (alt-tab away / back) ────────────────────────────────
chrome.windows.onFocusChanged.addListener(async wid => {
  if (wid === chrome.windows.WINDOW_ID_NONE) {
    // User left Chrome entirely
    windowFocused = false;
    await commitSegment();
    activeTabId = null; activeDomain = null;
  } else {
    // User came back to Chrome — find the active tab in this window
    windowFocused = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
      if (tab && isTrackable(tab.url)) {
        startSegment(tab.id, domainOf(tab.url));
      }
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
  const m = await chrome.storage.local.get('eh_migration_done');
  if (m.eh_migration_done) return;
  const existing = await chrome.storage.local.get(LEGACY_KEYS.map(([k]) => k));
  const toSet = {};
  for (const [oldKey, newKey] of LEGACY_KEYS) {
    if (existing[oldKey] !== undefined) {
      const cur = await chrome.storage.local.get(newKey);
      if (!cur[newKey] || (Array.isArray(cur[newKey]) && !cur[newKey].length))
        toSet[newKey] = existing[oldKey];
    }
  }
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  await chrome.storage.local.set({ eh_migration_done: true });
}

// ── Session tracking ─────────────────────────────────────────────────────────
let sessionId    = null;
let sessionTabs  = {};
let sessionStart = null;

// Persist current session state so SW restarts don't lose it
async function saveSessionState() {
  if (!sessionId) return;
  await chrome.storage.local.set({ eh_cur_session: { sessionId, sessionStart, sessionTabs } });
}
async function loadSessionState() {
  const r = await chrome.storage.local.get('eh_cur_session');
  if (r.eh_cur_session) {
    sessionId    = r.eh_cur_session.sessionId;
    sessionStart = r.eh_cur_session.sessionStart;
    sessionTabs  = r.eh_cur_session.sessionTabs || {};
  }
}
async function clearSessionState() {
  await chrome.storage.local.remove('eh_cur_session');
}

// ── Tab Storage helpers ──────────────────────────────────────────────────────
async function getTabStorage() {
  const r = await chrome.storage.local.get(TAB_STORAGE_KEY);
  return r[TAB_STORAGE_KEY] || [];
}
async function removeTabStorageEntry(id) {
  const stored = await getTabStorage();
  const next = stored.filter(e => e.id !== id);
  await chrome.storage.local.set({ [TAB_STORAGE_KEY]: next });
  return next;
}

async function getSessions() {
  const r = await chrome.storage.local.get(SESSIONS_KEY);
  return r[SESSIONS_KEY] || [];
}
async function getMaxSessions() {
  const r = await chrome.storage.local.get('eh_max_sessions');
  return r.eh_max_sessions || MAX_SESSIONS_DEFAULT;
}

async function saveSessions(list) {
  const max = await getMaxSessions();
  if (list.length > max) list = list.slice(-max);
  await chrome.storage.local.set({ [SESSIONS_KEY]: list });
}
async function beginSession() {
  sessionId    = `s_${Date.now()}`;
  sessionTabs  = {};
  sessionStart = Date.now();
  try {
    const tabs = await chrome.tabs.query({});
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

chrome.tabs.onCreated.addListener(async tab => {
  if (!sessionId || !isTrackable(tab.url)) return;
  sessionTabs[tab.id] = { url: tab.url||'', title: tab.title||'', domain: domainOf(tab.url||''), windowId: tab.windowId||null, opened: Date.now(), closed: null };
  await saveSessionState();
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!sessionId || !info.url || !isTrackable(info.url)) return;
  const prev = sessionTabs[tabId];
  sessionTabs[tabId] = { url: info.url, title: tab.title||'', domain: domainOf(info.url), windowId: tab.windowId||null, opened: prev?.opened||Date.now(), closed: null };
  await saveSessionState();
});
chrome.tabs.onRemoved.addListener(async tabId => {
  if (sessionTabs[tabId]) {
    sessionTabs[tabId].closed = Date.now();
    await saveSessionState();
  }
});

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PARENT_ID,
      title: 'Extended History',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (chrome.runtime.lastError) console.warn('[EH] context menu parent failed:', chrome.runtime.lastError.message); });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_IGNORE_DOMAIN_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: "Don't keep this domain in history",
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (chrome.runtime.lastError) console.warn('[EH] ignore menu failed:', chrome.runtime.lastError.message); });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_STORE_TAB_ID,
      parentId: CONTEXT_MENU_PARENT_ID,
      title: 'Store this tab',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    }, () => { if (chrome.runtime.lastError) console.warn('[EH] store tab menu failed:', chrome.runtime.lastError.message); });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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
      await chrome.storage.local.set({ [TAB_STORAGE_KEY]: stored });
    }
    if (tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
});

// ── Startup / Install ────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  ensureContextMenus();
  await migrateStorage();
  await finishSession();
  await beginSession();
  await resumeActiveTab();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  ensureContextMenus();
  await migrateStorage();
  await beginSession();
  await resumeActiveTab();
  
  // Always backfill Chrome history on install/update to ensure we have all history
  // This runs on first install, updates, and reinstalls
  try {
    const items   = await chrome.history.search({ text:'', startTime:0, maxResults:100000 });
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
    await chrome.storage.local.set({ [BACKFILL_KEY]:true });
    //console.log(`[EH] Backfilled ${newOnes.length} entries`);
  } catch(e) { console.error('[EH] backfill',e); }
});

// ── History storage ──────────────────────────────────────────────────────────
async function getAll() { const r=await chrome.storage.local.get(HISTORY_KEY); return r[HISTORY_KEY]||[]; }
async function setAll(e) { await chrome.storage.local.set({ [HISTORY_KEY]:e }); }
async function getSettings() { const r=await chrome.storage.local.get(SETTINGS_KEY); return {...DEFAULT_SETTINGS,...(r[SETTINGS_KEY]||{})}; }
async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  
  // NEW: If ignore list was just enabled/disabled, clean history immediately if enabled
  if (newSettings.hasOwnProperty('ignoreListEnabled')) {
    if (newSettings.ignoreListEnabled) {
      // Just enabled - clean ignored URLs from history
      await cleanIgnoredFromHistory();
    }
    // If disabled, we don't need to do anything - URLs will just be allowed
  }
}
function normalizeUrl(url) { try { const u=new URL(url); u.hash=''; return u.toString().replace(/\/$/,''); } catch { return url; } }

async function recordVisit(url, title, tabId) {
  if (!isTrackable(url)) return;
  if (await shouldIgnoreUrl(url)) return; // Skip if in ignore list
  const settings = await getSettings();
  const now      = Date.now();
  const cutoff   = now - settings.retentionDays * 86400000;
  let entries    = await getAll();
  const norm     = normalizeUrl(url);
  const dup      = entries.findIndex(e=>e.url===norm && (now-e.visitTime)<5000);
  if (dup !== -1) { if (title && !entries[dup].title) { entries[dup].title=title; await setAll(entries); await updateTodayHistory(); } return; }
  entries.push({ id:`${now}_${Math.random().toString(36).slice(2,6)}`, url:norm, rawUrl:url, title:title||'', visitTime:now, domain:domainOf(url), tabId:tabId||null });
  entries = entries.filter(e=>e.visitTime>=cutoff);
  if (entries.length>settings.maxEntries) entries=entries.slice(entries.length-settings.maxEntries);
  await setAll(entries);
  await updateTodayHistory();
}

chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
  if (['auto_subframe','manual_subframe'].includes(details.transitionType)) return;
  let title='';
  const url = details.url;
  // Check ignore list FIRST - before Chrome commits to history
  if (await shouldIgnoreUrl(url)) {
    await cleanupIgnoredUrlFromNativeHistory(url);
    return; // Don't record in extension
  }
  try { const tab=await chrome.tabs.get(details.tabId); title=tab?.title||''; } catch {}
  await recordVisit(details.url, title, details.tabId);
});

chrome.webNavigation.onCompleted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
   // Skip if ignored (shouldn't be in our storage, but double-check)
  if (await shouldIgnoreUrl(details.url)) {
    await cleanupIgnoredUrlFromNativeHistory(details.url);
    return;
  }
  try {
    const tab=await chrome.tabs.get(details.tabId); if (!tab?.title) return;
    const entries=await getAll(); const norm=normalizeUrl(details.url);
    const idx=entries.findIndex(e=>e.url===norm&&(Date.now()-e.visitTime)<30000&&!e.title);
    if (idx!==-1) { 
      entries[idx].title=tab.title; 
      await setAll(entries); 
      // Update today's history when title is updated
      await updateTodayHistory();
    }
  } catch {}
});

// ── Message API ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg,_s,respond)=>{ handle(msg).then(respond).catch(err=>respond({error:err.message})); return true; });

async function handle(msg) {
  switch(msg.type) {
    case 'SEARCH': {
      const {query='',mode='all',startDate,endDate,limit=5000,offset=0}=msg;
      let entries=await getAll();
      if (startDate) entries=entries.filter(e=>e.visitTime>=startDate);
      if (endDate)   entries=entries.filter(e=>e.visitTime<=endDate);
      if (query) {
        const q=query.toLowerCase();
        entries=entries.filter(e=>{
          if (mode==='title')  return (e.title||'').toLowerCase().includes(q);
          if (mode==='url')    return e.url.toLowerCase().includes(q);
          if (mode==='domain') return (e.domain||'').toLowerCase().includes(q);
          return e.url.toLowerCase().includes(q)||(e.title||'').toLowerCase().includes(q)||(e.domain||'').toLowerCase().includes(q);
        });
      }
      entries.sort((a,b)=>b.visitTime-a.visitTime);
      return {total:entries.length,entries:entries.slice(offset,offset+limit)};
    }
    case 'DELETE_IDS': {
      const s=new Set(msg.ids);
      const all = await getAll();
      const toDelete = all.filter(e => s.has(e.id));
      await setAll(all.filter(e => !s.has(e.id)));
      // Remove from Chrome native history too
      for (const e of toDelete) {
        try { await chrome.history.deleteUrl({ url: e.url }); } catch {}
      }
      // CRITICAL: Update today's history
      //console.log('[EH] Updating today history after deleting', toDelete.length, 'entries');
      await updateTodayHistory();
      return {success:true};
    }
    case 'DELETE_MATCHING': {
      const {query='',mode='all',startDate,endDate}=msg;
      let entries=await getAll(); const q=query.toLowerCase();
      const toDelete=entries.filter(e=>{
        const ms=!startDate||e.visitTime>=startDate; const me=!endDate||e.visitTime<=endDate;
        let mq=true; if(q){
          if(mode==='title') mq=(e.title||'').toLowerCase().includes(q);
          else if(mode==='url') mq=e.url.toLowerCase().includes(q);
          else if(mode==='domain') mq=(e.domain||'').toLowerCase().includes(q);
          else mq=e.url.toLowerCase().includes(q)||(e.title||'').toLowerCase().includes(q)||(e.domain||'').toLowerCase().includes(q);
        }
        return ms&&me&&mq;
      });
      const toDeleteIds=new Set(toDelete.map(e=>e.id));
      await setAll(entries.filter(e=>!toDeleteIds.has(e.id)));
      // Remove from Chrome native history too
      for (const e of toDelete) {
        try { await chrome.history.deleteUrl({ url: e.url }); } catch {}
      }
      // Update today's history
      //console.log('[EH] Updating today history after DELETE_MATCHING, deleted', toDelete.length, 'entries');
      await updateTodayHistory();
      return {success:true,deleted:toDelete.length};
    }
    case 'DELETE_HISTORY_RANGE': {
      const { startTime, endTime, clearCookies, clearCache } = msg;
      // Delete from extension storage
      let entries = await getAll();
      const before = entries.length;
      entries = entries.filter(e => !(e.visitTime >= startTime && e.visitTime <= endTime));
      await setAll(entries);
      const deleted = before - entries.length;
      // Delete from Chrome native history
      try { await chrome.history.deleteRange({ startTime, endTime }); } catch {}
      // Optionally clear cookies and cache
      if (clearCookies || clearCache) {
        const since = startTime;
        const dataTypes = {};
        if (clearCookies) { dataTypes.cookies = true; dataTypes.localStorage = true; dataTypes.indexedDB = true; }
        if (clearCache)   { dataTypes.cache = true; dataTypes.cacheStorage = true; }
        try { await chrome.browsingData.remove({ since }, dataTypes); } catch {}
      }
      // Update today's history
      await updateTodayHistory();
      return { success: true, deleted };
    }
    case 'CLEAR_ALL': {
      await setAll([]);
      try { await chrome.history.deleteAll(); } catch {}
      // Update today's history
      await updateTodayHistory();
      return { success: true };
    }
    case 'GET_STATS': {
      const entries=await getAll(); const used=await chrome.storage.local.getBytesInUse(HISTORY_KEY);
      const oldest=entries.length?Math.min(...entries.map(e=>e.visitTime)):null;
      const now=Date.now(); const daily={};
      for(let i=89;i>=0;i--) daily[new Date(now-i*86400000).toLocaleDateString('en-CA')]=0;
      for(const e of entries){const d=new Date(e.visitTime).toLocaleDateString('en-CA'); if(d in daily) daily[d]++;}
      return {totalEntries:entries.length,storageMB:(used/1048576).toFixed(1),oldestEntry:oldest,dailyActivity:daily};
    }
    case 'GET_TIME_DATA': {
      const {days=30}=msg; const r=await chrome.storage.local.get(TIME_KEY); const map=r[TIME_KEY]||{};
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
    case 'GET_DEVICES': { try{return {devices:await chrome.sessions.getDevices()};}catch{return {devices:[]};} }
    case 'GET_TODAY_HISTORY': {
      const r = await chrome.storage.local.get(TODAY_HISTORY_KEY);
      return { entries: r[TODAY_HISTORY_KEY] || [] };
    }
    case 'GET_CURRENT_SESSION': {
      const r = await chrome.storage.local.get(CURRENT_SESSION_KEY);
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
    case 'CLEAR_TAB_STORAGE': {
      await chrome.storage.local.set({ [TAB_STORAGE_KEY]: [] });
      return { success: true };
    }
    case 'SET_MAX_SESSIONS': {
      const val = Math.max(1, Math.min(20, parseInt(msg.value) || MAX_SESSIONS_DEFAULT));
      await chrome.storage.local.set({ eh_max_sessions: val });
      // Trim existing sessions if new max is smaller
      const list = await getSessions();
      if (list.length > val) await chrome.storage.local.set({ [SESSIONS_KEY]: list.slice(-val) });
      return { success: true, value: val };
    }
    case 'SET_AUTO_SAVE_INTERVAL': {
      const mins = parseInt(msg.minutes) || 0;
      const safe = mins === 0 ? 0 : Math.max(1, Math.min(1440, mins));
      await chrome.storage.local.set({ [AUTO_SAVE_KEY]: safe });
      _lastAutoSave = 0; // reset so next tick recalculates
      return { success: true, minutes: safe };
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
          try { await chrome.tabs.create({ url: t.url, active: false }); } catch {}
        }
      }
      return { success: true };
    }
    case 'GET_SETTINGS': { return await getSettings(); }
    case 'SAVE_SETTINGS': {
      const cur=await getSettings(); 
      const next={...cur,...msg.settings};
      //console.log('[EH] SAVE_SETTINGS:', { current: cur, incoming: msg.settings, merged: next });
      await chrome.storage.local.set({[SETTINGS_KEY]:next}); 
      return {success:true,settings:next};
    }
    case 'EXPORT': {
      const entries=await getAll(); const tr=await chrome.storage.local.get(TIME_KEY); const sess=await getSessions();
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
      return {success:true,imported:count};
    }
    case 'RE_BACKFILL': {
      try {
        await chrome.storage.local.remove(BACKFILL_KEY);
        const items=await chrome.history.search({text:'',startTime:0,maxResults:100000});
        const entries=items.filter(i=>isTrackable(i.url)).map(i=>({
          id:`bf_${i.lastVisitTime}_${Math.random().toString(36).slice(2,6)}`,
                                                                  url:normalizeUrl(i.url),rawUrl:i.url,title:i.title||'',
                                                                  visitTime:i.lastVisitTime||Date.now(),domain:domainOf(i.url),tabId:null,source:'backfill',
        }));
        const existing=await getAll();
        const existingSet=new Set(existing.map(e=>`${e.url}|${Math.floor(e.visitTime/5000)}`));
        const newOnes=entries.filter(e=>!existingSet.has(`${e.url}|${Math.floor(e.visitTime/5000)}`));
        if(newOnes.length) await setAll([...existing,...newOnes].sort((a,b)=>b.visitTime-a.visitTime));
        await chrome.storage.local.set({[BACKFILL_KEY]:true});
        // Update today's history
        await updateTodayHistory();
        return {success:true,imported:newOnes.length};
      } catch(e){return {error:e.message};}
    }
    case 'GET_BOOKMARKS': { try{return {tree:await chrome.bookmarks.getTree()};}catch{return {tree:[]};} }
    case 'MOVE_BOOKMARK': {
      try {
        await chrome.bookmarks.move(msg.id, { parentId: msg.parentId });
        return { success: true };
      } catch(e) { return { error: e.message }; }
    }
    case 'DELETE_BOOKMARK': {
      try {
        // removeTree handles both bookmarks and folders
        await chrome.bookmarks.removeTree(msg.id);
        return { success: true };
      } catch(e) { return { error: e.message }; }
    }
    case 'RENAME_BOOKMARK': {
      try {
        await chrome.bookmarks.update(msg.id, { title: msg.title });
        return { success: true };
      } catch(e) { return { error: e.message }; }
    }
    case 'CREATE_BOOKMARK_FOLDER': {
      try {
        const folder = await chrome.bookmarks.create({ parentId: msg.parentId, title: msg.title });
        return { success: true, id: folder.id };
      } catch(e) { return { error: e.message }; }
    }
    case 'IMPORT_BOOKMARKS': {
      const {bookmarks}=msg; let imported=0;
      for(const bm of (bookmarks||[])) if(bm.url){try{await chrome.bookmarks.create({title:bm.title||bm.url,url:bm.url});imported++;}catch{}}
      return {success:true,imported};
    }
    case 'OPEN_INCOGNITO': { try{await chrome.windows.create({url:msg.url,incognito:true});}catch{} return {success:true}; }
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
      await chrome.storage.local.remove(TIME_KEY);
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