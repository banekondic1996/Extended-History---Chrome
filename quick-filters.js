/**
 * quick-filters.js — Named, reusable history filters (domains/keywords/URLs).
 *
 * Two surfaces:
 *  1. A dropdown next to the main search box (#quickFilterSelect) — pick a
 *     saved filter to instantly narrow the currently-shown history.
 *  2. A management panel (sidebar → "Quick Filters", under "Ignore List")
 *     where filters are created, edited, and removed.
 *
 * Filtering itself happens entirely client-side against whatever entries are
 * already loaded (the preload cache from history.js), so applying/clearing a
 * quick filter is instant — same "view only" spirit as the history cache.
 */

function qfSend(type, extra = {}) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type, ...extra }, r => {
      if (chrome.runtime.lastError) { rej(new Error(chrome.runtime.lastError.message)); return; }
      if (r && r.error) { rej(new Error(r.error)); return; }
      res(r);
    });
  });
}

function qfToast(msg, type = 'ok') {
  if (typeof toast === 'function') toast(msg, type);
}

// ── State ────────────────────────────────────────────────────────────────────
let _qfList     = [];   // [{id,name,patterns:[]}]
let _qfActiveId = '';   // '' = no filter applied
let _qfEditingId = null; // id currently being edited in the panel form, or null = "new"

// ── Matching ─────────────────────────────────────────────────────────────────
function qfMatchesPattern(entry, rawPattern) {
  const p = (rawPattern || '').trim().toLowerCase();
  if (!p) return false;
  const url    = (entry.url || '').toLowerCase();
  const title  = (entry.title || '').toLowerCase();
  const domain = (entry.domain || (typeof tryDomain === 'function' ? tryDomain(entry.url) : '') || '').toLowerCase();

  // Domain-like pattern (contains a dot, no spaces) — match the domain (incl. subdomains) or full URL
  if (p.includes('.') && !p.includes(' ') && !p.includes('/')) {
    return domain === p || domain.endsWith('.' + p) || url.includes(p);
  }
  // Otherwise treat as a free keyword / URL fragment — match URL or title
  return url.includes(p) || title.includes(p);
}

function qfEntryMatches(entry, filter) {
  return (filter.patterns || []).some(p => qfMatchesPattern(entry, p));
}

// Called by history.js's doSearch() before applying date/search filters.
// Returns entries unchanged when no quick filter is active.
function applyQuickFilterEntries(entries) {
  if (!_qfActiveId) return entries;
  const filter = _qfList.find(f => f.id === _qfActiveId);
  if (!filter) return entries;
  return entries.filter(e => qfEntryMatches(e, filter));
}

// ── Dropdown (next to search box) ───────────────────────────────────────────
function qfRenderDropdown() {
  const sel = document.getElementById('quickFilterSelect');
  if (!sel) return;
  const prev = _qfActiveId;
  sel.innerHTML = '<option value="">Quick Filters: None</option>';
  for (const f of _qfList) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    sel.appendChild(opt);
  }
  // Keep current selection if it still exists, else reset to none
  sel.value = _qfList.some(f => f.id === prev) ? prev : '';
  _qfActiveId = sel.value;
}

async function qfLoadList() {
  try {
    const r = await qfSend('GET_QUICK_FILTERS');
    _qfList = r.filters || [];
  } catch {
    _qfList = [];
  }
  qfRenderDropdown();
}

function qfWireDropdown() {
  const sel = document.getElementById('quickFilterSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    _qfActiveId = sel.value;
    if (typeof doSearch === 'function') doSearch();
  });
}

// ── Management panel ─────────────────────────────────────────────────────────
function qfPanelInner() { return document.getElementById('quickFiltersInner'); }

