/**
 * ignore-list.js - Ignore List UI functionality
 */

// Helper function for sending messages to background
function send(type, extra = {}) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type, ...extra }, r => {
      if (chrome.runtime.lastError) { rej(new Error(chrome.runtime.lastError.message)); return; }
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
    console.log(`[Toast] ${msg}`);
  }
}

// ══ LOAD IGNORE LIST ════════════════════════════════════════════════════════
async function loadIgnoreList() {
  console.log('[IgnoreList] Loading ignore list...');
  try {
    const { list } = await send('GET_IGNORE_LIST');
    console.log('[IgnoreList] Loaded patterns:', list);
    const container = document.getElementById('ignoreList');
    
    if (!container) {
      console.error('[IgnoreList] Container #ignoreList not found!');
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
      code.textContent = pattern;
      
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
    console.error('[IgnoreList] Load failed:', err);
    showToast('Error loading ignore list: ' + err.message, 'err');
  }
}

// ══ ADD IGNORE PATTERN ══════════════════════════════════════════════════════
async function addIgnorePattern() {
  const input = document.getElementById('ignorePatternInput');
  if (!input) {
    console.error('[IgnoreList] Input #ignorePatternInput not found!');
    return;
  }
  
  const pattern = input.value.trim();
  
  if (!pattern) {
    showToast('Please enter a pattern', 'err');
    return;
  }
  
  console.log('[IgnoreList] Adding pattern:', pattern);
  try {
    await send('ADD_IGNORE_PATTERN', { pattern });
    input.value = '';
    showToast(`Pattern added: ${pattern}`, 'ok');
    loadIgnoreList(); // Reload list
  } catch (err) {
    console.error('[IgnoreList] Add failed:', err);
    showToast('Error: ' + err.message, 'err');
  }
}

// ══ TOGGLE PATTERN GUIDE ════════════════════════════════════════════════════
function togglePatternGuide() {
  const guide = document.getElementById('patternGuide');
  const btn = document.getElementById('patternGuideToggle');
  
  if (!guide || !btn) {
    console.error('[IgnoreList] Pattern guide elements not found!');
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
  console.log('[IgnoreList] Opening panel...');
  const panel = document.getElementById('ignorePanel');
  if (!panel) {
    console.error('[IgnoreList] Panel #ignorePanel not found!');
    return;
  }
  
  loadIgnoreList(); // Load current patterns
  panel.style.display = 'block';
  console.log('[IgnoreList] Panel opened');
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
  console.log('[IgnoreList] Initializing event listeners...');
  
  // Add pattern button
  const addBtn = document.getElementById('addIgnoreBtn');
  if (addBtn) {
    addBtn.addEventListener('click', addIgnorePattern);
    console.log('[IgnoreList] Add button listener attached');
  } else {
    console.warn('[IgnoreList] Add button #addIgnoreBtn not found');
  }
  
  // Pattern guide toggle
  const guideToggle = document.getElementById('patternGuideToggle');
  if (guideToggle) {
    guideToggle.addEventListener('click', togglePatternGuide);
    console.log('[IgnoreList] Guide toggle listener attached');
  } else {
    console.warn('[IgnoreList] Guide toggle #patternGuideToggle not found');
  }
  
  // Enter key to add pattern
  const input = document.getElementById('ignorePatternInput');
  if (input) {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        addIgnorePattern();
      }
    });
    console.log('[IgnoreList] Input Enter key listener attached');
  } else {
    console.warn('[IgnoreList] Input #ignorePatternInput not found');
  }
  
  // Load patterns when the ignore list panel becomes visible
  const observer = new MutationObserver((mutations) => {
    const panel = document.getElementById('panel-ignorelist');
    if (panel && panel.classList.contains('active')) {
      console.log('[IgnoreList] Panel is now active, loading patterns...');
      loadIgnoreList();
    }
  });
  
  // Observe class changes on the ignorelist panel
  const ignorePanel = document.getElementById('panel-ignorelist');
  if (ignorePanel) {
    observer.observe(ignorePanel, { attributes: true, attributeFilter: ['class'] });
    console.log('[IgnoreList] Panel observer attached');
    
    // Also load immediately if panel is already active
    if (ignorePanel.classList.contains('active')) {
      loadIgnoreList();
    }
  }
  
  console.log('[IgnoreList] Initialization complete');
}

// Make functions available globally
window.IgnoreList = {
  load: loadIgnoreList,
  add: addIgnorePattern,
  toggleGuide: togglePatternGuide,
  open: openIgnorePanel,
  close: closeIgnorePanel
};