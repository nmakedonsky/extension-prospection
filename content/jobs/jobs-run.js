/**
 * Boucle d’observation DOM, tick, API debug __prospectionJobs / PROSPECTION_DOM_DIAGNOSTIC.
 *
 * Critères de succès (QA) :
 * - Collections : collectJobCards().length > 0 après scroll modéré ; badges sur le nom société de la liste, pas le panneau détail.
 * - Search-results : comportement inchangé (branche dédiée collectJobCardsSearchResults).
 */

let lastPath = '';

function tick() {
  applyPathMarkerClass();
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
  }
  const payload = buildScanPayload();
  sendHeartbeat(payload, false);
  scheduleClassification();
}

let scheduled = false;
function scheduleTick() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    tick();
  });
}

const mo = new MutationObserver(() => scheduleTick());
mo.observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleTick();
});

lastPath = location.pathname;
applyPathMarkerClass();
scheduleTick();
sendHeartbeat(buildScanPayload(), true);

setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    applyPathMarkerClass();
    scheduleTick();
  }
}, 800);

try {
  window.__prospectionJobs = {
    isNodeInJobDetailsComposed,
    isJobsCollectionsPath,
    isInLeftJobListColumn
  };
} catch (_) {}

try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'PROSPECTION_DOM_DIAGNOSTIC') return false;
    try {
      const report = buildDomDiagnosticReport();
      sendResponse({ ok: true, report });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return true;
  });
} catch (_) {}
