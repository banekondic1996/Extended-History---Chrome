/**
 * ignore-list.js - Ignore List UI functionality with enable/disable toggle
 */

// NOTE: uses the global send() already defined by history.js (loaded first on
// this page). A local redeclaration here used to silently shadow it — classic
// <script> tags all share one global scope, so the last-loaded function with
// the same name wins for every caller on the page, including history.js's own
// code. That meant history.js's timeout safeguard on send() was never actually
// active. Don't redefine send() here.

// Toast helper (assumes toast function exists in main file)
function showToast(msg, type = 'ok') {
  if (typeof toast === 'function') {
    toast(msg, type);
  } else {
    //console.log(`[Toast] ${msg}`);
  }
}

// ══ CLEANUP PROGRESS BUBBLE ═════════════════════════════════════════════════
// Purging ignored URLs from a large history can take a while, and history
// won't load correctly while it's mid-purge. This floating bubble makes that
// visible for as long as the cleanup is actually running — including if the
// panel/page gets closed and reopened mid-cleanup — on top of the matching
// badge background.js puts on the toolbar icon.
let _cleanupBubbleEl = null;

function _ensureCleanupBubble() {
  if (_cleanupBubbleEl) return _cleanupBubbleEl;
  const el = document.createElement('div');
  el.id = 'ehCleanupBubble';
  el.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:9999;' +
    'background:var(--surf2,#222);color:var(--text,#eee);border:1px solid var(--border,#444);' +
    'border-radius:20px;padding:8px 16px;font-size:0.8rem;font-weight:600;' +
    'box-shadow:0 4px 14px rgba(0,0,0,0.35);display:flex;align-items:center;gap:8px;' +
    'pointer-events:none;opacity:0;transition:opacity 0.15s';
  el.innerHTML = '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;' +
    'background:#e0a030;animation:ehCleanupPulse 1s ease-in-out infinite"></span>' +
    '<span id="ehCleanupBubbleText">Cleaning ignored URLs…</span>';
  if (!document.getElementById('ehCleanupPulseStyle')) {
    const style = document.createElement('style');
    style.id = 'ehCleanupPulseStyle';
    style.textContent = '@keyframes ehCleanupPulse{0%,100%{opacity:1}50%{opacity:0.35}}';
    document.head.appendChild(style);
  }
  document.body.appendChild(el);
  _cleanupBubbleEl = el;
  return el;
}

function updateCleanupBubble(active, done, total) {
  const el = _ensureCleanupBubble();
  if (!active) {
    el.style.opacity = '0';
    return;
  }
  const textEl = document.getElementById('ehCleanupBubbleText');
  if (textEl) {
    textEl.textContent = total
      ? `${tr('toast_cleaning', 'Cleaning ignored URLs from history…')} ${done}/${total}`
      : tr('toast_cleaning', 'Cleaning ignored URLs from history…');
  }
  el.style.opacity = '1';
}

// Listen for progress broadcasts from background.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'CLEANUP_PROGRESS') {
    updateCleanupBubble(msg.active, msg.done, msg.total);
  }
});

// In case this page/panel was opened (or reopened) while a cleanup started
// elsewhere is still running, sync the bubble to current state right away.
async function syncCleanupBubbleOnLoad() {
  try {
    const status = await send('GET_CLEANUP_STATUS');
    if (status && status.active) updateCleanupBubble(true, status.done, status.total);
  } catch {}
}

