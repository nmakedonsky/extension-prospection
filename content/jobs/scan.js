/** Payload télémétrie + marqueurs CSS de chemin. */

function isJobsSearchResultsLikePath() {
  const p = String(location.pathname || '');
  return (
    p.includes('/jobs/search-results') ||
    p.includes('/jobs/search/') ||
    (typeof isJobsSlugListingPath === 'function' && isJobsSlugListingPath())
  );
}

function buildScanPayload() {
  pnSyncPathForPerf();

  const tCollect0 = performance.now();
  const cards = collectJobCards();
  const collectMs = Math.round(performance.now() - tCollect0);

  const tNames0 = performance.now();
  const companies = [];
  const seenNames = new Set();
  for (const card of cards) {
    const cel = findCompanyElementInCard(card);
    const name = extractCompanyName(cel);
    if (!name || name.length < 2 || seenNames.has(name)) continue;
    seenNames.add(name);
    companies.push(name);
  }
  const extractCompaniesMs = Math.round(performance.now() - tNames0);

  const timing = pnNotifyScanStep(cards.length, collectMs, extractCompaniesMs);
  const classifyExtra = pnConsumeLastClassificationForPayload();

  const clientIds = [];
  try {
    for (const w of querySelectorAllDeep(document, pnAspirableJobCardsSelector())) {
      if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(w)) continue;
      const { jobUrl } = getJobInfoFromWrapper(w);
      const jid = getJobIdFromWrapper(w, jobUrl) || '';
      if (!jid || clientIds.includes(jid)) continue;
      clientIds.push(jid);
      if (clientIds.length >= 14) break;
    }
  } catch (_) {}
  let clientJobSample = clientIds.join(',');
  if (clientJobSample.length > 180) clientJobSample = clientJobSample.slice(0, 180);

  return {
    cardCount: cards.length,
    companyCount: companies.length,
    sampleCompanies: companies.slice(0, 6),
    pageKind: isJobsCollectionsPath() ? 'collections' : 'search-results',
    collectMs: timing.collectMs,
    extractCompaniesMs: timing.extractCompaniesMs,
    msToFirstNonzeroCards: timing.msToFirstNonzeroCards,
    msSincePathSegment: timing.msSincePathSegment,
    clientJobSample,
    clientJobCount: clientIds.length,
    ...(classifyExtra || {})
  };
}

function applyPathMarkerClass() {
  try {
    const html = document.documentElement;
    const p = String(location.pathname || '');
    html.classList.remove('pn-path-jobs-search-results', 'pn-path-jobs-collections');
    if (isJobsSearchResultsLikePath()) html.classList.add('pn-path-jobs-search-results');
    else if (p.includes('/jobs/collections')) html.classList.add('pn-path-jobs-collections');
  } catch (_) {}
}

function isClassificationTargetPage() {
  return isJobsSearchResultsLikePath() || isJobsCollectionsPath();
}
