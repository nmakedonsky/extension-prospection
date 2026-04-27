/**
 * Clients : enqueue silencieux après classification pour préremplir cache + dock.
 * La file tourne dans le service worker : elle continue après navigation LinkedIn.
 * Dépend de ensureCompanyMatchContext (company-match-context.js), chargé avant ce fichier.
 */

const prefetchedFinancialSessionKeys = new Set();

function prefetchFinancialContextFingerprint(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const pick = (k) => String(c[k] || '').trim();
  return [
    pick('companyLinkedinUrl'),
    pick('jobUrl'),
    pick('jobTitle'),
    pick('jobLocation'),
    pick('logoUrl'),
    pick('logoAlt')
  ].join('|');
}

function prefetchFinancialDataForClient(jobCard, companyName) {
  const key = String(companyName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!key) return;

  void (async () => {
    if (typeof ensureCompanyMatchContext !== 'function') return;
    const ens = await ensureCompanyMatchContext(jobCard, companyName);
    if (!ens.ok) {
      return;
    }
    const fp = prefetchFinancialContextFingerprint(ens.context);
    const dedupe = `${key}||${fp}`;
    if (prefetchedFinancialSessionKeys.has(dedupe)) return;
    prefetchedFinancialSessionKeys.add(dedupe);

    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage(
        {
          action: 'enqueueFinancialPrefetch',
          companyName,
          companyContext: ens.context
        },
        () => void chrome.runtime?.lastError
      );
    } catch (_) {}
  })();
}
