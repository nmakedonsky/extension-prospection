/** Chemins jobs + éligibilité carte dans la colonne liste. */

function isJobsSearchResultsPath() {
  return String(location.pathname || '').includes('/jobs/search-results');
}

function isJobsCollectionsPathDock() {
  return String(location.pathname || '').includes('/jobs/collections');
}

function isJobCardInListColumn(el) {
  const j = window.__prospectionJobs;
  if (!el) return false;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 4) return false;
  const vw = window.innerWidth || 1200;
  /** Même idée que Collections : colonne gauche, ne pas bloquer sur isNodeInJobDetailsComposed (faux positifs wrappers). */
  if (j?.isInLeftJobListColumn?.(el)) {
    const cx = r.left + r.width / 2;
    if (cx <= vw * 0.72) {
      if (el.closest?.('[componentkey^="JobDetails"], [componentkey*="JobDetails_"]')) return false;
      if (el.closest?.('.jobs-unified-top-card, .jobs-search__job-details')) return false;
      return true;
    }
  }
  if (j?.isNodeInJobDetailsComposed?.(el)) return false;
  const cx = r.left + r.width / 2;
  return cx <= vw * 0.72;
}
