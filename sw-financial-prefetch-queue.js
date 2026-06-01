/**
 * File d’attente persistante (chrome.storage) pour précharger les données financières
 * des entreprises classées « Client », exécutée séquentiellement côté service worker.
 *
 * Objectif : continuer après navigation LinkedIn (le content script disparaît, la file reste).
 */

const SW_FINANCIAL_PREFETCH_QUEUE_KEY = 'pnFinancialPrefetchQueue';
const SW_FINANCIAL_PREFETCH_LAST_CTX_KEY = 'pnFinancialPrefetchLastCtx';
const SW_FINANCIAL_PREFETCH_MAX_ITEMS = 80;
const SW_FINANCIAL_PREFETCH_MAX_LAST_MAP = 320;
const SW_FINANCIAL_PREFETCH_GAP_MS = 650;
const SW_FINANCIAL_PREFETCH_MAX_ATTEMPTS = 2; // 1 tentative + 1 retry

let swFinancialPrefetchProcessing = false;

function swPrefetchLog(event, data, level = 'info') {
  try {
    if (typeof logToSupabase === 'function') {
      logToSupabase(event, data && typeof data === 'object' ? data : {}, level);
    }
  } catch (_) {}
}

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
    linkedinUrlValidated: c.linkedinUrlValidated,
    companyUrlSource: c.companyUrlSource,
    companyInsightName: c.companyInsightName,
    companyInsightAbout: c.companyInsightAbout,
    companyInsightEmployees: c.companyInsightEmployees,
    companyInsightSource: c.companyInsightSource,
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
  let trimmed = queue.slice(-SW_FINANCIAL_PREFETCH_MAX_ITEMS);
  try {
    await chrome.storage.local.set({ [SW_FINANCIAL_PREFETCH_QUEUE_KEY]: trimmed });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (!/quota|kquotabytes|quotaexceeded/i.test(msg)) throw e;
    trimmed = queue.slice(-40);
    try {
      await chrome.storage.local.set({ [SW_FINANCIAL_PREFETCH_QUEUE_KEY]: trimmed });
    } catch (_) {
      if (typeof self.pnExtensionStorageRotateHeavy === 'function') {
        await self.pnExtensionStorageRotateHeavy('quota_prefetch_save', {
          force: true,
          cacheCap: 40
        });
      }
      trimmed = queue.slice(-18);
      await chrome.storage.local.set({ [SW_FINANCIAL_PREFETCH_QUEUE_KEY]: trimmed });
    }
  }
  return trimmed;
}

function swFinancialPrefetchContextRichness(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const about = String(c.companyInsightAbout || '').trim();
  return (
    (about.length >= 80 ? about.length : 0) +
    (String(c.companyInsightEmployees || '').trim() ? 500 : 0) +
    (String(c.companyLinkedinUrl || '').trim() ? 100 : 0) +
    (c.companyUrlSource === 'insight_card' ? 200 : 0)
  );
}

function swFinancialPrefetchMergeQueueContext(existing, incoming) {
  const a = existing && typeof existing === 'object' ? existing : {};
  const b = incoming && typeof incoming === 'object' ? incoming : {};
  if (swFinancialPrefetchContextRichness(b) <= swFinancialPrefetchContextRichness(a)) {
    return a;
  }
  return { ...a, ...b };
}

