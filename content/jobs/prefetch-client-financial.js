/**
 * Clients : un getFinancialData silencieux après classification pour préremplir cache + dock.
 * Dépend de buildCompanyContextForWrapper (company-dock.js), chargé avant ce fichier.
 */

const prefetchedFinancialCompanyKeys = new Set();

function prefetchFinancialDataForClient(jobCard, companyName) {
  const key = String(companyName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!key) return;
  if (prefetchedFinancialCompanyKeys.has(key)) return;
  prefetchedFinancialCompanyKeys.add(key);

  const companyContext =
    typeof buildCompanyContextForWrapper === 'function'
      ? buildCompanyContextForWrapper(jobCard, companyName)
      : null;

  try {
    if (!chrome?.runtime?.id) return;
    chrome.runtime.sendMessage(
      {
        action: 'getFinancialData',
        companyName,
        forceRefresh: false,
        companyContext
      },
      () => void chrome.runtime?.lastError
    );
  } catch (_) {}
}
