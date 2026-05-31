/**
 * Boucle d’observation DOM, tick, API debug __prospectionJobs.
 *
 * Critères de succès (QA) :
 * - Collections : collectJobCards().length > 0 après scroll modéré ; badges sur le nom société de la liste, pas le panneau détail.
 * - Search-results : comportement inchangé (branche dédiée collectJobCardsSearchResults).
 */

let lastPath = '';
let __jdBadgeCatchupAt = 0;

function tick() {
  applyPathMarkerClass();
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
  }
  const payload = buildScanPayload();
  sendHeartbeat(payload, false);

  // Pagination collections (?start=25/50…) : workflow déclenché avant noms société → relancer au bas de liste.
  const now = Date.now();
  if (
    now - __jdBadgeCatchupAt >= 2000 &&
    typeof isClassificationTargetPage === 'function' &&
    isClassificationTargetPage() &&
    payload.cardCount > 0 &&
    payload.clientJobCount === 0 &&
    typeof jdHasReachedBottomForCurrentList === 'function' &&
    jdHasReachedBottomForCurrentList() &&
    typeof jdHasUserScrolledCurrentList === 'function' &&
    jdHasUserScrolledCurrentList() &&
    typeof collectJobCards === 'function' &&
    typeof jdTryStartListWorkflow === 'function'
  ) {
    const cards = collectJobCards();
    const unprocessed = cards.filter((c) => !c?.hasAttribute?.(DATA_PROCESSED)).length;
    if (unprocessed >= 3) {
      __jdBadgeCatchupAt = now;
      jdTryStartListWorkflow('badge-catchup');
    }
  }
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
