/**
 * Clients : enqueue silencieux après classification pour préremplir cache + dock.
 * La file tourne dans le service worker : elle continue après navigation LinkedIn.
 * Dépend de ensureCompanyMatchContext (company-match-context.js), chargé avant ce fichier.
 */

const prefetchedFinancialSessionKeys = new Set();
const PREFETCH_CONTEXT_RETRY_MAX = 3;
const PREFETCH_CONTEXT_RETRY_BASE_MS = 1100;

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

function prefetchFinancialDataForClient(jobCard, companyName, attempt = 0) {
  const key = String(companyName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!key) return;

  void (async () => {
    if (typeof ensureCompanyMatchContext !== 'function') return;
    const ens = await ensureCompanyMatchContext(jobCard, companyName);
    if (!ens.ok) {
      if (attempt < PREFETCH_CONTEXT_RETRY_MAX && jobCard?.isConnected) {
        const delay = PREFETCH_CONTEXT_RETRY_BASE_MS * (attempt + 1);
        setTimeout(() => {
          try {
            prefetchFinancialDataForClient(jobCard, companyName, attempt + 1);
          } catch (_) {}
        }, delay);
      }
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
        (response) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            prefetchedFinancialSessionKeys.delete(dedupe);
            if (attempt < PREFETCH_CONTEXT_RETRY_MAX && jobCard?.isConnected) {
              const delay = PREFETCH_CONTEXT_RETRY_BASE_MS * (attempt + 1);
              setTimeout(() => {
                try {
                  prefetchFinancialDataForClient(jobCard, companyName, attempt + 1);
                } catch (_) {}
              }, delay);
            }
            try {
              console.warn('[Prospection CS] enqueueFinancialPrefetch runtime error:', companyName, err.message || err);
            } catch (_) {}
            return;
          }
          if (!response?.ok) {
            prefetchedFinancialSessionKeys.delete(dedupe);
            try {
              console.warn(
                '[Prospection CS] enqueueFinancialPrefetch rejected:',
                companyName,
                response?.error || 'unknown_error'
              );
            } catch (_) {}
            return;
          }
          try {
            console.info('[Prospection CS] enqueueFinancialPrefetch:', companyName, response.mode || 'ok');
          } catch (_) {}
        }
      );
    } catch (_) {
      prefetchedFinancialSessionKeys.delete(dedupe);
    }
  })();
}
