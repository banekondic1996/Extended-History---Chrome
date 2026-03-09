// popup.js — fast, reads storage directly (no message round-trip for history list)

let _searchTimer = null;

function tryDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function favUrl(domain) {
    return `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(domain)}`;
}

// ── Theme & Popup Settings ────────────────────────────────────────────────────
chrome.storage.local.get('eh_settings', r => {
    const s = r.eh_settings || {};
    document.documentElement.setAttribute('data-theme', s.theme || 'dark');
    if (s.accentColor)  document.documentElement.style.setProperty('--accent',  s.accentColor);
    if (s.accentColor2) document.documentElement.style.setProperty('--accent2', s.accentColor2);

    // Popup-specific settings
    if (s.popupShowSearch === false) document.querySelector('.search-bar').style.display = 'none';
    if (s.popupShowTabs   === false) document.getElementById('tabsRow').style.display    = 'none';
    if (s.popupHeight) {
        document.querySelector('.content').style.maxHeight = s.popupHeight + 'px';
        document.querySelector('.search-list').style.maxHeight = s.popupHeight + 'px';
    }
});

// ── Header "Open" button ──────────────────────────────────────────────────────
document.getElementById('openBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'history.html' });
});

// ── Header "Store" button — save current tab to Tab Storage ──────────────────
document.getElementById('storeBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
            return;
        }
        chrome.runtime.sendMessage({ type: 'GET_TAB_STORAGE' }, (r) => {
            const stored = (r && r.entries) || [];
            if (stored.find(e => e.url === tab.url)) {
                // Already stored — just close
                chrome.tabs.remove(tab.id);
                return;
            }
            const entry = {
                id: 'ts_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                url: tab.url,
                title: tab.title || tab.url,
                domain: (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
                savedAt: Date.now(),
            };
            stored.push(entry);
            chrome.storage.local.set({ eh_tab_storage: stored }, () => {
                chrome.tabs.remove(tab.id);
            });
        });
    });
});

// ── Tab switcher ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        document.getElementById(`panel-${tabName}`).classList.add('active');
    });
});

// ── Footer panel buttons ──────────────────────────────────────────────────────
document.querySelectorAll('.flink[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'history.html#' + btn.dataset.panel });
    });
});

// ── Helper: build a row <a> element ──────────────────────────────────────────
function makeRow(url, title, timeText, onLeftClick) {
    const dom = tryDomain(url);

    // Use <a> so Chrome's native context menu provides open in new tab / copy URL etc.
    const row = document.createElement('a');
    row.className = 'ritem';
    row.href = url;
    row.title = (title || url) + '\n' + url; // native tooltip

    // Left click: use extension navigation rather than default link navigation
    row.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (ev.button === 0) onLeftClick();
    });

    const img = document.createElement('img');
    img.className = 'rfav';
    img.loading   = 'lazy';
    img.src       = favUrl(dom);
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

    const body  = document.createElement('div');
    body.className = 'rbody';

    const titleEl = document.createElement('div');
    titleEl.className   = 'rtitle';
    titleEl.textContent = title || url;

    body.appendChild(titleEl);

    const time = document.createElement('div');
    time.className   = 'rtime';
    time.textContent = timeText;

    row.appendChild(img);
    row.appendChild(body);
    row.appendChild(time);
    return row;
}

// ── Search Functionality ──────────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', (e) => {
    const query = e.target.value.trim();
    const clearBtn = document.getElementById('searchClear');

    clearBtn.classList.toggle('visible', !!query);
    clearTimeout(_searchTimer);

    if (!query) {
        closeSearchOverlay();
        return;
    }

    document.getElementById('searchResults').innerHTML = '<div class="loading">Searching...</div>';
    openSearchOverlay();

    _searchTimer = setTimeout(() => {
        performSearch(query);
    }, 300);
});

document.getElementById('searchClear').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchClear').classList.remove('visible');
    closeSearchOverlay();
    document.getElementById('searchInput').focus();
});

function openSearchOverlay() {
    const overlay = document.getElementById('searchOverlay');
    if (overlay.classList.contains('active')) return;
    requestAnimationFrame(() => {
        overlay.classList.add('active');
        document.getElementById('tabsRow').classList.add('hidden');
    });
}

function closeSearchOverlay() {
    document.getElementById('searchOverlay').classList.remove('active');
    document.getElementById('tabsRow').classList.remove('hidden');
}

