/**
 * lock.js — Lock / unlock UI for Extended History. Loaded right after i18n-core.js
 * on history.html and popup.html (the side panel is popup.html?sidebar=1).
 *
 *  - If history is locked, shows a "Locked" modal over a blurred page with a
 *    password field. Nothing is loaded from the extension until it is unlocked
 *    (background.js refuses every other message while locked).
 *  - On history.html, wires the "🔒 Lock" button in the sidebar (#lockBtn) to a
 *    warning modal that asks for the password and then locks.
 *  - Any page reloads when the lock state changes, so a locked page never keeps
 *    history in memory and an unlocked one reloads with fresh data.
 */
(function () {
  'use strict';
  var LOCK_STATE_KEY = 'eh_locked';

  function T(key, fallback) {
    var subs = Array.prototype.slice.call(arguments, 2);
    if (typeof window.tr === 'function') return window.tr.apply(null, [key, fallback].concat(subs));
    return fallback.replace(/\{(\d+)\}/g, function (_, i) { return subs[i] !== undefined ? subs[i] : ''; });
  }

  // No timeout here on purpose: locking/unlocking 100k+ entries can take a while.
  function bg(type, extra) {
    return new Promise(function (res, rej) {
      chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}), function (r) {
        if (chrome.runtime.lastError) { rej(new Error(chrome.runtime.lastError.message)); return; }
        if (r && r.error) { rej(new Error(r.error)); return; }
        res(r);
      });
    });
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  var css =
    '.eh-lk-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;' +
      'background:rgba(8,8,12,0.5);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.eh-lk-card{width:100%;max-width:400px;box-sizing:border-box;padding:28px 24px 22px;text-align:center;border-radius:16px;' +
      'background:var(--surf1,var(--s1,#18181f));color:var(--text,#f0eee8);border:1px solid var(--border2,var(--border,rgba(255,255,255,0.12)));' +
      'box-shadow:0 24px 80px rgba(0,0,0,0.5);max-height:96vh;overflow:auto}' +
    '.eh-lk-icon{font-size:3.4rem;line-height:1;margin-bottom:10px}' +
    '.eh-lk-title{font-size:1.25rem;font-weight:700;margin-bottom:8px}' +
    '.eh-lk-text{font-size:0.82rem;line-height:1.55;color:var(--text2,#a09eb0);margin-bottom:14px}' +
    '.eh-lk-text.left{text-align:left}' +
    '.eh-lk-input{display:block;width:100%;box-sizing:border-box;padding:10px 12px;margin-top:12px;border-radius:8px;outline:none;font-size:0.9rem;' +
      'background:var(--surf3,var(--s2,#1f1f28));color:var(--text,#f0eee8);border:1px solid var(--border2,var(--border,rgba(255,255,255,0.12)))}' +
    '.eh-lk-input:focus{border-color:var(--accent,#3b9eff)}' +
    '.eh-lk-check{display:flex;align-items:center;gap:8px;text-align:left;font-size:0.82rem;margin:2px 0 6px;cursor:pointer;color:var(--text,#f0eee8)}' +
    '.eh-lk-check input{width:16px;height:16px;flex-shrink:0;accent-color:var(--accent,#3b9eff);cursor:pointer}' +
    '.eh-lk-err{min-height:1.1em;margin-top:10px;font-size:0.78rem;color:var(--danger,#f06060)}' +
    '.eh-lk-btns{display:flex;gap:8px;margin-top:14px}' +
    '.eh-lk-btn{flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:600;' +
      'background:var(--surf2,var(--s2,#1f1f28));color:var(--text,#f0eee8);border:1px solid var(--border2,var(--border,rgba(255,255,255,0.12)))}' +
    '.eh-lk-btn.primary{background:var(--accent,#3b9eff);border-color:var(--accent,#3b9eff);color:#fff}' +
    '.eh-lk-btn:disabled{opacity:0.6;cursor:default}' +
    'html.eh-locked,html.eh-locked body{min-height:400px}';
  function injectStyle() {
    if (document.getElementById('ehLockStyle')) return;
    var st = document.createElement('style');
    st.id = 'ehLockStyle';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function makeOverlay(id, innerHtml) {
    injectStyle();
    var ov = document.createElement('div');
    ov.id = id;
    ov.className = 'eh-lk-overlay';
    ov.innerHTML = '<div class="eh-lk-card">' + innerHtml + '</div>';
    document.documentElement.appendChild(ov);   // outside <body> so body can be made inert
    return ov;
  }

  // ── Locked modal ──────────────────────────────────────────────────────────
  function showLockedModal() {
    if (document.getElementById('ehUnlockOverlay')) return;
    document.documentElement.classList.add('eh-locked');
    var ov = makeOverlay('ehUnlockOverlay',
      '<div class="eh-lk-icon">🔒</div>' +
      '<div class="eh-lk-title"></div>' +
      '<div class="eh-lk-text"></div>' +
      '<input type="password" class="eh-lk-input" id="ehUnlockPw" autocomplete="off">' +
      '<div class="eh-lk-err" id="ehUnlockErr"></div>' +
      '<div class="eh-lk-btns"><button class="eh-lk-btn primary" id="ehUnlockBtn"></button></div>');
    var $ = function (s) { return ov.querySelector(s); };
    $('.eh-lk-title').textContent = T('lock_locked_title', 'Locked');
    $('.eh-lk-text').textContent  = T('lock_locked_desc', 'Your history is encrypted. Enter your password to unlock it.');
    var pw = $('#ehUnlockPw'), btn = $('#ehUnlockBtn'), err = $('#ehUnlockErr');
    pw.placeholder = T('lock_password', 'Password');
    btn.textContent = T('lock_unlock', 'Unlock');
    if (document.body) document.body.setAttribute('inert', '');

    async function doUnlock() {
      if (!pw.value) { pw.focus(); return; }
      btn.disabled = pw.disabled = true;
      btn.textContent = T('lock_unlocking', 'Unlocking…');
      err.textContent = '';
      try {
        await bg('UNLOCK_HISTORY', { password: pw.value });
        location.reload();
      } catch (e) {
        btn.disabled = pw.disabled = false;
        btn.textContent = T('lock_unlock', 'Unlock');
        err.textContent = /wrong password/i.test(e.message) ? T('lock_wrong_password', 'Wrong password') : e.message;
        pw.select();
      }
    }
    btn.addEventListener('click', doUnlock);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doUnlock(); });
    setTimeout(function () { pw.focus(); }, 50);
  }

  // ── Lock warning modal ────────────────────────────────────────────────────
  function showLockWarning() {
    if (document.getElementById('ehLockOverlay')) return;
    var ov = makeOverlay('ehLockOverlay',
      '<div class="eh-lk-icon" style="font-size:4rem">⚠️</div>' +
      '<div class="eh-lk-title"></div>' +
      '<div class="eh-lk-text left" id="ehLkWarn"></div>' +
      '<label class="eh-lk-check"><input type="checkbox" id="ehLkLogout"><span id="ehLkLogoutTxt"></span></label>' +
      '<label class="eh-lk-check"><input type="checkbox" id="ehLkHideBm"><span id="ehLkHideBmTxt"></span></label>' +
      '<input type="password" class="eh-lk-input" id="ehLkPw1" autocomplete="new-password">' +
      '<input type="password" class="eh-lk-input" id="ehLkPw2" autocomplete="new-password">' +
      '<div class="eh-lk-err" id="ehLkErr"></div>' +
      '<div class="eh-lk-btns"><button class="eh-lk-btn" id="ehLkCancel"></button><button class="eh-lk-btn primary" id="ehLkOk"></button></div>');
    var $ = function (s) { return ov.querySelector(s); };
    $('.eh-lk-title').textContent = T('lock_warning_title', 'Lock history ?');
    $('#ehLkWarn').textContent =
      T('lock_warning_body',
        'Locking will encrypt all history inside the extension. All history inside the browser itself will be deleted, the extension\'s own copy is kept, encrypted. ' +
        'Make sure you back up your history by exporting it first, just in case of a power failure. ' +
        'After locking you can unlock by entering your password and history inside extension will be returned, but not browser native one. ' +
        'Meaning there will be missing autocomplete suggestions in address bar, only most visited urls and domains will show up.'+
        'If you forget the password, the history cannot be recovered. ');
    $('#ehLkLogoutTxt').textContent = T('lock_logout_everywhere', 'Logout everywhere (also clear cookies and site data)');
    $('#ehLkHideBmTxt').textContent = T('lock_hide_bookmarks', 'Hide bookmarks (removed from the browser until you unlock)');
    var logout = $('#ehLkLogout'), hideBm = $('#ehLkHideBm');
    var pw1 = $('#ehLkPw1'), pw2 = $('#ehLkPw2'), err = $('#ehLkErr'), ok = $('#ehLkOk'), cancel = $('#ehLkCancel');
    pw1.placeholder = T('lock_password', 'Password');
    pw2.placeholder = T('lock_confirm_password', 'Confirm password');
    cancel.textContent = T('cancel', 'Cancel');
    ok.textContent = '🔒 ' + T('lock_btn', 'Lock');
    var busy = false;
    function close() { if (!busy) ov.remove(); }
    cancel.addEventListener('click', close);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

    async function doLock() {
      if (busy) return;
      if (pw1.value.length < 4) { err.textContent = T('lock_password_short', 'Password must be at least 4 characters'); return; }
      if (pw1.value !== pw2.value) { err.textContent = T('lock_password_mismatch', 'Passwords do not match'); return; }
      busy = true; ok.disabled = cancel.disabled = pw1.disabled = pw2.disabled = logout.disabled = hideBm.disabled = true;
      ok.textContent = T('lock_locking', 'Encrypting…');
      err.textContent = '';
      try {
        await bg('LOCK_HISTORY', { password: pw1.value, clearSiteData: logout.checked, hideBookmarks: hideBm.checked });
        location.reload();
      } catch (e) {
        busy = false; ok.disabled = cancel.disabled = pw1.disabled = pw2.disabled = logout.disabled = hideBm.disabled = false;
        ok.textContent = '🔒 ' + T('lock_btn', 'Lock');
        err.textContent = e.message;
      }
    }
    ok.addEventListener('click', doLock);
    pw2.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLock(); });
    setTimeout(function () { pw1.focus(); }, 50);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function wireButton() {
    var b = document.getElementById('lockBtn');
    if (b) b.addEventListener('click', showLockWarning);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireButton);
  else wireButton();

  chrome.storage.local.get(LOCK_STATE_KEY, function (r) {
    if (r && r[LOCK_STATE_KEY] === true) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showLockedModal);
      else showLockedModal();
    }
  });
  // Lock state changed (here, in another tab, the popup or the side panel): reload so
  // this page never holds history in memory while locked and loads fresh data after unlock.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[LOCK_STATE_KEY]) location.reload();
  });
})();