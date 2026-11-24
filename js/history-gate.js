// history.html entry gate: go to popup.html if the window is <= 400px wide
// OR this isn't a real browser tab (e.g. Edge's History flyout).
(function () {
  const toPopup = () => location.replace('popup.html?flyout=1');
  const w = Math.min(window.innerWidth || Infinity, window.outerWidth || Infinity);
  if (w <= 400) return toPopup();          // immediate, avoids loading the heavy page
  try {
    chrome.tabs.getCurrent((tab) => {
      void chrome.runtime.lastError;
      if (!tab) toPopup();
    });
  } catch (e) { /* keep full page */ }
})();