function performSearch(query) {
    const resultsEl = document.getElementById('searchResults');

    chrome.runtime.sendMessage({
        type: 'SEARCH',
        query: query,
        mode: 'all',
        limit: 100
    }, (response) => {
        if (chrome.runtime.lastError) {
            resultsEl.innerHTML = '<div class="empty">Search error</div>';
            return;
        }

        const matches = response.entries || [];

        if (!matches.length) {
            resultsEl.innerHTML = '<div class="empty">No results found</div>';
            return;
        }

        resultsEl.innerHTML = '';
        for (const e of matches) {
            const t = new Date(e.visitTime).toLocaleDateString([], { month: 'short', day: 'numeric' });
            const row = makeRow(e.url, e.title, t, () => chrome.tabs.create({ url: e.url }));
            resultsEl.appendChild(row);
        }
    });
}

// ── Recent history — read today's history only for fast loading ───────────────
function loadTodayHistory() {
    chrome.storage.local.get('eh_today_history', r => {
        const entries = (r.eh_today_history || []).slice().sort((a, b) => b.visitTime - a.visitTime).slice(0, 15);
        const el = document.getElementById('recent');

        if (!entries.length) {
            el.innerHTML = '<div class="empty">No history yet today</div>';
            return;
        }

        el.innerHTML = '';
        for (const e of entries) {
            const t = new Date(e.visitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const row = makeRow(e.url, e.title, t, () => chrome.tabs.create({ url: e.url }));
            el.appendChild(row);
        }
    });
}

// ── Ignore pattern matching (mirrors background.js logic) ────────────────────
function matchesIgnorePatternPopup(url, pattern) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        const pat = pattern.replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();
        const slashIdx = pat.indexOf('/');
        const patHost = slashIdx === -1 ? pat : pat.slice(0, slashIdx);
        const patPath = slashIdx === -1 ? '' : pat.slice(slashIdx);
        if (!patHost) return false;
        const hostMatch = host === patHost || host.endsWith('.' + patHost);
        if (!hostMatch) return false;
        if (patPath) {
            const urlPath = new URL(url).pathname + new URL(url).search;
            return urlPath.startsWith(patPath);
        }
        return true;
    } catch { return false; }
}

// ── Recent closed tabs ────────────────────────────────────────────────────────
function loadRecentTabs() {
    chrome.sessions.getRecentlyClosed({ maxResults: 25 }, sessions => {
        const el = document.getElementById('recentTabs');

        if (!sessions || !sessions.length) {
            el.innerHTML = '<div class="empty">No recently closed tabs</div>';
            return;
        }

        const tabs = [];
        for (const session of sessions) {
            if (session.tab) {
                tabs.push({
                    url: session.tab.url,
                    title: session.tab.title,
                    sessionId: session.tab.sessionId,
                    lastModified: session.lastModified
                });
            } else if (session.window) {
                for (const tab of session.window.tabs || []) {
                    tabs.push({
                        url: tab.url,
                        title: tab.title,
                        sessionId: tab.sessionId,
                        lastModified: session.lastModified
                    });
                }
            }
        }

        if (!tabs.length) {
            el.innerHTML = '<div class="empty">No recently closed tabs</div>';
            return;
        }

        // Fetch ignore list and filter before rendering
        chrome.runtime.sendMessage({ type: 'GET_IGNORE_LIST' }, (ignoreResp) => {
            const ignoreList = (ignoreResp && ignoreResp.list) || [];
            const ignoreEnabled = ignoreResp && ignoreResp.enabled !== false;

            const validTabs = tabs.filter(tab => {
                if (!tab.url || !tab.lastModified) return false;
                const ageInDays = (Date.now() - tab.lastModified * 1000) / (1000 * 60 * 60 * 24);
                if (ageInDays < 0 || ageInDays > 30) return false;
                // Filter out ignored URLs
                if (ignoreEnabled && ignoreList.length) {
                    if (ignoreList.some(pattern => matchesIgnorePatternPopup(tab.url, pattern))) return false;
                }
                return true;
            }).sort((a, b) => b.lastModified - a.lastModified);

            if (!validTabs.length) {
                el.innerHTML = '<div class="empty">No recently closed tabs</div>';
                return;
            }

            el.innerHTML = '';
            for (const tab of validTabs.slice(0, 15)) {
                const timeAgo = getTimeAgo(tab.lastModified);
                const onLeftClick = tab.sessionId
                    ? () => chrome.sessions.restore(tab.sessionId)
                    : () => chrome.tabs.create({ url: tab.url });
                const row = makeRow(tab.url, tab.title, timeAgo, onLeftClick);
                el.appendChild(row);
            }
        });
    });
}

