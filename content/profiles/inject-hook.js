/**
 * ISOLATED document_start — injecte le hook MAIN via <script src=extension> (backup WAR)
 * et demande immédiatement le drain du buffer.
 */
(function pnInjectProfileHook() {
  if (window.__pnProfileInjectDone) return;
  window.__pnProfileInjectDone = true;

  function requestDrain() {
    try {
      window.postMessage({ source: 'pn-linkedin-profile-req', kind: 'drain' }, '*');
    } catch (_) {}
  }

  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/profiles/page-hook.js');
    s.async = false;
    s.onload = () => {
      try {
        s.remove();
      } catch (_) {}
      requestDrain();
    };
    s.onerror = () => requestDrain();
    (document.documentElement || document.head || document).appendChild(s);
  } catch (_) {
    requestDrain();
  }

  // Drains répétés : le hook MAIN (manifest) peut démarrer juste après
  [0, 50, 200, 500, 1000, 2000, 4000].forEach((ms) => {
    setTimeout(requestDrain, ms);
  });
})();
