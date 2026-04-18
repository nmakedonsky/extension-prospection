/** Géométrie colonnes / détail vs liste, chemins URL jobs. */

/** Colonne liste (two-pane) : bord droit dans la moitié gauche — évite faux positifs « détail » sur /jobs/collections/. */
function isInLeftJobListColumn(el) {
  const vw = window.innerWidth || 1200;
  const r = el?.getBoundingClientRect?.();
  if (!r || r.width < 4 || r.height < 4) return false;
  return r.right < vw * 0.58;
}

/**
 * Vrai panneau détail (offre ouverte à droite). Sur Collections, wrappers englobent parfois
 * toute la page — signaux « faibles » seulement si le nœud n’est pas dans la colonne liste.
 */
function isNodeInJobDetailsComposed(el) {
  if (!el) return false;
  const relaxWeakDetailSignals =
    (isJobsCollectionsPath() || String(location.pathname || '').includes('/jobs/search-results')) &&
    isInLeftJobListColumn(el);
  let n = el;
  while (n) {
    if (n.nodeType === 1) {
      const ck = n.getAttribute?.('componentkey') || '';
      if (/JobDetails/i.test(ck)) return true;
      let cls = '';
      if (typeof n.className === 'string') cls = n.className;
      else if (n.className && typeof n.className.baseVal === 'string') cls = n.className.baseVal;
      if (cls.includes('jobs-unified-top-card') || cls.includes('jobs-search__job-details')) {
        return true;
      }
      if (relaxWeakDetailSignals) {
        const root = n.getRootNode?.({ composed: false });
        if (root instanceof ShadowRoot) n = root.host;
        else n = n.parentElement;
        continue;
      }
      if (
        cls.includes('scaffold-layout__detail') ||
        cls.includes('jobs-search-two-pane__details') ||
        (cls.includes('two-pane') && cls.includes('detail'))
      ) {
        return true;
      }
    }
    const root = n.getRootNode?.({ composed: false });
    if (root instanceof ShadowRoot) n = root.host;
    else n = n.parentElement;
  }
  return false;
}

function isLikelyLeftColumnJobCard(el) {
  const vw = window.innerWidth || 1200;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 8 || r.height < 8) return false;
  const cx = r.left + r.width / 2;
  if (cx > vw * 0.72) return false;
  return true;
}

/** Liste Collections : bord droit dans la colonne gauche (~two-pane) ou centre comme search-results. */
function isLikelyCollectionsListCard(el) {
  const vw = window.innerWidth || 1200;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 8 || r.height < 8) return false;
  if (r.right < vw * 0.58) return true;
  const cx = r.left + r.width / 2;
  return cx <= vw * 0.72;
}

function inferCardWrapperFromJobLink(anchor) {
  let n = anchor;
  let depth = 0;
  while (n && depth < 18) {
    if (n.nodeType === 1) {
      const tag = n.tagName?.toLowerCase() || '';
      const dj = n.getAttribute?.('data-job-id') || n.getAttribute?.('data-occludable-job-id') || '';
      const ck = String(n.getAttribute?.('componentkey') || '');
      if (dj || /job-card/i.test(ck)) return n;
      if (tag === 'li' && n.querySelector?.(JOB_VIEW_LINK_SELECTOR)) return n;
      if (tag === 'article') return n;
    }
    n = n.parentElement;
    depth++;
  }
  return anchor?.parentElement || anchor;
}

function isJobsCollectionsPath() {
  return String(location.pathname || '').includes('/jobs/collections');
}
