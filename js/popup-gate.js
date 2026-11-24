// popup.html is the history override target (Ctrl+H). Only hand over to the
// full page when we're in a real browser tab AND wider than 400px.
// Edge's History flyout isn't a tab (tabs.getCurrent -> undefined), toolbar popup
// isn't either, and the side panel (?sidebar=1) is skipped explicitly.
(function () {
  if (new URLSearchParams(location.search).get('sidebar') === '1') return;
  const check = () => {
    try {
      chrome.tabs.getCurrent((tab) => {
        void chrome.runtime.lastError;
        const w = Math.min(window.innerWidth || Infinity, window.outerWidth || Infinity);
        console.log('[EH gate] tab:', !!tab, 'width:', w);
        if (tab && w > 400) location.replace('history.html');
      });
    } catch (e) { console.warn('[EH gate]', e); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
  else check();
})();
