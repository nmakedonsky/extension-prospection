/** Payload télémétrie + marqueurs CSS de chemin. */

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

  return {
    cardCount: cards.length,
    companyCount: companies.length,
    sampleCompanies: companies.slice(0, 8),
    pageKind: isJobsCollectionsPath() ? 'collections' : 'search-results',
    collectMs: timing.collectMs,
    extractCompaniesMs: timing.extractCompaniesMs,
    msToFirstNonzeroCards: timing.msToFirstNonzeroCards,
    msSincePathSegment: timing.msSincePathSegment,
    ...(classifyExtra || {})
  };
}

function applyPathMarkerClass() {
  try {
    const html = document.documentElement;
    const p = String(location.pathname || '');
    html.classList.remove('pn-path-jobs-search-results', 'pn-path-jobs-collections');
    if (p.includes('/jobs/search-results')) html.classList.add('pn-path-jobs-search-results');
    else if (p.includes('/jobs/collections')) html.classList.add('pn-path-jobs-collections');
  } catch (_) {}
}

function isClassificationTargetPage() {
  const p = String(location.pathname || '');
  return p.includes('/jobs/search-results') || p.includes('/jobs/collections');
}