// ══ LOAD IGNORE LIST ════════════════════════════════════════════════════════
async function loadIgnoreList() {
  //console.log('[IgnoreList] Loading ignore list...');
  try {
    const { list, enabled, hideInTimeSpent } = await send('GET_IGNORE_LIST');
    //console.log('[IgnoreList] Loaded patterns:', list, 'Enabled:', enabled);
    
    // Update toggle state
    const toggle = document.getElementById('ignoreListToggle');
    if (toggle) {
      toggle.checked = enabled !== false; // Default to true if not set
    }
    const tsToggle = document.getElementById('hideTimeSpentToggle');
    if (tsToggle) {
      tsToggle.checked = hideInTimeSpent === true; // Default to false (opt-in)
    }
    
    const container = document.getElementById('ignoreList');
    
    if (!container) {
      //console.error('[IgnoreList] Container #ignoreList not found!');
      return;
    }
    
    if (!list || !list.length) {
      container.innerHTML = '<div class="empty-msg">' + tr('no_patterns_added', 'No patterns added yet') + '</div>';
      return;
    }
    
    container.innerHTML = '';
    for (const pattern of list) {
      const item = document.createElement('div');
      item.className = 'ignore-item';
      
      const code = document.createElement('code');
      // Display kw: patterns as readable keyword labels
      if (pattern.startsWith('kw:')) {
        code.textContent = tr('keyword_prefix', 'keyword: {0}', pattern.slice(3));
        code.title = 'Keyword pattern — matches any URL or page title containing "' + pattern.slice(3) + '"';
      } else {
        code.textContent = pattern;
      }
      
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ignore-remove-btn';
      removeBtn.textContent = tr('remove', 'Remove');
      removeBtn.onclick = async () => {
        if (!confirm(`Remove pattern: ${pattern}?`)) return;
        try {
          await send('REMOVE_IGNORE_PATTERN', { pattern });
          showToast(tr('toast_pattern_removed', 'Pattern removed'), 'ok');
          loadIgnoreList(); // Reload list
        } catch (err) {
          showToast('Error: ' + err.message, 'err');
        }
      };
      
      item.appendChild(code);
      item.appendChild(removeBtn);
      container.appendChild(item);
    }
  } catch (err) {
    //console.error('[IgnoreList] Load failed:', err);
    showToast('Error loading ignore list: ' + err.message, 'err');
  }
}

// ══ ADD IGNORE PATTERN ══════════════════════════════════════════════════════
async function addIgnorePattern() {
  const input = document.getElementById('ignorePatternInput');
  if (!input) {
    //console.error('[IgnoreList] Input #ignorePatternInput not found!');
    return;
  }
  
  const pattern = input.value.trim();
  
  if (!pattern) {
    showToast(tr('toast_enter_pattern', 'Please enter a pattern'), 'err');
    return;
  }
  
  //console.log('[IgnoreList] Adding pattern:', pattern);
  try {
    await send('ADD_IGNORE_PATTERN', { pattern });
    input.value = '';
    showToast(tr('toast_pattern_added', 'Pattern added: {0}', pattern), 'ok');
    loadIgnoreList(); // Reload list
  } catch (err) {
    //console.error('[IgnoreList] Add failed:', err);
    showToast('Error: ' + err.message, 'err');
  }
}

// ══ TOGGLE IGNORE LIST ══════════════════════════════════════════════════════
async function toggleIgnoreList() {
  const toggle = document.getElementById('ignoreListToggle');
  if (!toggle) {
    //console.error('[IgnoreList] Toggle #ignoreListToggle not found!');
    return;
  }
  
  const enabled = toggle.checked;
  //console.log('[IgnoreList] Toggling ignore list to:', enabled);
  
  try {
    const result = await send('TOGGLE_IGNORE_LIST');
    showToast(result.enabled ? tr('toast_ignore_enabled', 'Ignore list enabled') : tr('toast_ignore_disabled', 'Ignore list disabled'), 'ok');
    
    // If just enabled, clean history immediately
    if (result.enabled) {
      showToast(tr('toast_cleaning', 'Cleaning ignored URLs from history…'), 'ok');
      // The toast above fades on its own; the bubble (driven by CLEANUP_PROGRESS
      // broadcasts from background.js) stays visible for the whole operation,
      // including if this panel gets closed and reopened before it finishes.
      const cleanResult = await send('CLEAN_IGNORED_HISTORY');
      const count = cleanResult.removed || 0;
      if (count > 0) {
        showToast(tr('toast_removed_ignored', 'Removed {0} ignored URLs from history', count), 'ok');
      } else {
        showToast(tr('toast_no_ignored', 'No ignored URLs found in history'), 'ok');
      }
    }
  } catch (err) {
    //console.error('[IgnoreList] Toggle failed:', err);
    showToast('Error: ' + err.message, 'err');
    // Revert toggle state on error
    toggle.checked = !enabled;
  }
}

// ══ TOGGLE HIDE-FROM-TIME-SPENT ═════════════════════════════════════════════
// Display-only: hides domains matching the patterns above from the Time
// Spent view. Never deletes or touches the underlying tracked time data —
// turning this off instantly brings hidden domains back with their full
// history intact.
async function toggleHideTimeSpent() {
  const toggle = document.getElementById('hideTimeSpentToggle');
  if (!toggle) return;

  const enabled = toggle.checked;
  try {
    const result = await send('TOGGLE_HIDE_IGNORED_TIMESPENT');
    showToast(result.enabled
      ? tr('toast_ts_hidden', 'Ignored domains are now hidden from Time Spent')
      : tr('toast_ts_shown', 'Ignored domains are no longer hidden from Time Spent'), 'ok');
  } catch (err) {
    showToast('Error: ' + err.message, 'err');
    toggle.checked = !enabled; // revert on error
  }
}

