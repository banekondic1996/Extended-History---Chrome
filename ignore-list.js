/**
 * ignore-list.js - Ignore List UI functionality with enable/disable toggle
 */

// Helper function for sending messages to background
function send(type, extra = {}) {
  return new Promise((res, rej) => {
    browser.runtime.sendMessage({ type, ...extra }, r => {
      if (browser.runtime.lastError) { rej(new Error(browser.runtime.lastError.message)); return; }
      if (r && r.error) { rej(new Error(r.error)); return; }
      res(r);
    });
  });
}

// Toast helper (assumes toast function exists in main file)
function showToast(msg, type = 'ok') {
  if (typeof toast === 'function') {
    toast(msg, type);
  } else {
    //console.log(`[Toast] ${msg}`);
  }
}

// ══ LOAD IGNORE LIST ════════════════════════════════════════════════════════
async function loadIgnoreList() {
  //console.log('[IgnoreList] Loading ignore list...');
  try {
    const { list, enabled } = await send('GET_IGNORE_LIST');
    //console.log('[IgnoreList] Loaded patterns:', list, 'Enabled:', enabled);
    
    // Update toggle state
    const toggle = document.getElementById('ignoreListToggle');
    if (toggle) {
      toggle.checked = enabled !== false; // Default to true if not set
    }
    
    const container = document.getElementById('ignoreList');
    
    if (!container) {
      //console.error('[IgnoreList] Container #ignoreList not found!');
      return;
    }
    
    if (!list || !list.length) {
      container.innerHTML = '<div class="empty-msg">No patterns added yet</div>';
      return;
    }
    
    container.innerHTML = '';
    for (const pattern of list) {
      const item = document.createElement('div');
      item.className = 'ignore-item';
      
      const code = document.createElement('code');
      // Display kw: patterns as readable keyword labels
      if (pattern.startsWith('kw:')) {
        code.textContent = 'keyword: ' + pattern.slice(3);
        code.title = 'Keyword pattern — matches any URL or page title containing "' + pattern.slice(3) + '"';
      } else {
        code.textContent = pattern;
      }
      
      const removeBtn = document.createElement('button');
      removeBtn.className = 'ignore-remove-btn';
      removeBtn.textContent = 'Remove';
      removeBtn.onclick = async () => {
        if (!confirm(`Remove pattern: ${pattern}?`)) return;
        try {
          await send('REMOVE_IGNORE_PATTERN', { pattern });
          showToast('Pattern removed', 'ok');
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
    showToast('Please enter a pattern', 'err');
    return;
  }
  
  //console.log('[IgnoreList] Adding pattern:', pattern);
  try {
    await send('ADD_IGNORE_PATTERN', { pattern });
    input.value = '';
    showToast(`Pattern added: ${pattern}`, 'ok');
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
    const statusText = result.enabled ? 'enabled' : 'disabled';
    showToast(`Ignore list ${statusText}`, 'ok');
    
    // If just enabled, clean history immediately
    if (result.enabled) {
      showToast('Cleaning ignored URLs from history...', 'ok');
      const cleanResult = await send('CLEAN_IGNORED_HISTORY');
      const count = cleanResult.removed || 0;
      if (count > 0) {
        showToast(`Removed ${count} ignored URL${count === 1 ? '' : 's'} from history`, 'ok');
      } else {
        showToast('No ignored URLs found in history', 'ok');
      }
    }
  } catch (err) {
    //console.error('[IgnoreList] Toggle failed:', err);
    showToast('Error: ' + err.message, 'err');
    // Revert toggle state on error
    toggle.checked = !enabled;
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
    btn.textContent = '▲ URL Pattern Guide';
  } else {
    guide.style.display = 'none';
    btn.textContent = '▼ URL Pattern Guide';
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
  toggleGuide: togglePatternGuide,
  open: openIgnorePanel,
  close: closeIgnorePanel
};