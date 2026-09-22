/**
 * ui-translate.js - applies translations to the page (uses i18n-core.js).
 * https://developer.chrome.com/docs/extensions/reference/api/i18n
 *
 * Lookups are synchronous (see i18n-core.js), so there is no fetch, cache or
 * async step: this file is loaded at the end of <body>, so the static markup is
 * translated before the first paint.
 *
 * Markup conventions:
 *   data-i18n-key=NAME       replaces the element's text
 *   data-i18n-title=NAME     replaces the title attribute
 *   data-i18n-ph=NAME        replaces the placeholder attribute
 *
 * Call applyTranslations() again after injecting new markup (safe to repeat).
 */

// Message lookup lives in i18n-core.js (chrome.i18n, plus the optional Language
// menu override). '' for a missing key, so the English text already in the DOM
// is kept.
function _msg(key) { return window._ehMsg(key) || ''; }

function applyTranslations() {
  // 1. Text of every [data-i18n-key] element (static HTML and injected panels)
  document.querySelectorAll('[data-i18n-key]').forEach(el => {
    const text = _msg(el.getAttribute('data-i18n-key'));
    if (!text) return;
    // Preserve any icon child element inside the label
    const icon = el.querySelector('.ni-icon');
    el.textContent = '';
    if (icon) el.appendChild(icon);
    el.appendChild(document.createTextNode(text));
  });

  // 2. Attributes
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const text = _msg(el.getAttribute('data-i18n-ph'));
    if (text) el.placeholder = text;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const text = _msg(el.getAttribute('data-i18n-title'));
    if (text) el.title = text;
  });

  // 3. Placeholders that are addressed by id
  [
    { id: 'searchInput',        key: 'ph_search_history'   },
    { id: 'bmSearch',           key: 'ph_search_bookmarks' },
    { id: 'ignorePatternInput', key: 'ph_ignore_pattern'   },
    { id: 'rmSearchInput',      key: 'ph_search_history'   },
    { id: 'deviceSearchInput',  key: 'ph_search_devices'   },
  ].forEach(({ id, key }) => {
    const el = document.getElementById(id);
    const text = _msg(key);
    if (el && text) el.placeholder = text;
  });

  // 4. Search-mode selects (main + reading mode)
  const modeOpts = [
    { value: 'all',    key: 'opt_all_fields' },
    { value: 'title',  key: 'opt_title'      },
    { value: 'url',    key: 'opt_url'        },
    { value: 'domain', key: 'opt_domain'     },
  ];
  ['searchMode', 'rmSearchMode'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    modeOpts.forEach(({ value, key }) => {
      const opt = sel.querySelector(`option[value="${value}"]`);
      const text = _msg(key);
      if (opt && text) opt.textContent = text;
    });
  });
}

window.applyTranslations = applyTranslations;

applyTranslations();
