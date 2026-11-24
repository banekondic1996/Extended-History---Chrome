// History override entry point (Ctrl+H).
// Popup UI when embedded in Edge's History flyout (no real tab) or when the
// window is <= 400px wide (height varies, so it's ignored). Otherwise the full page.
(function () {
  let done = false;
  const go = (tab) => {
    if (done) return; done = true;
    void chrome.runtime.lastError;
    const w = Math.min(window.innerWidth || Infinity, window.outerWidth || Infinity);
    const small = !tab || w <= 400;
    location.replace(small ? 'popup.html' : 'history.html');
  };
  try { chrome.tabs.getCurrent(go); } catch (e) { go(undefined); }
  setTimeout(() => go(undefined), 1500); // safety net if callback never fires
})();
