/**
 * ui-translate.js - Apply translations to the UI using _locale/messages.json
 */

async function applyTranslations(lang = 'en') {
  try {
    // Load the locale JSON dynamically
    const response = await fetch(`_locales/${lang}/messages.json`);
    if (!response.ok) throw new Error(`Locale file not found: ${lang}`);
    const messages = await response.json();

    // Helper: get translation safely
    const t = (key, fallback = '') => (messages[key] && messages[key].message) || fallback;

    //console.log('[Translate] Applying translations for:', lang);

    // Translate elements with data-i18n-key
    document.querySelectorAll('[data-i18n-key]').forEach(el => {
      const key = el.getAttribute('data-i18n-key');
      const translation = t(key, el.textContent.trim());
      
      // Preserve icons if present
      const icon = el.querySelector('.ni-icon');
      el.textContent = '';
      if (icon) el.appendChild(icon);
      el.appendChild(document.createTextNode(translation));
    });

    // Translate placeholders
    const placeholders = [
      { id: 'searchInput', key: 'ph_search_history' },
      { id: 'bmSearch', key: 'ph_search_bookmarks' },
      { id: 'ignorePatternInput', key: 'ph_ignore_pattern' },
    ];
    placeholders.forEach(({ id, key }) => {
      const el = document.getElementById(id);
      if (el) el.placeholder = t(key, el.placeholder);
    });

    // Translate search mode select options
    const searchMode = document.getElementById('searchMode');
    if (searchMode) {
      const options = [
        { value: 'all', key: 'opt_all_fields' },
        { value: 'title', key: 'opt_title' },
        { value: 'url', key: 'opt_url' },
        { value: 'domain', key: 'opt_domain' },
      ];
      options.forEach(({ value, key }) => {
        const opt = searchMode.querySelector(`option[value="${value}"]`);
        if (opt) opt.textContent = t(key, opt.textContent);
      });
    }

    //console.log('[Translate] UI translation complete for:', lang);

  } catch (err) {
    //console.error('[Translate] Failed to load translations:', err);
  }
}

// Make available globally
window.applyTranslations = applyTranslations;