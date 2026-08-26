/**
 * Tick DOM : heartbeat + re-peindre les badges si la page est « ready ».
 * Ne retire jamais les labels ici (ça cassait les clics d’offre).
 * Nouvelle page → jdResetUiForNewListPage().
 */

let lastPath = '';
let __jdBadgeCatchupAt = 0;
let __jdMissingBadgeClassifyAt = 0;
let __jdMergeAt = 0;

function tick() {
  applyPathMarkerClass();
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
  }
  const payload = buildScanPayload();
  sendHeartbeat(payload, false);

  const now = Date.now();
  if (now - __jdMergeAt >= 150 && typeof mergeSeenClientJobsFromDom === 'function') {
    __jdMergeAt = now;
    try {
      mergeSeenClientJobsFromDom();
    } catch (_) {}
  }

  if (now - __jdBadgeCatchupAt < 400) return;
  if (typeof classificationPassRunning !== 'undefined' && classificationPassRunning) return;
  if (typeof pnListWorkflowRunning !== 'undefined' && pnListWorkflowRunning) return;
  if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
  if (payload.cardCount <= 0) return;
  if (typeof collectJobCards !== 'function') return;

  const canPaint =
    typeof window.pnCanPaintBadgesNow === 'function' && window.pnCanPaintBadgesNow();
  if (!canPaint) return;

  __jdBadgeCatchupAt = now;
  if (typeof window.pnRepaintVisibleBadgesFromCache === 'function') {
    window.pnRepaintVisibleBadgesFromCache();
  }
  const fullyScrolled =
    typeof jdIsCurrentListFullyScrolled === 'function' && jdIsCurrentListFullyScrolled();
  const scraping =
    typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning;
  if (
    fullyScrolled &&
    !scraping &&
    now - __jdMissingBadgeClassifyAt >= 4500 &&
    typeof window.pnCatchUpMissingBadges === 'function'
  ) {
    __jdMissingBadgeClassifyAt = now;
    void window.pnCatchUpMissingBadges();
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
