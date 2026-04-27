/**
 * File d’attente persistante (chrome.storage) pour précharger les données financières
 * des entreprises classées « Client », exécutée séquentiellement côté service worker.
 *
 * Objectif : continuer après navigation LinkedIn (le content script disparaît, la file reste).
 */

const SW_FINANCIAL_PREFETCH_QUEUE_KEY = 'pnFinancialPrefetchQueue';
const SW_FINANCIAL_PREFETCH_LAST_CTX_KEY = 'pnFinancialPrefetchLastCtx';
const SW_FINANCIAL_PREFETCH_MAX_ITEMS = 800;
const SW_FINANCIAL_PREFETCH_MAX_LAST_MAP = 1500;
const SW_FINANCIAL_PREFETCH_GAP_MS = 650;
const SW_FINANCIAL_PREFETCH_MAX_ATTEMPTS = 2; // 1 tentative + 1 retry

let swFinancialPrefetchProcessing = false;

function swFinancialPrefetchNormalizeKey(companyName) {
  return String(companyName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function swFinancialPrefetchSanitizeCompanyContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  return {
    matchContextVersion: c.matchContextVersion,
    companyName: c.companyName,
    logoUrl: c.logoUrl,
    logoAlt: c.logoAlt,
    companyLinkedinUrl: c.companyLinkedinUrl,
    jobTitle: c.jobTitle,
    jobUrl: c.jobUrl,
    jobLocation: c.jobLocation,
    logoInlineSkipped: c.logoInlineSkipped
  };
}

async function swFinancialPrefetchLoadQueue() {
  try {
    const r = await chrome.storage.local.get(SW_FINANCIAL_PREFETCH_QUEUE_KEY);
    const q = r[SW_FINANCIAL_PREFETCH_QUEUE_KEY];
    return Array.isArray(q) ? q : [];
  } catch (_) {
    return [];
  }
}

async function swFinancialPrefetchSaveQueue(queue) {
  const trimmed = queue.slice(-SW_FINANCIAL_PREFETCH_MAX_ITEMS);
  await chrome.storage.local.set({ [SW_FINANCIAL_PREFETCH_QUEUE_KEY]: trimmed });
  return trimmed;
}

function swFinancialPrefetchContextFingerprint(ctx) {
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

async function swFinancialPrefetchIsContextFingerprintRecent(companyKey, ctx) {
  const fp = swFinancialPrefetchContextFingerprint(ctx);
  try {
    const r = await chrome.storage.local.get(SW_FINANCIAL_PREFETCH_LAST_CTX_KEY);
    const rows = Array.isArray(r[SW_FINANCIAL_PREFETCH_LAST_CTX_KEY]) ? r[SW_FINANCIAL_PREFETCH_LAST_CTX_KEY] : [];
    const hit = rows.find((x) => x && x.k === companyKey && x.fp === fp);
    return { hit: !!hit, fp, rows };
  } catch (_) {
    return { hit: false, fp, rows: null };
  }
}

async function swFinancialPrefetchRememberContextFingerprint(companyKey, fp) {
  try {
    const r = await chrome.storage.local.get(SW_FINANCIAL_PREFETCH_LAST_CTX_KEY);
    const rows = Array.isArray(r[SW_FINANCIAL_PREFETCH_LAST_CTX_KEY]) ? r[SW_FINANCIAL_PREFETCH_LAST_CTX_KEY] : [];
    const next = [...rows.filter((x) => x && x.k !== companyKey), { k: companyKey, fp, t: Date.now() }].slice(
      -SW_FINANCIAL_PREFETCH_MAX_LAST_MAP
    );
    await chrome.storage.local.set({ [SW_FINANCIAL_PREFETCH_LAST_CTX_KEY]: next });
  } catch (_) {}
}

function swFinancialPrefetchIsTransientErrorMessage(msg) {
  const s = String(msg || '').toLowerCase();
  return (
    s.includes(' 429:') ||
    s.includes(' 503:') ||
    s.includes(' 500:') ||
    s.includes('resource exhausted') ||
    s.includes('unavailable') ||
    s.includes('timeout') ||
    s.includes('failed to fetch') ||
    s.includes('networkerror')
  );
}

async function swFinancialPrefetchEnqueue(companyName, companyContext) {
  const name = String(companyName || '').trim();
  if (!name) return { ok: false, error: 'Nom manquant' };

  const safeCtx =
    companyContext && typeof companyContext === 'object' ? swFinancialPrefetchSanitizeCompanyContext(companyContext) : null;

  const key = swFinancialPrefetchNormalizeKey(name);

  if (await swHasFreshFinancialData(name)) {
    const fp = swFinancialPrefetchContextFingerprint(safeCtx);
    await swFinancialPrefetchRememberContextFingerprint(key, fp);
    void swFinancialPrefetchKick();
    return { ok: true, mode: 'skip-cached' };
  }

  const q0 = await swFinancialPrefetchLoadQueue();
  const dupPending = q0.some((it) => swFinancialPrefetchNormalizeKey(it?.companyName) === key);
  if (dupPending) {
    void swFinancialPrefetchKick();
    return { ok: true, mode: 'deduped-pending' };
  }

  const recent = await swFinancialPrefetchIsContextFingerprintRecent(key, safeCtx);
  if (recent.hit) {
    void swFinancialPrefetchKick();
    return { ok: true, mode: 'deduped-context' };
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    companyName: name,
    companyContext: safeCtx,
    attempts: 0,
    enqueuedAt: Date.now()
  };

  const q = await swFinancialPrefetchLoadQueue();
  if (q.some((it) => swFinancialPrefetchNormalizeKey(it?.companyName) === key)) {
    void swFinancialPrefetchKick();
    return { ok: true, mode: 'deduped-pending' };
  }

  q.push(item);
  await swFinancialPrefetchSaveQueue(q);
  await swFinancialPrefetchRememberContextFingerprint(key, recent.fp);
  void swFinancialPrefetchKick();
  return { ok: true, mode: 'enqueued' };
}

async function swFinancialPrefetchKick() {
  if (swFinancialPrefetchProcessing) return;
  swFinancialPrefetchProcessing = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = await swFinancialPrefetchLoadQueue();
      if (!q.length) break;

      const item = q[0];
      const name = String(item?.companyName || '').trim();
      if (!name) {
        q.shift();
        await swFinancialPrefetchSaveQueue(q);
        continue;
      }

      if (await swHasFreshFinancialData(name)) {
        q.shift();
        await swFinancialPrefetchSaveQueue(q);
        await new Promise((r) => setTimeout(r, SW_FINANCIAL_PREFETCH_GAP_MS));
        continue;
      }

      try {
        await swGetFinancialData(name, false, item?.companyContext || null);
      } catch (e) {
        const msgStr = String(e && e.message ? e.message : e);
        if (msgStr.startsWith('CONTEXTE_MATCH_INCOMPLET:')) {
          // Contexte incomplet : inutile de boucler — on drop.
        } else if (swFinancialPrefetchIsTransientErrorMessage(msgStr) && Number(item.attempts || 0) + 1 < SW_FINANCIAL_PREFETCH_MAX_ATTEMPTS) {
          item.attempts = Number(item.attempts || 0) + 1;
          q[0] = item;
          await swFinancialPrefetchSaveQueue(q);
          await new Promise((r) => setTimeout(r, SW_FINANCIAL_PREFETCH_GAP_MS * 2));
          continue;
        }
      }

      q.shift();
      await swFinancialPrefetchSaveQueue(q);
      await new Promise((r) => setTimeout(r, SW_FINANCIAL_PREFETCH_GAP_MS));
    }
  } finally {
    swFinancialPrefetchProcessing = false;
  }
}

chrome.runtime.onStartup.addListener(() => {
  void swFinancialPrefetchKick();
});

chrome.runtime.onInstalled.addListener(() => {
  void swFinancialPrefetchKick();
});
