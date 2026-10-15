/**
 * theme-init.js — applies the saved theme BEFORE the first paint.
 * Load it as a plain (blocking) <script> in <head> of history.html and popup.html,
 * right after the stylesheet link / before <body>. (MV3 CSP forbids inline scripts,
 * so this has to be a file.)
 *
 * The real settings live in chrome.storage.local, which is async. Waiting for it meant
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
