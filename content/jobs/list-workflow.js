/**
 * Workflow liste jobs : ne démarre qu’après scroll complet (badges → clics Client → scrape).
 * Appelé uniquement depuis jobdesk-autoopen.js quand la liste est marquée « fully scrolled ».
 */

let pnListWorkflowRunning = false;

async function pnRunListWorkflowAfterFullScroll(reason = '') {
  if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
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

    if (typeof window.pnRunClassificationPassAfterScroll === 'function') {
      classifyOk = (await window.pnRunClassificationPassAfterScroll()) !== false;
    }

    if (classifyOk && typeof window.jdMarkCurrentListFullyScrolled === 'function') {
      window.jdMarkCurrentListFullyScrolled(reason);
    } else if (!classifyOk && typeof window.jdAbortListWorkflowGate === 'function') {
      window.jdAbortListWorkflowGate('classify_failed');
      return;
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

    if (typeof tryAutoOpenNewVisibleClientJobs === 'function') {
      await tryAutoOpenNewVisibleClientJobs();
    }
  } finally {
    pnListWorkflowRunning = false;
  }
}

try {
  window.pnRunListWorkflowAfterFullScroll = pnRunListWorkflowAfterFullScroll;
} catch (_) {}
