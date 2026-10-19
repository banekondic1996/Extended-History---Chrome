/**
 * theme-init.js — applies the saved theme BEFORE the first paint.
 * Load it as a plain (blocking) <script> in <head> of history.html and popup.html,
 * right after the stylesheet link / before <body>. (MV3 CSP forbids inline scripts,
 * so this has to be a file.)
 *
 * The real settings live in browser.storage.local, which is async. Waiting for it meant
 * the page painted with the hard-coded data-theme="dark" first and then switched to
 * light, and every `transition: all` button animated through the dark colours (the flash).
 * localStorage is synchronous and shared by this extension's pages, so the last-known
 * choice is mirrored there ("eh_theme_pref") and read here instead.
 *
 * Exposes window.EhTheme:
 *   EhTheme.state                 {follow:boolean, theme:'light'|'dark'}  (what is applied now)
 *   EhTheme.effective()           'light' | 'dark'  (system theme when follow is on)
 *   EhTheme.apply()               writes data-theme / data-follow-theme on <html>
 *   EhTheme.set(follow, theme, persist)   update state; persist=true mirrors it to localStorage
 * Fires a `eh-theme-changed` event on window whenever the effective theme changes
 * (including when the OS switches between light and dark while "follow system" is on).
 */
(function () {
    'use strict';
    var KEY = 'eh_theme_pref';
    var mq = null;
    try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) {}

    var state = { follow: false, theme: 'dark' };
    try {
        var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (saved) {
            state.follow = saved.follow === true;
            state.theme  = saved.theme === 'light' ? 'light' : 'dark';
        }
    } catch (e) {}

    function systemTheme() { return mq && mq.matches ? 'dark' : 'light'; }
    function effective()   { return state.follow ? systemTheme() : state.theme; }

    function apply() {
        var root = document.documentElement, t = effective();
        var changed = root.getAttribute('data-theme') !== t;
        root.setAttribute('data-theme', t);
        root.setAttribute('data-follow-theme', state.follow ? 'true' : 'false');
        return changed;
    }
    function notify() {
        try { window.dispatchEvent(new CustomEvent('eh-theme-changed', { detail: { theme: effective(), follow: state.follow } })); } catch (e) {}
    }

    function set(follow, theme, persist) {
        state.follow = follow === true;
        if (theme === 'light' || theme === 'dark') state.theme = theme;
        if (persist) { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
        if (apply()) notify();
    }

    // OS light/dark switch — only matters while "follow system" is on.
    if (mq) {
        var onSys = function () { if (state.follow && apply()) notify(); };
        if (mq.addEventListener) mq.addEventListener('change', onSys);
        else if (mq.addListener) mq.addListener(onSys);
    }

    window.EhTheme = { state: state, effective: effective, apply: apply, set: set };
    apply();
})();

/**
 * Fast route to the background page.
 * Firefox sends every browser.runtime.sendMessage through the parent process and copies the payload each way,
 * which is slow for big pages of history (search results, import batches). This page and the background page
 * live in the same extension, so when the background page can be reached (browser.runtime.getBackgroundPage(),
 * not available in private windows) the request is handed over directly. Anything else — and any failure to
 * reach it — falls back to the normal message, so behaviour is identical, only quicker.
 */
(function () {
  try {
    const rt = browser.runtime;
    if (!rt || !rt.sendMessage || !rt.getBackgroundPage || rt.__ehFast) return;
    const orig = rt.sendMessage.bind(rt);
    const NOT_DIRECT = new Set(['AUTO_SAVE_READY']);          // answered by a per-tab listener that needs sender.tab
    let bgp = null;
    const getBg = () => bgp || (bgp = rt.getBackgroundPage().then(w => w || null, () => null));
    rt.sendMessage = async function (msg, ...rest) {
      if (rest.length || !msg || typeof msg !== 'object') return orig(msg, ...rest);
      let run = null;
      try {
        const bg = await getBg();
        if (bg) {
          if (msg.target === 'eh-sql') { if (typeof bg.EH_SQL_DIRECT === 'function') run = () => bg.EH_SQL_DIRECT(msg.op, msg.args); }
          else if (typeof msg.type === 'string' && !NOT_DIRECT.has(msg.type) && typeof bg.EH_DIRECT === 'function') run = () => bg.EH_DIRECT(msg);
        }
      } catch (_) { bgp = null; run = null; }
      if (!run) return orig(msg);
      let p;
      try { p = run(); } catch (_) { bgp = null; return orig(msg); }   // background page was reloaded: nothing ran yet
      return p;
    };
    rt.__ehFast = true;
  } catch (_) {}
})();
