/**
 * Boucle d’observation DOM, tick, API debug __prospectionJobs.
 *
 * Critères de succès (QA) :
 * - Collections : collectJobCards().length > 0 après scroll modéré ; badges sur le nom société de la liste, pas le panneau détail.
 * - Search-results : comportement inchangé (branche dédiée collectJobCardsSearchResults).
 */

let lastPath = '';
let __jdBadgeCatchupAt = 0;
let __jdMissingBadgeClassifyAt = 0;

function tick() {
  applyPathMarkerClass();
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
  }
  const payload = buildScanPayload();
  sendHeartbeat(payload, false);

  const now = Date.now();
  if (now - __jdBadgeCatchupAt < 1200) return;
  if (typeof classificationPassRunning !== 'undefined' && classificationPassRunning) return;
  if (typeof pnListWorkflowRunning !== 'undefined' && pnListWorkflowRunning) return;
  if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
  if (payload.cardCount <= 0) return;
  if (typeof collectJobCards !== 'function') return;

  const seqRunning =
    typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning;

  // Avant le test gate : porter fully-scrolled si LinkedIn a basculé start= dans l’URL.
  if (typeof mergeSeenClientJobsFromDom === 'function') {
    try {
      mergeSeenClientJobsFromDom();
    } catch (_) {}
  }

  const fullyScrolled =
    typeof jdIsCurrentListFullyScrolled === 'function' && jdIsCurrentListFullyScrolled();
  const canPaint =
    (typeof window.pnCanPaintBadgesNow === 'function' && window.pnCanPaintBadgesNow()) ||
    fullyScrolled ||
    seqRunning;

  // Re-peindre après scroll complet / pendant scrape — jamais strip dans ces cas.
  if (canPaint) {
    __jdBadgeCatchupAt = now;
    if (typeof window.pnRepaintVisibleBadgesFromCache === 'function') {
      window.pnRepaintVisibleBadgesFromCache();
    }
    // Virtualisation / partial : reclasser les cartes encore sans label (throttle).
    // Pas pendant auto-open : catch-up → pn-client-classified → nouvelles séquences qui cancel.
    if (
      fullyScrolled &&
      !seqRunning &&
      now - __jdMissingBadgeClassifyAt >= 4500 &&
      typeof window.pnCatchUpMissingBadges === 'function'
    ) {
      __jdMissingBadgeClassifyAt = now;
      void window.pnCatchUpMissingBadges();
    }
  } else if (typeof window.pnStripVisibleListBadges === 'function') {
    // Cartes recyclées / cache : enlever labels tant qu’on n’est pas en bas.
    __jdBadgeCatchupAt = now;
    window.pnStripVisibleListBadges();
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
    // SPA → collections/search : réveiller scroll-gate / workflow (évite « il faut rafraîchir »)
    try {
      if (typeof isClassificationTargetPage === 'function' && isClassificationTargetPage()) {
        if (typeof window.jdWakeAfterSpaPathChange === 'function') {
          window.jdWakeAfterSpaPathChange('jobs-run-path');
        } else if (typeof window.jdTryKickWorkflowAfterScrollHook === 'function') {
          if (typeof mergeSeenClientJobsFromDom === 'function') mergeSeenClientJobsFromDom();
          window.jdTryKickWorkflowAfterScrollHook('jobs-run-path');
        }
      }
    } catch (_) {}
  }
}, 800);

try {
  window.__prospectionJobs = {
    isNodeInJobDetailsComposed,
    isJobsCollectionsPath,
    isInLeftJobListColumn
  };
} catch (_) {}
