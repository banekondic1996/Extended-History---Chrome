/**
 * Extended History — background.js v3.3
 * Time tracking: purely event-driven per-tab, domain-bucketed by day.
 */

const HISTORY_KEY  = 'eh_history';
const TIME_KEY     = 'eh_time';
const SETTINGS_KEY = 'eh_settings';
const SESSIONS_KEY = 'eh_sessions';
const BACKFILL_KEY = 'eh_backfilled';
const MAX_SESSIONS_DEFAULT = 4;

const DEFAULT_SETTINGS = {
  retentionDays: 3650,
  maxEntries:    2000000,
  accentColor:   '#3b9eff',
  accentColor2:  '#2dd4a0',
  font:          'system-ui',
  fontSize:      15,
  theme:         'dark',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function todayKey() { return new Date().toLocaleDateString('en-CA'); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function isTrackable(url) {
  if (!url) return false;
  return !['chrome://','chrome-extension://','about:','data:','javascript:','moz-extension://','edge://','brave://'].some(p => url.startsWith(p));
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
chrome.alarms.create('eh_tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'eh_tick') return;
  if (activeDomain && segmentStart && windowFocused) {
    await commitSegment();
    segmentStart = Date.now();
  } else if (!segmentStart) {
    await resumeActiveTab();
  }
});

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
        sessionTabs[t.id] = { url: t.url, title: t.title||'', domain: domainOf(t.url), opened: Date.now(), closed: null };
    }
  } catch {}
  await saveSessionState();
}
async function finishSession() {
  // Restore persisted state in case SW restarted (sessionId would be null)
  if (!sessionId) await loadSessionState();
  if (!sessionId) return; // truly no session
  const list = await getSessions();
  const tabs = Object.values(sessionTabs).filter(t => t.url);
  const uniq = new Set(tabs.map(t => t.url));
  if (tabs.length) list.push({ id: sessionId, start: sessionStart, end: Date.now(), tabCount: uniq.size, tabs });
  await saveSessions(list);
  sessionId = null; sessionTabs = {}; sessionStart = null;
  await clearSessionState();
}

chrome.tabs.onCreated.addListener(async tab => {
  if (!sessionId || !isTrackable(tab.url)) return;
  sessionTabs[tab.id] = { url: tab.url||'', title: tab.title||'', domain: domainOf(tab.url||''), opened: Date.now(), closed: null };
  await saveSessionState();
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!sessionId || !info.url || !isTrackable(info.url)) return;
  const prev = sessionTabs[tabId];
  sessionTabs[tabId] = { url: info.url, title: tab.title||'', domain: domainOf(info.url), opened: prev?.opened||Date.now(), closed: null };
  await saveSessionState();
});
chrome.tabs.onRemoved.addListener(async tabId => {
  if (sessionTabs[tabId]) {
    sessionTabs[tabId].closed = Date.now();
    await saveSessionState();
  }
});

// ── Context menus ────────────────────────────────────────────────────────────
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id:'eh_open_tab',       title:'Open in new tab',         contexts:['link'] });
    chrome.contextMenus.create({ id:'eh_open_incognito', title:'Open in incognito window', contexts:['link'] });
    chrome.contextMenus.create({ id:'eh_copy_link',      title:'Copy link address',        contexts:['link'] });
  });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl; if (!url) return;
  if (info.menuItemId === 'eh_open_tab')       chrome.tabs.create({ url });
  if (info.menuItemId === 'eh_open_incognito') chrome.windows.create({ url, incognito:true });
  if (info.menuItemId === 'eh_copy_link')
    chrome.scripting?.executeScript({ target:{tabId:tab.id}, func:u=>navigator.clipboard.writeText(u), args:[url] }).catch(()=>{});
});

// ── Startup / Install ────────────────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  await migrateStorage();
  setupContextMenus();
  await finishSession();
  await beginSession();
  await resumeActiveTab();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrateStorage();
  setupContextMenus();
  await beginSession();
  await resumeActiveTab();
  const done = await chrome.storage.local.get(BACKFILL_KEY);
  if (done[BACKFILL_KEY]) return;
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
    if (newOnes.length) await setAll([...existing,...newOnes].sort((a,b)=>b.visitTime-a.visitTime));
    await chrome.storage.local.set({ [BACKFILL_KEY]:true });
    console.log(`[EH] Backfilled ${newOnes.length} entries`);
  } catch(e) { console.error('[EH] backfill',e); }
});

// ── History storage ──────────────────────────────────────────────────────────
async function getAll() { const r=await chrome.storage.local.get(HISTORY_KEY); return r[HISTORY_KEY]||[]; }
async function setAll(e) { await chrome.storage.local.set({ [HISTORY_KEY]:e }); }
async function getSettings() { const r=await chrome.storage.local.get(SETTINGS_KEY); return {...DEFAULT_SETTINGS,...(r[SETTINGS_KEY]||{})}; }
function normalizeUrl(url) { try { const u=new URL(url); u.hash=''; return u.toString().replace(/\/$/,''); } catch { return url; } }

async function recordVisit(url, title, tabId) {
  if (!isTrackable(url)) return;
  const settings = await getSettings();
  const now      = Date.now();
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

chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
  if (['auto_subframe','manual_subframe'].includes(details.transitionType)) return;
  let title='';
  try { const tab=await chrome.tabs.get(details.tabId); title=tab?.title||''; } catch {}
  await recordVisit(details.url, title, details.tabId);
});

chrome.webNavigation.onCompleted.addListener(async details => {
  if (details.frameId!==0||!isTrackable(details.url)) return;
  try {
    const tab=await chrome.tabs.get(details.tabId); if (!tab?.title) return;
    const entries=await getAll(); const norm=normalizeUrl(details.url);
    const idx=entries.findIndex(e=>e.url===norm&&(Date.now()-e.visitTime)<30000&&!e.title);
    if (idx!==-1) { entries[idx].title=tab.title; await setAll(entries); }
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
      return { success: true, deleted };
    }
    case 'CLEAR_ALL': {
      await setAll([]);
      try { await chrome.history.deleteAll(); } catch {}
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
    case 'GET_SESSIONS': {
      const list=await getSessions();
      const maxSess=await getMaxSessions();
      return {sessions:list.slice().reverse(),current:sessionId?{id:sessionId,start:sessionStart,tabs:Object.values(sessionTabs).filter(t=>t.url)}:null,maxSessions:maxSess};
    }
    case 'SET_MAX_SESSIONS': {
      const val = Math.max(1, Math.min(20, parseInt(msg.value) || MAX_SESSIONS_DEFAULT));
      await chrome.storage.local.set({ eh_max_sessions: val });
      // Trim existing sessions if new max is smaller
      const list = await getSessions();
      if (list.length > val) await chrome.storage.local.set({ [SESSIONS_KEY]: list.slice(-val) });
      return { success: true, value: val };
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
      const cur=await getSettings(); const next={...cur,...msg.settings};
      await chrome.storage.local.set({[SETTINGS_KEY]:next}); return {success:true,settings:next};
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
    default: return {error:`Unknown: ${msg.type}`};
  }
}