function qfRenderPanel() {
  const inner = qfPanelInner();
  if (!inner) return;

  const editing = _qfEditingId ? _qfList.find(f => f.id === _qfEditingId) : null;

  inner.innerHTML = `
    <div class="panel-scroll">
      <div class="panel-heading">⚡ Quick Filters</div>
      <p style="color:var(--text2);font-size:0.9rem;margin-bottom:20px;line-height:1.5;max-width:600px">
        Save a named group of domains, keywords, or URLs (e.g. "Social Media" → facebook.com, instagram.com, pinterest.com).
        Pick it from the dropdown next to the search box on the History page to instantly filter to just those entries.
      </p>
      <div class="ignore-add" style="flex-direction:column;align-items:stretch;gap:8px">
        <input type="text" id="qfNameInput" placeholder="Filter name (e.g. Social Media)" spellcheck="false" value="${editing ? esc(editing.name) : ''}">
        <textarea id="qfPatternsInput" placeholder="One domain, keyword, or URL per line — e.g.&#10;facebook.com&#10;instagram.com&#10;pinterest.com" rows="4" style="width:100%;resize:vertical;background:var(--surf3);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:0.85rem;padding:8px 10px;font-family:inherit">${editing ? esc((editing.patterns || []).join('\n')) : ''}</textarea>
        <div style="display:flex;gap:8px">
          <button id="qfSaveBtn" class="action-btn" style="background:var(--accent);color:#fff">${editing ? 'Save changes' : 'Add Filter'}</button>
          ${editing ? '<button id="qfCancelEditBtn" class="action-btn">Cancel</button>' : ''}
        </div>
      </div>
      <div id="qfList" class="ignore-list" style="margin-top:20px">
        ${_qfList.length ? '' : '<div class="empty-msg">No quick filters yet</div>'}
      </div>
    </div>`;

  const listEl = document.getElementById('qfList');
  for (const f of _qfList) {
    const item = document.createElement('div');
    item.className = 'ignore-item';
    item.style.alignItems = 'flex-start';

    const body = document.createElement('div');
    body.style.flex = '1';
    body.style.minWidth = '0';
    const nameEl = document.createElement('div');
    nameEl.style.fontWeight = '600';
    nameEl.style.fontSize = '0.85rem';
    nameEl.textContent = f.name;
    const patEl = document.createElement('div');
    patEl.style.color = 'var(--text2)';
    patEl.style.fontSize = '0.75rem';
    patEl.style.marginTop = '2px';
    patEl.textContent = (f.patterns || []).join(', ');
    body.appendChild(nameEl);
    body.appendChild(patEl);

    const editBtn = document.createElement('button');
    editBtn.className = 'ignore-remove-btn';
    editBtn.textContent = 'Edit';
    editBtn.style.marginRight = '6px';
    editBtn.onclick = () => { _qfEditingId = f.id; qfRenderPanel(); };

    const removeBtn = document.createElement('button');
    removeBtn.className = 'ignore-remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.onclick = async () => {
      if (!confirm(`Remove quick filter "${f.name}"?`)) return;
      try {
        await qfSend('REMOVE_QUICK_FILTER', { id: f.id });
        qfToast('Quick filter removed', 'ok');
        if (_qfActiveId === f.id) _qfActiveId = '';
        await qfLoadList();
        qfRenderPanel();
      } catch (err) { qfToast('Error: ' + err.message, 'err'); }
    };

    item.appendChild(body);
    item.appendChild(editBtn);
    item.appendChild(removeBtn);
    listEl.appendChild(item);
  }

  document.getElementById('qfSaveBtn')?.addEventListener('click', qfSaveFromForm);
  document.getElementById('qfCancelEditBtn')?.addEventListener('click', () => { _qfEditingId = null; qfRenderPanel(); });
}

async function qfSaveFromForm() {
  const nameInput = document.getElementById('qfNameInput');
  const patInput  = document.getElementById('qfPatternsInput');
  const name = (nameInput?.value || '').trim();
  const patterns = (patInput?.value || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  if (!name)          { qfToast('Please enter a filter name', 'err'); return; }
  if (!patterns.length) { qfToast('Please add at least one domain, keyword, or URL', 'err'); return; }

  try {
    if (_qfEditingId) {
      await qfSend('UPDATE_QUICK_FILTER', { id: _qfEditingId, name, patterns });
      qfToast('Quick filter updated', 'ok');
      _qfEditingId = null;
    } else {
      await qfSend('ADD_QUICK_FILTER', { name, patterns });
      qfToast(`Quick filter "${name}" added`, 'ok');
    }
    await qfLoadList();
    qfRenderPanel();
  } catch (err) {
    qfToast('Error: ' + err.message, 'err');
  }
}

function loadQuickFiltersPanel() {
  qfEditingIdReset();
  qfRenderPanel();
}
function qfEditingIdReset() { _qfEditingId = null; }

// ── Init ─────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initQuickFilters);
} else {
  initQuickFilters();
}

function initQuickFilters() {
  qfWireDropdown();
  qfLoadList(); // populate dropdown immediately so it's ready on the History page
}

window.QuickFilters = {
  loadPanel: loadQuickFiltersPanel,
  reload: qfLoadList,
};