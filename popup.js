// popup.js — fast, reads storage directly (no message round-trip for history list)

function tryDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function favUrl(domain) {
    // Use Google's favicon service as primary — works for all sites including google.com/youtube.com
    return `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(domain)}`;
    //return `${chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent("https://" + domain)}`)}`;

}

// ── Theme ─────────────────────────────────────────────────────────────────────
chrome.storage.local.get('eh_settings', r => {
    const s = r.eh_settings || {};
    document.documentElement.setAttribute('data-theme', s.theme || 'dark');
    if (s.accentColor)  document.documentElement.style.setProperty('--accent',  s.accentColor);
    if (s.accentColor2) document.documentElement.style.setProperty('--accent2', s.accentColor2);
});

// ── Header "Open" button ──────────────────────────────────────────────────────
document.getElementById('openBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'history.html' });
});

// ── Tab switcher ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        
        // Update tab buttons
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Update panels
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

// ── Recent history — read today's history only for fast loading ─────────────
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
            const dom = e.domain || tryDomain(e.url);
            const t   = new Date(e.visitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const row = document.createElement('div');
            row.className = 'ritem';
            row.addEventListener('click', () => chrome.tabs.create({ url: e.url }));

            const img = document.createElement('img');
            img.className = 'rfav';
            img.loading   = 'lazy';
            img.src       = favUrl(dom);
            img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

            const body  = document.createElement('div');
            body.className = 'rbody';

            const title = document.createElement('div');
            title.className   = 'rtitle';
            title.textContent = e.title || e.url;

            const url = document.createElement('div');
            url.className   = 'rurl';
            url.textContent = dom;

            body.appendChild(title);
            body.appendChild(url);

            const time = document.createElement('div');
            time.className   = 'rtime';
            time.textContent = t;

            row.appendChild(img);
            row.appendChild(body);
            row.appendChild(time);
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

        // Extract tabs from sessions (can be individual tabs or windows)
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
                // If it's a window, add all its tabs
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

        // Filter out tabs with invalid timestamps and sort by most recent
        const validTabs = tabs.filter(tab => {
            // Ensure timestamp is valid and not too old (within last 30 days)
            if (!tab.lastModified) return false;
            const milliseconds = tab.lastModified * 1000;
            const ageInDays = (Date.now() - milliseconds) / (1000 * 60 * 60 * 24);
            return ageInDays >= 0 && ageInDays <= 30;
        }).sort((a, b) => b.lastModified - a.lastModified);

        if (!validTabs.length) {
            el.innerHTML = '<div class="empty">No recently closed tabs</div>';
            return;
        }

        el.innerHTML = '';
        for (const tab of validTabs.slice(0, 15)) {
            const dom = tryDomain(tab.url);
            const timeAgo = getTimeAgo(tab.lastModified);

            const row = document.createElement('div');
            row.className = 'ritem';
            
            // Click to restore the tab
            row.addEventListener('click', () => {
                if (tab.sessionId) {
                    chrome.sessions.restore(tab.sessionId);
                } else {
                    chrome.tabs.create({ url: tab.url });
                }
            });

            const img = document.createElement('img');
            img.className = 'rfav';
            img.loading   = 'lazy';
            img.src       = favUrl(dom);
            img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

            const body  = document.createElement('div');
            body.className = 'rbody';

            const title = document.createElement('div');
            title.className   = 'rtitle';
            title.textContent = tab.title || tab.url;

            const url = document.createElement('div');
            url.className   = 'rurl';
            url.textContent = dom;

            body.appendChild(title);
            body.appendChild(url);

            const time = document.createElement('div');
            time.className   = 'rtime';
            time.textContent = timeAgo;

            row.appendChild(img);
            row.appendChild(body);
            row.appendChild(time);
            el.appendChild(row);
        }
    });
}

// Helper function to format time ago
function getTimeAgo(timestamp) {
    // chrome.sessions.getRecentlyClosed returns timestamp in SECONDS, not milliseconds
    const milliseconds = timestamp * 1000;
    const seconds = Math.floor((Date.now() - milliseconds) / 1000);
    
    if (seconds < 60) return 'just now';
    if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        return `${mins}m ago`;
    }
    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return `${hours}h ago`;
    }
    const days = Math.floor(seconds / 86400);
    return `${days}d ago`;
}

// Load initially
loadRecentTabs();
loadTodayHistory();

// Listen for storage changes to auto-refresh when history is deleted
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.eh_today_history) {
        //console.log('[Popup] Today history changed, refreshing...');
        loadTodayHistory();
    }
});

// Listen for tab/window close events to refresh recent tabs
chrome.tabs.onRemoved.addListener(() => {
    setTimeout(loadRecentTabs, 100); // Small delay to let Chrome update sessions
});

chrome.windows.onRemoved.addListener(() => {
    setTimeout(loadRecentTabs, 100);
});

// Polling fallback - check every 2 seconds if popup is visible
// This ensures refresh even if storage event is missed
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