/**
 * Workflow liste jobs — ordre strict :
 * 1) scroll complet
 * 2) classification + affichage de TOUS les badges visibles
 * 3) puis seulement auto-open / scrape Client + SS2I (un par un)
 */

let pnListWorkflowRunning = false;

function pnSleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pnRunListWorkflowAfterFullScroll(reason = '') {
  if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
  if (typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning) return;
  if (typeof window.jdIsListWorkflowActive === 'function' && !window.jdIsListWorkflowActive()) return;
  if (pnListWorkflowRunning) return;

  pnListWorkflowRunning = true;
  let classifyOk = true;
  try {
    if (typeof jdLog === 'function') {
      jdLog('jd_wf', { st: 'run', r: String(reason || '').slice(0, 48) });
    }
    if (typeof lastJdRunReason !== 'undefined') {
      lastJdRunReason = String(reason || 'full-scroll-ready').slice(0, 80);
    }

    if (typeof mergeSeenClientJobsFromDom === 'function') mergeSeenClientJobsFromDom();

    // Peindre tout de suite depuis le cache (avant le settle).
    if (typeof window.pnRepaintVisibleBadgesFromCache === 'function') {
      window.pnRepaintVisibleBadgesFromCache();
    }

    // Étape 2a — classer (un partial n’arrête pas tout de suite : le gate badges retry)
    if (typeof window.pnRunClassificationPassAfterScroll === 'function') {
      classifyOk = (await window.pnRunClassificationPassAfterScroll({ settle: true })) !== false;
    }

    // Étape 2b — peindre / rattraper jusqu’à ce que les cartes classifiables aient un badge
    let badgesReady = true;
    if (typeof window.pnEnsureAllVisibleBadgesPainted === 'function') {
      badgesReady = (await window.pnEnsureAllVisibleBadgesPainted({ maxRounds: 6 })) === true;
    } else if (typeof window.pnRepaintVisibleBadgesFromCache === 'function') {
      window.pnRepaintVisibleBadgesFromCache();
    }

    if (!badgesReady && typeof jdLog === 'function') {
      jdLog('jd_wf', { st: 'soft_badges', classifyOk: !!classifyOk });
    }

    // Laisse le DOM peindre avant de lancer les clics
    await pnSleepMs(280);

    if (typeof window.jdMarkCurrentListFullyScrolled === 'function') {
      window.jdMarkCurrentListFullyScrolled(reason);
    }

    if (typeof pnTabVisibleForAutoOpen === 'function' && !pnTabVisibleForAutoOpen()) {
      if (typeof deferredAutoOpenWhileTabHidden !== 'undefined') deferredAutoOpenWhileTabHidden = true;
      return;
    }

    if (typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning) {
      if (typeof autoOpenRunQueued !== 'undefined') autoOpenRunQueued = true;
      return;
    }
    if (typeof autoOpenCoalesceTimer !== 'undefined' && autoOpenCoalesceTimer) {
      clearTimeout(autoOpenCoalesceTimer);
      autoOpenCoalesceTimer = null;
    }
    if (typeof lastAutoOpenRunAt !== 'undefined') lastAutoOpenRunAt = Date.now();

    // Étape 3 — scrape (un Client à la fois)
    if (typeof tryAutoOpenNewVisibleClientJobs === 'function') {
      requestAutoOpenRun('full-scroll-ready');
    }
  } finally {
    pnListWorkflowRunning = false;
  }
}

try {
  window.pnRunListWorkflowAfterFullScroll = pnRunListWorkflowAfterFullScroll;
} catch (_) {}