// Helper: format time ago
function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// ── Tab Storage ───────────────────────────────────────────────────────────────

// Show stored-tabs sub-view
function showTsStored() {
  document.getElementById('ts-stored').classList.add('active');
  document.getElementById('ts-quickstore').classList.remove('active');
}

// Show quick-store sub-view (right-click)
function showTsQuickStore() {
  document.getElementById('ts-stored').classList.remove('active');
  document.getElementById('ts-quickstore').classList.add('active');
  renderQuickStoreList();
}

function renderQuickStoreList() {
  const list = document.getElementById('ts-quickstore-list');
  if (!list) return;
  list.innerHTML = '<div class="loading">Loading…</div>';

  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    chrome.runtime.sendMessage({ type: 'GET_TAB_STORAGE' }, (r) => {
      const stored = new Set(((r && r.entries) || []).map(e => e.url));
      const validTabs = tabs.filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));

      list.innerHTML = '';

      if (!validTabs.length) {
        list.innerHTML = '<div class="empty">No storable tabs open</div>';
        return;
      }

      for (const tab of validTabs) {
        const alreadyStored = stored.has(tab.url);
        const item = document.createElement('div');
        item.className = 'ts-quick-item' + (alreadyStored ? ' stored' : '');
        item.title = tab.url;

        const fav = document.createElement('img');
        fav.className = 'ts-quick-fav';
        try { fav.src = `https://www.google.com/s2/favicons?sz=16&domain=${new URL(tab.url).hostname}`; } catch {}
        fav.addEventListener('error', () => { fav.style.visibility = 'hidden'; });

        const title = document.createElement('span');
        title.className = 'ts-quick-title';
        title.textContent = tab.title || tab.url;

        item.appendChild(fav);
        item.appendChild(title);

        if (alreadyStored) {
          const badge = document.createElement('span');
          badge.className = 'ts-quick-badge';
          badge.textContent = 'stored';
          item.appendChild(badge);
        } else {
          item.addEventListener('click', () => {
            const entry = {
              id: 'ts_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              url: tab.url,
              title: tab.title || tab.url,
              domain: (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
              savedAt: Date.now(),
            };
            chrome.runtime.sendMessage({ type: 'GET_TAB_STORAGE' }, (resp) => {
              const existing = (resp && resp.entries) || [];
              if (!existing.find(x => x.url === tab.url)) existing.push(entry);
              chrome.storage.local.set({ eh_tab_storage: existing }, () => {
                chrome.tabs.remove(tab.id, () => renderQuickStoreList());
              });
            });
          });
        }
        list.appendChild(item);
      }
    });
  });
}

function loadTabStoragePopup() {
  const el = document.getElementById('tabStoragePopup');
  if (!el) return;

  chrome.runtime.sendMessage({ type: 'GET_TAB_STORAGE' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      el.innerHTML = '<div class="empty">Error loading tab storage</div>';
      return;
    }

    const entries = response.entries || [];

    if (!entries.length) {
      el.innerHTML = '<div class="empty" style="text-align:center">No stored tabs.<br><small style="opacity:0.6">Right-click this tab button to store open tabs</small></div>';
      return;
    }

    el.innerHTML = '';
    for (const entry of entries) {
      const row = makeRow(entry.url, entry.title, getTimeAgo(Math.floor(entry.savedAt / 1000)), () => {
        chrome.tabs.create({ url: entry.url, active: false });
        chrome.runtime.sendMessage({ type: 'REMOVE_TAB_STORAGE_ENTRY', id: entry.id }, () => {
          loadTabStoragePopup();
        });
      });
      el.appendChild(row);
    }
  });
}

// Wire the Tab Storage tab: left-click → stored view, right-click → quick-store view
(function () {
  const tabStorageTab = document.querySelector('.tab[data-tab="tabstorage"]');
  if (!tabStorageTab) return;

  tabStorageTab.addEventListener('click', () => {
    showTsStored();
    loadTabStoragePopup();
  });

  tabStorageTab.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    // Make sure the tab panel is active
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tabStorageTab.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('panel-tabstorage').classList.add('active');
    showTsQuickStore();
  });
})();

// Initial load for all panels
loadRecentTabs();
loadTodayHistory();

