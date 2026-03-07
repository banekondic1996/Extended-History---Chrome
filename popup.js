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

// ── Recent closed tabs ────────────────────────────────────────────────────────
function loadRecentTabs() {
    chrome.sessions.getRecentlyClosed({ maxResults: 15 }, sessions => {
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

        const validTabs = tabs.filter(tab => {
            if (!tab.lastModified) return false;
            const ageInDays = (Date.now() - tab.lastModified * 1000) / (1000 * 60 * 60 * 24);
            return ageInDays >= 0 && ageInDays <= 30;
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
}

// Helper: format time ago
function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// Load initially
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