function swFinancialPrefetchContextFingerprint(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const pick = (k) => String(c[k] || '').trim();
  return [
    String(c.matchContextVersion || ''),
    pick('companyLinkedinUrl'),
    pick('companyUrlSource'),
    pick('companyInsightAbout'),
    pick('companyInsightEmployees'),
    pick('jobUrl'),
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

function swFinancialPrefetchContextLogFields(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const about = String(c.companyInsightAbout || '').trim();
  return {
    match_context_version: c.matchContextVersion ?? null,
    company_url: c.companyLinkedinUrl || null,
    url_source: c.companyUrlSource || null,
    insight_name: c.companyInsightName || null,
    insight_employees: c.companyInsightEmployees || null,
    insight_about_len: about ? about.length : 0,
    insight_about_preview: about ? about.slice(0, 120) : null,
    has_insight: !!(about || c.companyInsightEmployees || c.companyInsightName)
  };
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

async function swFinancialPrefetchEnqueue(companyName, companyContext, options) {
  const name = String(companyName || '').trim();
  if (!name) return { ok: false, error: 'Nom manquant' };

  let safeCtx =
    companyContext && typeof companyContext === 'object' ? swFinancialPrefetchSanitizeCompanyContext(companyContext) : null;
  if (typeof swMergeCanonicalUrlIntoContext === 'function') {
    safeCtx = await swMergeCanonicalUrlIntoContext(name, safeCtx);
  }

  const key = swFinancialPrefetchNormalizeKey(name);
  const forceRefresh =
    !!(options && options.forceRefresh) || (await swShouldForceFinancialRefresh(name, safeCtx));

  const canonicalUrl =
    typeof swGetCanonicalCompanyLinkedinUrl === 'function' ? await swGetCanonicalCompanyLinkedinUrl(name) : '';
  const ctxUrl =
    typeof swNormalizeLinkedinCompanyUrl === 'function'
      ? swNormalizeLinkedinCompanyUrl(safeCtx?.companyLinkedinUrl || '')
      : String(safeCtx?.companyLinkedinUrl || '').trim();
  const ctxValidated =
    safeCtx?.linkedinUrlValidated === true &&
    typeof swUrlMatchesCompanyName === 'function' &&
    swUrlMatchesCompanyName(ctxUrl, name);
  if (!canonicalUrl && !ctxValidated) {
    swPrefetchLog('financial_prefetch_enqueue', {
      company_name: name,
      mode: 'skip-no-canonical-url',
      ...swFinancialPrefetchContextLogFields(safeCtx)
    });
    return { ok: true, mode: 'skip-no-canonical-url' };
  }

  if (await swHasFreshFinancialData(name) && !forceRefresh) {
    const fp = swFinancialPrefetchContextFingerprint(safeCtx);
    await swFinancialPrefetchRememberContextFingerprint(key, fp);
    void swFinancialPrefetchKick();
    swPrefetchLog('financial_prefetch_enqueue', {
      company_name: name,
      mode: 'skip-cached',
      ...swFinancialPrefetchContextLogFields(safeCtx)
    });
    try {
      console.info('[Prospection SW] prefetch enqueue skip-cached:', name);
    } catch (_) {}
    return { ok: true, mode: 'skip-cached' };
  }

  const q0 = await swFinancialPrefetchLoadQueue();
  const dupIdx = q0.findIndex((it) => swFinancialPrefetchNormalizeKey(it?.companyName) === key);
  if (dupIdx >= 0) {
    const merged = swFinancialPrefetchMergeQueueContext(q0[dupIdx]?.companyContext, safeCtx);
    q0[dupIdx] = {
      ...q0[dupIdx],
      companyContext: merged,
      forceRefresh: !!forceRefresh || !!q0[dupIdx]?.forceRefresh
    };
    await swFinancialPrefetchSaveQueue(q0);
    void swFinancialPrefetchKick();
    swPrefetchLog('financial_prefetch_enqueue', {
      company_name: name,
      mode: forceRefresh ? 'upgrade-pending-refresh' : 'upgrade-pending',
      force_refresh: forceRefresh ? 1 : 0,
      ...swFinancialPrefetchContextLogFields(merged)
    });
    try {
      console.info('[Prospection SW] prefetch enqueue upgrade-pending:', name, forceRefresh ? 'refresh' : '');
    } catch (_) {}
    return { ok: true, mode: forceRefresh ? 'upgrade-pending-refresh' : 'upgrade-pending' };
  }

  const recent = await swFinancialPrefetchIsContextFingerprintRecent(key, safeCtx);
  if (recent.hit && !forceRefresh) {
    void swFinancialPrefetchKick();
    swPrefetchLog('financial_prefetch_enqueue', {
      company_name: name,
      mode: 'deduped-context',
      ...swFinancialPrefetchContextLogFields(safeCtx)
    });
    try {
      console.info('[Prospection SW] prefetch enqueue deduped-context:', name);
    } catch (_) {}
    return { ok: true, mode: 'deduped-context' };
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    companyName: name,
    companyContext: safeCtx,
    forceRefresh: !!forceRefresh,
    attempts: 0,
    enqueuedAt: Date.now()
  };

  const q = await swFinancialPrefetchLoadQueue();
  if (q.some((it) => swFinancialPrefetchNormalizeKey(it?.companyName) === key)) {
    void swFinancialPrefetchKick();
    swPrefetchLog('financial_prefetch_enqueue', {
      company_name: name,
      mode: 'deduped-pending',
      ...swFinancialPrefetchContextLogFields(safeCtx)
    });
    try {
      console.info('[Prospection SW] prefetch enqueue deduped-pending:', name);
    } catch (_) {}
    return { ok: true, mode: 'deduped-pending' };
  }

  q.push(item);
  await swFinancialPrefetchSaveQueue(q);
  await swFinancialPrefetchRememberContextFingerprint(key, recent.fp);
  void swFinancialPrefetchKick();
  swPrefetchLog('financial_prefetch_enqueue', {
    company_name: name,
    mode: forceRefresh ? 'enqueued-refresh' : 'enqueued',
    force_refresh: forceRefresh ? 1 : 0,
    ...swFinancialPrefetchContextLogFields(safeCtx)
  });
  try {
    console.info('[Prospection SW] prefetch enqueue enqueued:', name);
  } catch (_) {}
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

      if (await swHasFreshFinancialData(name) && !item?.forceRefresh) {
        q.shift();
        await swFinancialPrefetchSaveQueue(q);
        swPrefetchLog('financial_prefetch_worker', {
          company_name: name,
          mode: 'skip-cached',
          ...swFinancialPrefetchContextLogFields(item?.companyContext)
        });
        try {
          console.info('[Prospection SW] prefetch worker skip-cached:', name);
        } catch (_) {}
        await new Promise((r) => setTimeout(r, SW_FINANCIAL_PREFETCH_GAP_MS));
        continue;
      }

      try {
        await swGetFinancialData(name, !!item?.forceRefresh, item?.companyContext || null);
        swPrefetchLog('financial_prefetch_worker', {
          company_name: name,
          mode: item?.forceRefresh ? 'success-refresh' : 'success',
          force_refresh: item?.forceRefresh ? 1 : 0,
          ...swFinancialPrefetchContextLogFields(item?.companyContext)
        });
        try {
          console.info('[Prospection SW] prefetch worker success:', name);
        } catch (_) {}
      } catch (e) {
        const msgStr = String(e && e.message ? e.message : e);
        if (msgStr.startsWith('CONTEXTE_MATCH_INCOMPLET:')) {
          // Contexte incomplet : inutile de boucler — on drop.
          swPrefetchLog(
            'financial_prefetch_worker',
            { company_name: name, mode: 'drop-context', error: msgStr.slice(0, 500) },
            'warn'
          );
          try {
            console.warn('[Prospection SW] prefetch worker dropped (context):', name, msgStr);
          } catch (_) {}
        } else if (swFinancialPrefetchIsTransientErrorMessage(msgStr) && Number(item.attempts || 0) + 1 < SW_FINANCIAL_PREFETCH_MAX_ATTEMPTS) {
          item.attempts = Number(item.attempts || 0) + 1;
          q[0] = item;
          await swFinancialPrefetchSaveQueue(q);
          swPrefetchLog(
            'financial_prefetch_worker',
            { company_name: name, mode: 'retry', attempt: item.attempts, error: msgStr.slice(0, 500) },
            'warn'
          );
          try {
            console.warn('[Prospection SW] prefetch worker retry:', name, item.attempts, msgStr);
          } catch (_) {}
          await new Promise((r) => setTimeout(r, SW_FINANCIAL_PREFETCH_GAP_MS * 2));
          continue;
        } else {
          swPrefetchLog(
            'financial_prefetch_worker',
            { company_name: name, mode: 'drop', error: msgStr.slice(0, 500) },
            'warn'
          );
          try {
            console.warn('[Prospection SW] prefetch worker drop:', name, msgStr);
          } catch (_) {}
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

