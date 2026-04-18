/**
 * Rapport diagnostic : compteurs par sélecteur (raw → détail → géométrie search),
 * tailles des branches search/collections, stratégie liens.
 */

function truncateRect(rect) {
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function outerHtmlSnippet(el, maxLen) {
  if (!el?.outerHTML) return '';
  const s = el.outerHTML.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function buildDomDiagnosticReport() {
  const vw = window.innerWidth || 1200;
  const roots = getScanRoots();
  const perSelector = [];

  for (const sel of JOB_CARD_SELECTORS) {
    let raw = 0;
    let afterDetail = 0;
    let afterGeoSearch = 0;
    let afterGeoCollections = 0;
    const samples = [];
    for (const root of roots) {
      for (const el of querySelectorAllDeep(root, sel)) {
        raw++;
        if (isNodeInJobDetailsComposed(el)) continue;
        afterDetail++;
        if (isLikelyLeftColumnJobCard(el)) afterGeoSearch++;
        if (isLikelyCollectionsListCard(el)) afterGeoCollections++;
        if (samples.length < 2) {
          samples.push({
            tag: el.tagName,
            class: String(typeof el.className === 'string' ? el.className : '').slice(0, 100),
            rect: truncateRect(el.getBoundingClientRect()),
            snippet: outerHtmlSnippet(el, 220)
          });
        }
      }
    }
    perSelector.push({
      selector: sel,
      raw,
      afterExcludingDetailPanel: afterDetail,
      afterGeometrySearchResults: afterGeoSearch,
      afterGeometryCollections: afterGeoCollections,
      samples
    });
  }

  let anchorTotal = 0;
  let anchorInListColumn = 0;
  let anchorAfterDetail = 0;
  for (const root of roots) {
    for (const a of querySelectorAllDeep(root, JOB_VIEW_LINK_SELECTOR)) {
      anchorTotal++;
      if (isNodeInJobDetailsComposed(a)) continue;
      anchorAfterDetail++;
      const r = a.getBoundingClientRect?.();
      if (!r) continue;
      if (r.right < vw * 0.58 || r.left + r.width / 2 <= vw * 0.72) anchorInListColumn++;
    }
  }

  const searchCards = collectJobCardsSearchResults();
  const collectionsCards = collectJobCardsCollections();
  const active = collectJobCards();

  return {
    pathname: String(location.pathname || ''),
    href: String(location.href || '').slice(0, 500),
    viewportWidth: vw,
    dispatch: isJobsCollectionsPath() ? 'collections' : 'search-results',
    counts: {
      collectJobCardsSearchResults: searchCards.length,
      collectJobCardsCollections: collectionsCards.length,
      collectJobCardsActive: active.length
    },
    perSelector,
    linkStrategy: {
      anchorsTotalDeep: anchorTotal,
      anchorsExcludingDetail: anchorAfterDetail,
      anchorsInListColumnHeuristic: anchorInListColumn
    },
    config: {
      linkedinCollectionsCardCss: pageConfig.linkedinCollectionsCardCss || '',
      linkedinCollectionsCompanyCss: pageConfig.linkedinCollectionsCompanyCss || ''
    }
  };
}
