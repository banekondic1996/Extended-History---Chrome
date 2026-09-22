/**
 * i18n-core.js - message lookup for the whole UI. Loaded FIRST (before history.js).
 * https://developer.chrome.com/docs/extensions/reference/api/i18n
 *
 * Default: plain chrome.i18n.getMessage() - synchronous, follows the browser UI
 * language (preferred locale -> locale without region -> default_locale).
 *
 * chrome.i18n has no way to ask for a *different* language than the browser's,
 * so the Language menu in Settings works by reading the chosen locale's
 * messages.json itself, synchronously (no async step => still no flash of
 * English) and answering _ehMsg() from it. Keys that language lacks fall back
 * to English (the default_locale). "auto" = don't override: use chrome.i18n.
 *
 * The choice is kept in localStorage so it is readable synchronously at load.
 */
(function () {
  var LANG_KEY = 'eh_ui_lang';
  var code = 'auto', override = null, english = null;

  function readBundle(c) {            // synchronous read of a bundled locale file
    try {
      var x = new XMLHttpRequest();
      x.open('GET', chrome.runtime.getURL('_locales/' + c + '/messages.json'), false);
      x.send();
      if (x.status === 200 || x.status === 0) return JSON.parse(x.responseText);
    } catch (e) {}
    return null;
  }

  try { code = localStorage.getItem(LANG_KEY) || 'auto'; } catch (e) {}
  if (code !== 'auto') {
    override = readBundle(code);
    if (override) english = (code === 'en') ? override : readBundle('en');
    else code = 'auto';               // unreadable/unknown locale: fall back to the browser language
  }

  // Same rules as chrome.i18n: $name$ -> placeholder content, $1..$9 -> substitutions, $$ -> $
  function format(entry, subs) {
    var ph = {};
    Object.keys(entry.placeholders || {}).forEach(function (k) { ph[k.toLowerCase()] = entry.placeholders[k].content; });
    return entry.message
      .replace(/\$([A-Za-z0-9_@]+)\$/g, function (_, n) { var c = ph[n.toLowerCase()]; return c === undefined ? '' : c; })
      .replace(/\$([1-9])/g, function (_, i) { return (subs && subs[i - 1] !== undefined) ? subs[i - 1] : ''; })
      .replace(/\$\$/g, '$');
  }

  // Drop-in replacement for chrome.i18n.getMessage(): returns '' for unknown keys.
  window._ehMsg = function (key, subs) {
    if (subs !== undefined && !Array.isArray(subs)) subs = [subs];
    if (override) {
      var e = override[key] || (english && english[key]);
      return e ? format(e, subs) : '';
    }
    return chrome.i18n.getMessage(key, subs) || '';
  };

  // Code of the language in use, for Intl date formatting ("ru", "zh_CN", "en-US"...)
  window._ehUiLangChoice = code;
  window._currentLang = override ? code : chrome.i18n.getUILanguage();

  // Month / weekday names in the language in use. Intl covers everything Chrome
  // supports; Latin has no Intl data, so it is spelled out.
  var LA_MONTHS = ['Ianuarius','Februarius','Martius','Aprilis','Maius','Iunius','Iulius','Augustus','September','October','November','December'];
  var LA_DAYS = ['D','L','M','M','I','V','S'];
  function intlLocale() {
    var l = String(window._currentLang || 'en').replace('_', '-');
    return l.toLowerCase() === 'no' ? 'nb' : l;
  }
  window._ehMonthNames = function () {
    if (String(window._currentLang) === 'la') return LA_MONTHS.slice();
    try {
      var f = new Intl.DateTimeFormat(intlLocale(), { month: 'long' }), out = [];
      for (var i = 0; i < 12; i++) { var n = f.format(new Date(2021, i, 1)); out.push(n.charAt(0).toUpperCase() + n.slice(1)); }
      return out;
    } catch (e) { return ['January','February','March','April','May','June','July','August','September','October','November','December']; }
  };
  window._ehWeekdayInitials = function () {   // Sunday first
    if (String(window._currentLang) === 'la') return LA_DAYS.slice();
    try {
      var f = new Intl.DateTimeFormat(intlLocale(), { weekday: 'narrow' }), out = [];
      for (var i = 0; i < 7; i++) out.push(f.format(new Date(2021, 7, 1 + i)));  // 1 Aug 2021 = Sunday
      return out;
    } catch (e) { return ['S','M','T','W','T','F','S']; }
  };

  // Strings built in JavaScript (toasts, confirms...). Extra arguments become the
  // message's substitutions; if the key is missing the English fallback is used
  // with {0}, {1} filled in.
  window.tr = function (key, fallback, /* ...subs */) {
    var subs = Array.prototype.slice.call(arguments, 2).map(String);
    var text = window._ehMsg(key, subs);
    if (text) return text;
    return (fallback || '').replace(/\{(\d+)\}/g, function (_, i) { return subs[i] !== undefined ? subs[i] : ''; });
  };
})();
