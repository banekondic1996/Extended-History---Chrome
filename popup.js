// popup.js — fast, reads storage directly (no message round-trip for history list)

function tryDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function favUrl(domain) {
    // Use Google's favicon service as primary — works for all sites including google.com/youtube.com
    return `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(domain)}`;
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

// ── Footer panel buttons ──────────────────────────────────────────────────────
document.querySelectorAll('.flink[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'history.html#' + btn.dataset.panel });
    });
});

// ── Recent history — read directly from storage, no message round-trip ────────
chrome.storage.local.get('eh_history', r => {
    const all = r.eh_history || [];
    // Sort descending, take top 30
    const entries = all.slice().sort((a, b) => b.visitTime - a.visitTime).slice(0, 30);
    const el = document.getElementById('recent');

    if (!entries.length) {
        el.innerHTML = '<div class="loading">No history yet</div>';
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