// ══ TOGGLE PATTERN GUIDE ════════════════════════════════════════════════════
function togglePatternGuide() {
  const guide = document.getElementById('patternGuide');
  const btn = document.getElementById('patternGuideToggle');
  if (!guide || !btn) {
    return;
  }
  if (guide.style.display === 'none') {
    guide.style.display = 'block';
    btn.textContent = '▲ ' + tr('url_pattern_guide', 'URL Pattern Guide');
  } else {
    guide.style.display = 'none';
    btn.textContent = '▼ ' + tr('url_pattern_guide', 'URL Pattern Guide');
  }
}

// ══ OPEN IGNORE PANEL ═══════════════════════════════════════════════════════
function openIgnorePanel() {
  //console.log('[IgnoreList] Opening panel...');
  const panel = document.getElementById('ignorePanel');
  if (!panel) {
    return;
  }
  loadIgnoreList(); // Load current patterns
  panel.style.display = 'block';
  //console.log('[IgnoreList] Panel opened');
}

// ══ CLOSE IGNORE PANEL ══════════════════════════════════════════════════════
function closeIgnorePanel() {
  const panel = document.getElementById('ignorePanel');
  if (panel) {
    panel.style.display = 'none';
  }
}

// ══ EVENT LISTENERS ═════════════════════════════════════════════════════════
// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initIgnoreList);
} else {
  initIgnoreList();
}

function initIgnoreList() {
  //console.log('[IgnoreList] Initializing event listeners...');

  syncCleanupBubbleOnLoad();
  
  // Add pattern button
  const addBtn = document.getElementById('addIgnoreBtn');
  if (addBtn) {
    addBtn.addEventListener('click', addIgnorePattern);
  } else {
    // elements injected post-auth — not an error
  }
  
  // Toggle switch
  const toggle = document.getElementById('ignoreListToggle');
  if (toggle) {
    toggle.addEventListener('change', toggleIgnoreList);
    //console.log('[IgnoreList] Toggle switch listener attached');
  } else {
    // elements injected post-auth — not an error
  }

  // Hide-from-Time-Spent toggle
  const tsToggle = document.getElementById('hideTimeSpentToggle');
  if (tsToggle) {
    tsToggle.addEventListener('change', toggleHideTimeSpent);
  } else {
    // elements injected post-auth — not an error
  }
  
  // Pattern guide toggle
  const guideToggle = document.getElementById('patternGuideToggle');
  if (guideToggle) {
    guideToggle.addEventListener('click', togglePatternGuide);
  } else {
    // elements injected post-auth — not an error
  }
  
  // Enter key to add pattern
  const input = document.getElementById('ignorePatternInput');
  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        addIgnorePattern();
      }
    });
    //console.log('[IgnoreList] Input Enter key listener attached');
  } else {
    // elements injected post-auth — not an error
  }
  
  // Load patterns when the ignore list panel becomes visible
  const observer = new MutationObserver((mutations) => {
    const panel = document.getElementById('panel-ignorelist');
    if (panel && panel.classList.contains('active')) {
      //console.log('[IgnoreList] Panel is now active, loading patterns...');
      loadIgnoreList();
    }
  });
  
  // Observe class changes on the ignorelist panel
  const ignorePanel = document.getElementById('panel-ignorelist');
  if (ignorePanel) {
    observer.observe(ignorePanel, { attributes: true, attributeFilter: ['class'] });
    //console.log('[IgnoreList] Panel observer attached');
    
    // Also load immediately if panel is already active
    if (ignorePanel.classList.contains('active')) {
      loadIgnoreList();
    }
  }
  
  //console.log('[IgnoreList] Initialization complete');
}

// Make functions available globally
window.IgnoreList = {
  load: loadIgnoreList,
  add: addIgnorePattern,
  toggle: toggleIgnoreList,
  toggleTimeSpent: toggleHideTimeSpent,
  toggleGuide: togglePatternGuide,
  open: openIgnorePanel,
  close: closeIgnorePanel
};