/**
 * ui-translate.js - Apply translations to the UI using _locale/messages.json
 *
 * Supports translating:
 *   - All [data-i18n-key] elements (including those injected after page load)
 *   - Named input placeholders
 *   - Both #searchMode and #rmSearchMode option lists
 *   - Dynamically injected content (ignore list, sessions, etc.)
 *
 * Call applyTranslations(lang) at any point — it is safe to call multiple times.
 * The function caches the loaded messages object so repeated calls within the
 * same language are fast (no extra fetch).
 */

// Cache: lang → messages object
const _i18nCache = {};

async function applyTranslations(lang = 'en') {
  try {
    // Use cached messages when available
    let messages = _i18nCache[lang];
    if (!messages) {
      const response = await fetch(`_locales/${lang}/messages.json`);
      if (!response.ok) throw new Error(`Locale file not found: ${lang}`);
      messages = await response.json();
      _i18nCache[lang] = messages;
    }

    // Helper: get translation safely
    const t = (key, fallback = '') => (messages[key] && messages[key].message) || fallback;

    // ── 1. Translate every [data-i18n-key] element in the document ──────────
    // Scanning the full document every time covers both static HTML and
    // any content injected after DOMContentLoaded (ignore list panel, etc.)
    document.querySelectorAll('[data-i18n-key]').forEach(el => {
      const key = el.getAttribute('data-i18n-key');
      const translation = t(key, el.textContent.trim());
      if (!translation) return;

      // Preserve any icon child elements inside the label
      const icon = el.querySelector('.ni-icon');
      el.textContent = '';
      if (icon) el.appendChild(icon);
      el.appendChild(document.createTextNode(translation));
    });

    // ── 2. Translate input / textarea placeholders ───────────────────────────
    const placeholders = [
      { id: 'searchInput',        key: 'ph_search_history'   },
      { id: 'bmSearch',           key: 'ph_search_bookmarks' },
      { id: 'ignorePatternInput', key: 'ph_ignore_pattern'   },
      { id: 'rmSearchInput',      key: 'ph_search_history'   },
    ];
    placeholders.forEach(({ id, key }) => {
      const el = document.getElementById(id);
      if (el) el.placeholder = t(key, el.placeholder);
    });

    // ── 3. Translate search mode selects (main + reading mode) ───────────────
    const searchModeOpts = [
      { value: 'all',    key: 'opt_all_fields' },
      { value: 'title',  key: 'opt_title'      },
      { value: 'url',    key: 'opt_url'        },
      { value: 'domain', key: 'opt_domain'     },
    ];
    ['searchMode', 'rmSearchMode'].forEach(selId => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      searchModeOpts.forEach(({ value, key }) => {
        const opt = sel.querySelector(`option[value="${value}"]`);
        if (opt) opt.textContent = t(key, opt.textContent);
      });
    });

  } catch (err) {
    // Silent fail — UI falls back to English text already in the DOM
  }
}

// Make available globally
window.applyTranslations = applyTranslations;