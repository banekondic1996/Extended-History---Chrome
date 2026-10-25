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


/**
 * EhExpr — "Expression mode" for the search box, switched on/off from the box's right-click menu.
 * Shared by history.html and popup.html (both load this file). The choice is remembered in localStorage.
 *   Every word is a WHOLE word: "cat" finds cat9, /cat/, #cat$ but not "catalog" or "bobcat" (only letters count as word characters).
 *   "*" opens a side:  cat* = starts with cat · *cat = ends with cat · *cat* = contains cat.
 *   EhExpr.on()                 → true while expression mode is on
 *   EhExpr.test(query, text)    → does `text` match every word of `query`?
 *   EhExpr.attach(input, cb)    → badge + right-click item for a search <input>; cb() runs when the mode changes
 * The search box gets its own right-click menu (Cut / Copy / Paste / Select all + the mode switch), drawn inside the page so it
 * also works in the small popup and the sidebar.
 */
(function () {
  'use strict';
  var KEY = 'eh_expr_mode';
  var state = false;
  try { state = localStorage.getItem(KEY) === '1'; } catch (_) {}
  var inputs = [], listeners = [];
  function T(key, fb) { try { var v = (typeof window.tr === 'function') ? window.tr(key, fb) : fb; return typeof v === 'string' && v ? v : fb; } catch (_) { return fb; } }
  function refresh(rec) {
    rec.badge.style.display = state ? '' : 'none';
    rec.input.title = state ? T('expr_on_tip', 'Expression mode is on — right-click to turn it off') : '';
  }
  function apply(v, notify) {
    if (state === !!v) return;
    state = !!v;
    inputs.forEach(refresh);
    if (notify) listeners.forEach(function (f) { try { f(); } catch (_) {} });
  }
  function set(v) {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (_) {}
    apply(v, true);
  }
  // changed from another page of the extension
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(e.newValue === '1', true); });

  var termCache = {};
  function terms(q) {
    var t = termCache[q];
    if (!t) {
      var L = '\\p{L}'; t = [];
      String(q).split(/\s+/).filter(Boolean).forEach(function (term) {
        var p = term, openL = false, openR = false;
        if (p.charAt(0) === '*') { openL = true; p = p.replace(/^\*+/, ''); }
        if (p.charAt(p.length - 1) === '*') { openR = true; p = p.replace(/\*+$/, ''); }
        if (!p) return;
        var esc = p.split('*').map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('.*');
        var left = (!openL && /^\p{L}/u.test(p)) ? '(?<!' + L + ')' : '';
        var right = (!openR && /\p{L}$/u.test(p)) ? '(?!' + L + ')' : '';
        t.push(new RegExp(left + esc + right, 'iu'));
      });
      termCache = {}; termCache[q] = t;
    }
    return t;
  }
  function test(q, text) { return terms(q).every(function (r) { return r.test(text); }); }

  // ── custom right-click menu ────────────────────────────────────────────────────────────────────────
  var menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } document.removeEventListener('mousedown', onDocDown, true); document.removeEventListener('keydown', onDocKey, true); }
  function onDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function onDocKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }
  function pasteInto(input) {
    input.focus();
    var done = function (txt) {
      if (txt == null) return;
      var a = input.selectionStart, b = input.selectionEnd;
      input.setRangeText(txt, a, b, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    var fallback = function () { try { if (!document.execCommand('paste')) throw 0; } catch (_) {} };
    try { navigator.clipboard.readText().then(done, fallback); } catch (_) { fallback(); }
  }
  function openMenu(input, x, y) {
    closeMenu();
    var m = document.createElement('div');
    m.setAttribute('role', 'menu');
    m.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;min-width:170px;max-width:96vw;padding:4px;border-radius:8px;' +
      'background:var(--bg2,var(--surface,#2a2a2e));color:var(--text,#eee);border:1px solid var(--border,rgba(128,128,128,.4));' +
      'box-shadow:0 6px 24px rgba(0,0,0,.45);font:13px system-ui,sans-serif;user-select:none';
    var hasSel = input.selectionStart !== input.selectionEnd;
    function item(label, enabled, fn, hint) {
      var d = document.createElement('div');
      d.setAttribute('role', 'menuitem');
      d.style.cssText = 'display:flex;justify-content:space-between;gap:18px;padding:6px 10px;border-radius:5px;cursor:' + (enabled ? 'pointer' : 'default') + ';opacity:' + (enabled ? 1 : .4);
      var l = document.createElement('span'); l.textContent = label; d.appendChild(l);
      if (hint) { var h = document.createElement('span'); h.textContent = hint; h.style.opacity = '.55'; d.appendChild(h); }
      if (enabled) {
        d.addEventListener('mouseenter', function () { d.style.background = 'rgba(128,128,128,.25)'; });
        d.addEventListener('mouseleave', function () { d.style.background = ''; });
        d.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the focus/selection in the input
        d.addEventListener('click', function () { closeMenu(); fn(); });
      }
      m.appendChild(d);
    }
    item(T('ctx_cut', 'Cut'), hasSel, function () { input.focus(); try { document.execCommand('cut'); } catch (_) {} }, 'Ctrl+X');
    item(T('ctx_copy', 'Copy'), hasSel, function () { input.focus(); try { document.execCommand('copy'); } catch (_) {} }, 'Ctrl+C');
    item(T('ctx_paste', 'Paste'), true, function () { pasteInto(input); }, 'Ctrl+V');
    item(T('ctx_select_all', 'Select all'), !!input.value, function () { input.focus(); input.select(); }, 'Ctrl+A');
    var sep = document.createElement('div'); sep.style.cssText = 'height:1px;margin:4px 2px;background:var(--border,rgba(128,128,128,.4))'; m.appendChild(sep);
    item((state ? '✓ ' : '') + T('expr_mode', 'Expression mode') + '  (cat*  *cat*)', true, function () { set(!state); input.focus(); });
    document.documentElement.appendChild(m);
    var r = m.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    m.style.left = Math.max(2, Math.min(x, vw - r.width - 2)) + 'px';
    m.style.top = Math.max(2, Math.min(y, vh - r.height - 2)) + 'px';
    menuEl = m;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }

  function attach(input, onChange) {
    if (!input || inputs.some(function (r) { return r.input === input; })) return;
    var host = input.parentElement;
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var badge = document.createElement('span');
    badge.textContent = '*';
    badge.title = T('expr_on_tip', 'Expression mode is on — right-click to turn it off');
    badge.style.cssText = 'position:absolute;right:34px;top:50%;transform:translateY(-50%);padding:1px 7px;border-radius:5px;font:700 12px ui-monospace,Consolas,monospace;' +
      'color:var(--accent,#3b9eff);border:1px solid var(--accent,#3b9eff);pointer-events:none;display:none;line-height:1.5';
    if (host) host.appendChild(badge);
    var rec = { input: input, badge: badge };
    inputs.push(rec);
    if (onChange) listeners.push(onChange);
    refresh(rec);
    input.addEventListener('contextmenu', function (e) { e.preventDefault(); openMenu(input, e.clientX, e.clientY); });
    // Fallback shortcut inside the search box
    input.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); set(!state); }
    });
  }
  window.EhExpr = { on: function () { return state; }, set: set, test: test, attach: attach };
})();
