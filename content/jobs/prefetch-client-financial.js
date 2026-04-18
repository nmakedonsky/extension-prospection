/**
 * Clients : un getFinancialData silencieux après classification pour préremplir cache + dock.
 * Dépend de ensureCompanyMatchContext (company-match-context.js), chargé avant ce fichier.
 */

const prefetchedFinancialCompanyKeys = new Set();

function prefetchFinancialDataForClient(jobCard, companyName) {
  const key = String(companyName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!key) return;
  if (prefetchedFinancialCompanyKeys.has(key)) return;

  void (async () => {
    if (typeof ensureCompanyMatchContext !== 'function') return;
    const ens = await ensureCompanyMatchContext(jobCard, companyName);
    if (!ens.ok) {
      return;
    }
    prefetchedFinancialCompanyKeys.add(key);

    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage(
        {
          action: 'getFinancialData',
          companyName,
          forceRefresh: false,
          companyContext: ens.context
        },
        () => void chrome.runtime?.lastError
      );
    } catch (_) {}
  })();
}