// Auto-refresh on storage change
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.eh_today_history) {
        loadTodayHistory();
    }
});

// Refresh closed tabs list when a tab/window closes
chrome.tabs.onRemoved.addListener(() => { setTimeout(loadRecentTabs, 100); });
chrome.windows.onRemoved.addListener(() => { setTimeout(loadRecentTabs, 100); });

// Polling fallback
let lastCount = 0;
setInterval(() => {
    chrome.storage.local.get('eh_today_history', r => {
        const entries = r.eh_today_history || [];
        if (entries.length !== lastCount) {
            lastCount = entries.length;
            loadTodayHistory();
        }
    });
}, 2000);
// ── Right-click Sessions button → export latest session as HTML ───────────────
(function () {
  function tryDomainLocal(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Build the full export HTML (two-tab: Sessions + Tab Storage) ────────────
  function buildExportHtml(label, tabs, tsEntries) {
    tsEntries = tsEntries || [];
    const validTabs = tabs.filter(t => t.url);
    const windowIds = [...new Set(validTabs.map(t => t.windowId).filter(Boolean))];
    const hasMultiWindow = windowIds.length > 1;

    function tabLink(t) {
      const dom = tryDomainLocal(t.url);
      return '<a href="' + esc(t.url) + '">'
        + '<img class="fav" src="https://www.google.com/s2/favicons?sz=16&domain='
        + encodeURIComponent(dom) + '" loading="lazy" onerror="this.style.display=\'none\'"/>'
        + '<span class="title">' + esc(t.title || t.url) + '</span>'
        + '<span class="domain">' + esc(dom) + '</span></a>';
    }

    // ── Sessions tab content ────────────────────────────────────────────────
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

    // ── Tab Storage tab content (embedded at export time) ───────────────────
    let tsHtml = tsEntries.length
      ? tsEntries.map(e => { try { return tabLink(e); } catch(x) { return ''; } }).join('')
      : '';
    const tsContent = tsEntries.length
      ? '<div class="links">' + tsHtml + '</div>'
      : '<div class="ts-empty">No stored tabs.</div>';

    // ── Styles ──────────────────────────────────────────────────────────────
    const CSS = ':root{--accent:#3b9eff}'
      + '*{box-sizing:border-box;margin:0;padding:0}'
      + 'body{font-family:system-ui,sans-serif;background:#0d0d10;color:#f0eee8;padding:0}'
      + '.page-header{padding:32px 32px 0}'
      + 'h1{font-size:1.3rem;font-weight:700;color:var(--accent);margin-bottom:4px}'
      + '.meta{font-size:.78rem;color:#a09eb0;margin-bottom:20px}'
      + '.tabs-nav{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.08);padding:0 32px}'
      + '.tab-btn{padding:10px 18px;background:none;border:none;border-bottom:2px solid transparent;'
      +   'color:#a09eb0;font-size:.82rem;font-weight:600;cursor:pointer;'
      +   'transition:color .15s,border-color .15s;margin-bottom:-1px}'
      + '.tab-btn:hover{color:#f0eee8}'
      + '.tab-btn.active{color:var(--accent);border-bottom-color:var(--accent)}'
      + '.tab-panel{display:none;padding:20px 32px 40px}'
      + '.tab-panel.active{display:block}'
      + '.links{display:flex;flex-direction:column;gap:3px}'
      + 'a{display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:8px;'
      +   'text-decoration:none;color:#f0eee8;background:#18181f;'
      +   'border:1px solid rgba(255,255,255,.06);transition:background .1s}'
      + 'a:hover{background:#1f1f28}'
      + '.fav{width:16px;height:16px;border-radius:3px;flex-shrink:0}'
      + '.title{flex:1;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.domain{font-size:.7rem;color:#a09eb0;flex-shrink:0;font-family:monospace}'
      + '.win-header{font-size:.75rem;font-weight:700;color:var(--accent);padding:20px 0 6px;'
      +   'display:flex;align-items:center;gap:10px;'
      +   'border-bottom:1px solid rgba(59,158,255,.2);margin-bottom:4px}'
      + '.win-header:first-child{padding-top:4px}'
      + '.win-label{font-weight:700}'
      + '.win-count{font-weight:400;color:#a09eb0;flex:1}'
      + '.restore-bar{padding:0 0 14px}'
      + '.restore-btn{padding:6px 14px;background:rgba(59,158,255,.12);'
      +   'border:1px solid rgba(59,158,255,.35);border-radius:6px;'
      +   'color:var(--accent);font-size:.75rem;font-weight:600;cursor:pointer;'
      +   'transition:background .1s;flex-shrink:0}'
      + '.restore-btn:hover{background:rgba(59,158,255,.22)}'
      + '.ts-empty{color:#a09eb0;font-size:.85rem;padding:20px 0}'
      + 'footer{padding:16px 32px 32px;font-size:.7rem;color:#5a5870}';

    // ── Inline script (IIFE so no globals needed) ───────────────────────────
    const SCRIPT = '(function(){'
      + 'function st(n){'
      +   '["sessions","tabstorage"].forEach(function(x){'
      +     'document.getElementById("tab-"+x).classList.toggle("active",x===n);'
      +     'document.getElementById("btn-"+x).classList.toggle("active",x===n);'
      +   '});'
      + '}'
      + 'document.getElementById("btn-sessions")'
      +   '.addEventListener("click",function(){st("sessions");});'
      + 'document.getElementById("btn-tabstorage")'
      +   '.addEventListener("click",function(){st("tabstorage");});'
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
      +   '<div class="meta">' + validTabs.length + ' tabs \u00B7 Exported ' + new Date().toLocaleString() + '</div>'
      + '</div>\n'
      + '<div class="tabs-nav">'
      +   '<button class="tab-btn active" id="btn-sessions">Sessions</button>'
      +   '<button class="tab-btn" id="btn-tabstorage">Tab Storage</button>'
      + '</div>\n'
      + '<div class="tab-panel active" id="tab-sessions">'
      +   '<div class="links">' + sessHtml + '</div>'
      + '</div>\n'
      + '<div class="tab-panel" id="tab-tabstorage">' + tsContent + '</div>\n'
      + '<footer>Exported by Extended History</footer>\n'
      + '<script>' + SCRIPT + '<\/script>\n'
      + '</body></html>';
  }

  // ── Context-menu handler ────────────────────────────────────────────────────
  const sessionsBtn = document.querySelector('.flink[data-panel="sessions"]');
  if (!sessionsBtn) return;

  sessionsBtn.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, (sessResp) => {
      if (chrome.runtime.lastError || !sessResp) return;
      const { sessions, current } = sessResp;
      const target = sessions && sessions.length ? sessions[sessions.length - 1] : null;
      const tabs = target
        ? target.tabs
        : (current ? current.tabs.filter(t => t.url && t.closed === null) : null);
      if (!tabs || !tabs.length) {
        chrome.tabs.create({ url: 'history.html#sessions' });
        return;
      }
      const label = target
        ? new Date(target.start).toLocaleString(undefined, {
            weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
          })
        : 'Current Session';
      // Fetch Tab Storage then build export
      chrome.runtime.sendMessage({ type: 'GET_TAB_STORAGE' }, (tsResp) => {
        const tsEntries = (tsResp && tsResp.entries) || [];
        const html = buildExportHtml(label, tabs, tsEntries);
        Object.assign(document.createElement('a'), {
          href: URL.createObjectURL(new Blob([html], { type: 'text/html' })),
          download: 'session_' + new Date().toISOString().slice(0,10) + '.html'
        }).click();
      });
    });
  });
})();
// ── Tab Storage in popup ──────────────────────────────────────────────────────
function loadTabStoragePopup() {
  const el = document.getElementById('tabStoragePopup');
  if (!el) return;
  chrome.runtime.sendMessage({ type: 'GET_TAB_STORAGE' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      el.innerHTML = '<div class="empty">Error loading tab storage</div>';
      return;
    }
    const entries = response.entries || [];
    if (!entries.length) {
      el.innerHTML = '<div class="empty" style="text-align:center">No stored tabs.<br><small style="opacity:0.6">Right-click → Extended History → Store this tab</small></div>';
      return;
    }
    el.innerHTML = '';
    for (const entry of entries) {
      const row = makeRow(entry.url, entry.title, getTimeAgo(Math.floor(entry.savedAt / 1000)), () => {
        chrome.tabs.create({ url: entry.url, active: false });
        chrome.runtime.sendMessage({ type: 'REMOVE_TAB_STORAGE_ENTRY', id: entry.id }, () => {
          loadTabStoragePopup();
        });
      });
      el.appendChild(row);
    }
  });
}
document.querySelectorAll('.tab').forEach(tab => {
  if (tab.dataset.tab === 'tabstorage') tab.addEventListener('click', () => loadTabStoragePopup());
});