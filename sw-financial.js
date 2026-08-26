/**
 * Cache financier + getFinancialData + HubSpot CRM (dock).
 * S'appuie sur loadConfig() défini dans background.js ; importé après financial-gemini-context.js.
 */
const SW_FINANCIAL_CACHE_KEY = 'financialCache';
const SW_FINANCIAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SW_FINANCIAL_NO_DATA_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const SW_FINANCIAL_SCHEMA_VERSION = 2;
/** Le détail LLM complet est sur Supabase — ici on ne garde que l’affichage + meta. */
const SW_FINANCIAL_CACHE_MAX_ENTRIES = 80;

const HUBSPOT_EU_BASE = 'https://api-eu1.hubapi.com';
const HUBSPOT_US_BASE = 'https://api.hubapi.com';

function swNormalizeCompanyKey(companyName) {
  return (companyName || '').trim().toLowerCase();
}

async function swGetFinancialCache(companyName) {
  const key = swNormalizeCompanyKey(companyName);
  if (!key) return null;
  const result = await chrome.storage.local.get(SW_FINANCIAL_CACHE_KEY);
  const cache = result[SW_FINANCIAL_CACHE_KEY] || {};
  return cache[key] || null;
}

async function swSetFinancialCache(companyName, entry) {
  const key = swNormalizeCompanyKey(companyName);
  if (!key) return;
  const result = await chrome.storage.local.get(SW_FINANCIAL_CACHE_KEY);
  const cache = result[SW_FINANCIAL_CACHE_KEY] || {};
  cache[key] = swSanitizeFinancialEntryForLocalCache(entry);
  swPruneFinancialCacheObject(cache);
  try {
    await chrome.storage.local.set({ [SW_FINANCIAL_CACHE_KEY]: cache });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (!/quota|kquotabytes|quotaexceeded/i.test(msg)) throw e;
    const pairs = Object.entries(cache).sort(
      (a, b) => Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0)
    );
    const reduced = Object.fromEntries(
      pairs.slice(0, Math.max(40, Math.floor(SW_FINANCIAL_CACHE_MAX_ENTRIES / 3)))
    );
    try {
      await chrome.storage.local.set({ [SW_FINANCIAL_CACHE_KEY]: reduced });
    } catch (_) {
      if (typeof self.pnExtensionStorageRotateHeavy === 'function') {
        await self.pnExtensionStorageRotateHeavy('quota_financial_cache', {
          force: true,
          cacheCap: 28
        });
      }
      const minimal = Object.fromEntries(pairs.slice(0, 18));
      await chrome.storage.local.set({ [SW_FINANCIAL_CACHE_KEY]: minimal });
    }
  }
}

function swPickUnifiedForCache(unified) {
  if (!unified || typeof unified !== 'object') return null;
  return {
    mode: unified.mode ?? null,
    financials: unified.financials ?? null,
    signals: unified.signals ?? null,
    score: unified.score ?? null,
    confidence: unified.confidence ?? null,
    sources: Array.isArray(unified.sources) ? unified.sources.slice(0, 8) : [],
    partial: !!unified.partial,
    score_breakdown: unified.score_breakdown ?? null,
    generated_at: unified.generated_at ?? null
  };
}

function swSanitizeFinancialContextForCache(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return {
    matchContextVersion: ctx.matchContextVersion ?? null,
    companyName: ctx.companyName ?? null,
    logoUrl: ctx.logoUrl ?? null,
    logoAlt: ctx.logoAlt ?? null,
    companyLinkedinUrl: ctx.companyLinkedinUrl ?? null,
    jobUrl: ctx.jobUrl ?? null,
    jobLocation: ctx.jobLocation ?? null,
    companyInsightName: ctx.companyInsightName ?? null,
    companyInsightAbout: ctx.companyInsightAbout ?? null,
    companyInsightEmployees: ctx.companyInsightEmployees ?? null,
    companyInsightSource: ctx.companyInsightSource ?? null,
    logoInlineSkipped: !!ctx.logoInlineSkipped
  };
}

function swSanitizeFinancialEntryForLocalCache(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const raw = e.raw && typeof e.raw === 'object' ? e.raw : {};
  return {
    schemaVersion: Number(e.schemaVersion || SW_FINANCIAL_SCHEMA_VERSION),
    data: e.data ?? null,
    unified: swPickUnifiedForCache(e.unified || null),
    updatedAt: Number(e.updatedAt || Date.now()),
    symbol: e.symbol ?? null,
    companySummary: e.companySummary ?? null,
    raw: {
      companyContext: swSanitizeFinancialContextForCache(raw.companyContext || null),
      llmExtraction: null,
      debug: raw.debug || null
    }
  };
}

function swPruneFinancialCacheObject(cache) {
  const keys = Object.keys(cache || {});
  if (keys.length <= SW_FINANCIAL_CACHE_MAX_ENTRIES) return;
  const pairs = keys
    .map((k) => [k, cache[k]])
    .sort((a, b) => Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0));
  const keep = new Set(pairs.slice(0, SW_FINANCIAL_CACHE_MAX_ENTRIES).map((x) => x[0]));
  for (const k of keys) {
    if (!keep.has(k)) delete cache[k];
  }
}

function swGetEntrySchemaVersion(entryLike) {
  const e = entryLike && typeof entryLike === 'object' ? entryLike : {};
  const direct = Number(e.schemaVersion ?? e.schema_version);
  if (Number.isFinite(direct) && direct > 0) return direct;
  return 1;
}

function swIsCurrentFinancialSchema(entryLike) {
  return swGetEntrySchemaVersion(entryLike) >= SW_FINANCIAL_SCHEMA_VERSION;
}

/** Lecture legacy : entrées sans schemaVersion 2 mais encore exploitables (données déjà analysées avant migration). */
function swIsReadableFinancialSchema(entryLike) {
  if (swIsCurrentFinancialSchema(entryLike)) return true;
  const e = entryLike && typeof entryLike === 'object' ? entryLike : {};
  const dbg = e.raw?.debug && typeof e.raw.debug === 'object' ? e.raw.debug : {};
  if (dbg.noUsableFinancialData === true) return true;
  const unified = e.unified || null;
  return swHasUsableFinancialData(e.data, unified);
}

function swNumericFromFinancialField(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && v !== null && Number.isFinite(Number(v.value))) return Number(v.value);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function swHasUsableFinancialData(data, unified) {
  const d = data && typeof data === 'object' ? data : {};
  const u = unified && typeof unified === 'object' ? unified : {};
  const f = u.financials && typeof u.financials === 'object' ? u.financials : {};
  const picks = [
    d.revenue,
    d.market_cap,
    d.employees,
    d.revenue_per_employee,
    d.ebitda_margin,
    d.net_margin,
    d.gross_margin,
    d.revenue_growth,
    f.revenue,
    f.market_cap,
    f.employees,
    f.revenue_per_employee,
    f.ebitda_margin,
    f.net_margin,
    f.gross_margin,
    f.revenue_growth
  ];
  return picks.some((v) => swNumericFromFinancialField(v) != null);
}

function swIsFreshFinancialEntry(entryLike, updatedAtMs, unifiedOverride = null) {
  if (!updatedAtMs || Number.isNaN(Number(updatedAtMs))) return false;
  const ageMs = Date.now() - Number(updatedAtMs);
  if (ageMs > SW_FINANCIAL_CACHE_TTL_MS) return false;

  const e = entryLike && typeof entryLike === 'object' ? entryLike : {};
  if (!swIsReadableFinancialSchema(e)) return false;
  const unified = unifiedOverride || e?.unified || null;
  if (swHasUsableFinancialData(e?.data, unified)) return true;

  const debug = e?.raw?.debug && typeof e.raw.debug === 'object' ? e.raw.debug : null;
  if (debug?.noUsableFinancialData === true && ageMs <= SW_FINANCIAL_NO_DATA_TTL_MS) {
    return true;
  }
  return false;
}

/**
 * Données financières déjà présentes et encore valides (même règles que les courts-circuits de swGetFinancialData).
 * Utilisé par la file de préfetch pour éviter tout appel pipeline / Gemini inutile.
 */
async function swHasFreshFinancialData(companyName) {
  const key = swNormalizeCompanyKey(companyName);
  if (!key) return false;
  const cached = await swGetFinancialCache(companyName);
  if (swIsFreshFinancialEntry(cached, cached?.updatedAt, cached?.unified || null)) {
    return true;
  }
  const supabaseFinancial = await swGetFinancialFromSupabase(companyName);
  const payload = supabaseFinancial?.financial_pipeline_cache;
  const updatedAtIso = supabaseFinancial?.financial_pipeline_cache_at;
  const updatedAt = updatedAtIso ? new Date(updatedAtIso).getTime() : null;
  const payloadEntry = payload
    ? {
      ...payload,
      schemaVersion: Number(payload?.schemaVersion || payload?.schema_version || 1),
      unified: supabaseFinancial?.unified_payload || payload?.unified || null
    }
    : null;
  if (swIsFreshFinancialEntry(payloadEntry, updatedAt, payloadEntry?.unified || null)) {
    return true;
  }
  return false;
}

function swFinancialContextHasRichInsight(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const about = String(c.companyInsightAbout || '').trim();
  return about.length >= 80 || !!String(c.companyInsightEmployees || '').trim();
}

function swFinancialContextFromCacheEntry(entry) {
  const raw = entry?.raw && typeof entry.raw === 'object' ? entry.raw : {};
  return raw.companyContext && typeof raw.companyContext === 'object' ? raw.companyContext : null;
}

/**
 * Re-prefetch si le nouveau contexte (encart entreprise) est plus riche que le cache existant.
 */
async function swShouldForceFinancialRefresh(companyName, newCtx) {
  if (typeof swGetCanonicalCompanyLinkedinUrl === 'function') {
    const canonical = await swGetCanonicalCompanyLinkedinUrl(companyName);
    if (canonical) {
      const cached = await swGetFinancialCache(companyName);
      let oldCtx = swFinancialContextFromCacheEntry(cached);
      if (!oldCtx) {
        const supabaseFinancial = await swGetFinancialFromSupabase(companyName);
        oldCtx = swFinancialContextFromCacheEntry(supabaseFinancial?.financial_pipeline_cache);
      }
      const oldUrl =
        typeof swNormalizeLinkedinCompanyUrl === 'function'
          ? swNormalizeLinkedinCompanyUrl(String(oldCtx?.companyLinkedinUrl || ''))
          : String(oldCtx?.companyLinkedinUrl || '').trim();
      if (!oldUrl || oldUrl !== canonical) return true;
    }
  }

  if (!newCtx || typeof newCtx !== 'object') return false;
  if (!swFinancialContextHasRichInsight(newCtx)) return false;

  const cached = await swGetFinancialCache(companyName);
  let oldCtx = swFinancialContextFromCacheEntry(cached);
  if (!oldCtx) {
    const supabaseFinancial = await swGetFinancialFromSupabase(companyName);
    const payload = supabaseFinancial?.financial_pipeline_cache;
    oldCtx = swFinancialContextFromCacheEntry(payload);
  }
  if (!oldCtx) return true;
  if (!swFinancialContextHasRichInsight(oldCtx)) return true;

  const newAbout = String(newCtx.companyInsightAbout || '').trim().length;
  const oldAbout = String(oldCtx.companyInsightAbout || '').trim().length;
  if (newAbout > oldAbout + 50) return true;

  const newUrl = String(newCtx.companyLinkedinUrl || '').trim();
  const oldUrl = String(oldCtx.companyLinkedinUrl || '').trim();
  if (newUrl && newUrl !== oldUrl && newCtx.companyUrlSource === 'insight_card') return true;

  return false;
}

function swHarmonizeUnifiedFinancials(unified) {
  if (!unified?.financials || typeof self.llmFinancialHarmonize !== 'function') return unified;
  return {
    ...unified,
    financials: self.llmFinancialHarmonize(unified.financials)
  };
}

function swAttachScoreBreakdownIfNeeded(unified) {
  if (!unified) return null;
  const harmonized = swHarmonizeUnifiedFinancials(unified);
  if (!harmonized.financials) return harmonized;
  if (harmonized.score_breakdown && harmonized.score_breakdown.model_version === 4) return harmonized;
  try {
    const bd = self.scoring.computeScoreBreakdown(harmonized);
    return {
      ...harmonized,
      score: bd.score,
      score_breakdown: bd,
      confidence: self.scoring.computeConfidence({ ...harmonized, score: bd.score, score_breakdown: bd })
    };
  } catch (_) {
    return harmonized;
  }
}

async function swGetFinancialData(companyName, forceRefresh = false, companyContext = null) {
  const config = await loadConfig();
  const openRouterApiKey = orResolveApiKey(config);
  if (!openRouterApiKey) {
    throw new Error('Configure la clé API OpenRouter dans la popup pour les indicateurs financiers.');
  }

  const cached = await swGetFinancialCache(companyName);
  if (!forceRefresh && swIsFreshFinancialEntry(cached, cached?.updatedAt, cached?.unified || null)) {
    let companySummary = cached.companySummary ?? null;
    if (!companySummary) {
      companySummary = await swEnsureCompanySummaryCached(
        companyName,
        companyContext,
        openRouterApiKey,
        cached
      );
    }
    const u = swAttachScoreBreakdownIfNeeded(cached.unified || null);
    return {
      data: cached.data,
      fromCache: true,
      supabase: { ok: true, mode: 'cache' },
      unified: u,
      mode: u?.mode || null,
      score: u?.score ?? null,
      confidence: u?.confidence ?? null,
      sources: u?.sources || [],
      partial: !!u?.partial,
      companySummary: companySummary || null
    };
  }

  if (!forceRefresh) {
    const supabaseFinancial = await swGetFinancialFromSupabase(companyName);
    const payload = supabaseFinancial?.financial_pipeline_cache;
    const updatedAtIso = supabaseFinancial?.financial_pipeline_cache_at;
    const updatedAt = updatedAtIso ? new Date(updatedAtIso).getTime() : null;
    const rawUnified = supabaseFinancial?.unified_payload || payload?.unified || null;
    const payloadEntry = payload
      ? {
        ...payload,
        schemaVersion: Number(payload?.schemaVersion || payload?.schema_version || 1),
        unified: rawUnified
      }
      : null;
    if (swIsFreshFinancialEntry(payloadEntry, updatedAt, rawUnified)) {
      let companySummary = payload.companySummary ?? null;
      if (!companySummary) {
        companySummary = await swEnsureCompanySummaryCached(
          companyName,
          companyContext,
          openRouterApiKey,
          payload
        );
      }
      await swSetFinancialCache(companyName, { ...payload, companySummary: companySummary || null });
      const u = swAttachScoreBreakdownIfNeeded(rawUnified);
      return {
        data: payload.data,
        fromCache: true,
        symbol: null,
        supabase: { ok: true, mode: 'read' },
        unified: u,
        mode: supabaseFinancial?.mode || u?.mode || null,
        score: supabaseFinancial?.score ?? u?.score ?? null,
        confidence: supabaseFinancial?.confidence ?? u?.confidence ?? null,
        sources: u?.sources || payload.unified?.sources || [],
        partial: !!(supabaseFinancial?.unified_payload?.partial ?? u?.partial ?? payload.unified?.partial),
        companySummary: companySummary || null,
        llm: {
          attempted: !!payload?.raw?.debug?.llmAttempted,
          articlesCount: 0,
          extracted: !!payload?.raw?.llmExtraction,
          error: payload?.raw?.debug?.llmError || null,
          pipeline: payload?.raw?.debug?.pipeline || null
        }
      };
    }
  }

  if (typeof swMergeCanonicalUrlIntoContext === 'function') {
    companyContext = await swMergeCanonicalUrlIntoContext(companyName, companyContext);
  }

  const matchCheck = swValidateMatchContext(companyContext);
  if (!matchCheck.ok) {
    throw new Error('CONTEXTE_MATCH_INCOMPLET:' + JSON.stringify({ missing: matchCheck.missing }));
  }

  const pipeline = await self.financialPipeline.runAdaptiveFinancialPipeline(
    companyName,
    {
      openRouterApiKey,
      geminiApiKey: openRouterApiKey,
      extractFinancialFromCompanyContext,
      extractFinancialWithGemini: null
    },
    companyContext || null
  );

  const unified = pipeline.unified;
  const mapped = {
    score: unified.score,
    revenue: unified.financials?.revenue ?? null,
    ebitda_margin: unified.financials?.ebitda_margin ?? null,
    net_margin: unified.financials?.net_margin ?? null,
    gross_margin: unified.financials?.gross_margin ?? null,
    revenue_growth: unified.financials?.revenue_growth ?? null,
    revenue_per_employee: unified.financials?.revenue_per_employee ?? null
  };

  const llmRaw = pipeline?.raw?.llm || {};
  const identificationNotes =
    typeof llmRaw.identification_notes === 'string' ? llmRaw.identification_notes : '';
  const identifiedCompanyName =
    typeof llmRaw.identified_company_name === 'string' ? llmRaw.identified_company_name.trim() : '';

  let companySummary = null;
  try {
    companySummary = await swFetchCompanySummary(
      companyName,
      companyContext,
      openRouterApiKey,
      identificationNotes,
      identifiedCompanyName
    );
  } catch (e) {
    console.warn('[Prospection SW] Résumé entreprise (pipeline):', e?.message || e);
  }

  const entry = {
    schemaVersion: SW_FINANCIAL_SCHEMA_VERSION,
    data: mapped,
    unified,
    updatedAt: Date.now(),
    symbol: null,
    companySummary: companySummary || null,
    raw: {
      companyContext: pipeline?.raw?.companyContext || null,
      llmExtraction: pipeline?.raw?.llm || null,
      debug: {
        ...(pipeline?.raw?.debug || {}),
        noUsableFinancialData:
          !swHasUsableFinancialData(mapped, unified) &&
          !!pipeline?.raw?.debug?.llmAttempted &&
          !pipeline?.raw?.debug?.llmError
      }
    }
  };
  await swSetFinancialCache(companyName, entry);

  const supabaseWrite = await swUpsertFinancialToSupabase(companyName, entry);
  if (!supabaseWrite.ok) {
    console.warn('[Prospection SW] Supabase financial write KO:', supabaseWrite.error);
  }

  return {
    data: mapped,
    fromCache: false,
    symbol: null,
    supabase: supabaseWrite,
    mode: unified.mode,
    score: unified.score,
    confidence: unified.confidence,
    sources: unified.sources,
    partial: !!unified.partial,
    companySummary: companySummary || null,
    reason: unified.partial ? 'Données incomplètes ou proxy.' : null,
    llm: {
      attempted: !!pipeline?.raw?.debug?.llmAttempted,
      articlesCount: 0,
      extracted: !!pipeline?.raw?.llm,
      error: pipeline?.raw?.debug?.llmError || null,
      pipeline: pipeline?.raw?.debug?.pipeline || null
    },
    unified
  };
}

function swGetHubspotAuth(apiKey) {
  const key = String(apiKey || '').replace(/\s+/g, ' ').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (key) {
    // CRM v3 : uniquement Authorization Bearer. Les jetons d’app privée commencent souvent par pat-,
    // mais d’autres jetons (OAuth, « accès personnel », etc.) n’ont pas ce préfixe — on envoie toujours Bearer.
    headers.Authorization = `Bearer ${key}`;
  }
  return { headers, qs: '' };
}

async function swHubspotApi(path, method, body, auth) {
  const { headers, qs } = auth;
  const payload = body ? JSON.stringify(body) : undefined;
  let res = await fetch(`${HUBSPOT_EU_BASE}${path}${qs}`, { method, headers, body: payload });
  if (res.status === 401) {
    res = await fetch(`${HUBSPOT_US_BASE}${path}${qs}`, { method, headers, body: payload });
  }
  return res;
}

async function swSearchHubSpotCompanyByName(companyName, auth) {
  const searchBody = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'name',
            operator: 'EQ',
            value: companyName.trim()
          }
        ]
      }
    ],
    properties: ['name'],
    limit: 1
  };
  const res = await swHubspotApi('/crm/v3/objects/companies/search', 'POST', searchBody, auth);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.results?.[0]?.id ?? null;
}

async function swCheckHubSpotCompany(companyName) {
  const config = await loadConfig();
  const apiKey = config.hubspotApiKey;
  if (!apiKey) return { exists: false, configured: false };
  const auth = swGetHubspotAuth(apiKey);
  const id = await swSearchHubSpotCompanyByName(companyName, auth);
  return { exists: !!id, id: id || undefined, configured: true };
}

async function swAddToHubSpot(companyName, type, jobTitle, jobUrl) {
  const config = await loadConfig();
  const apiKey = config.hubspotApiKey;
  if (!apiKey) {
    throw new Error('Clé API HubSpot non configurée. Configure-la dans la popup.');
  }

  let description = [`Type prospection: ${type}`, jobTitle ? `Offre: ${jobTitle}` : '', jobUrl ? `URL: ${jobUrl}` : '']
    .filter(Boolean)
    .join('\n');
  const MIN_DESCRIPTION_LENGTH = 140;
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    description +=
      '\n\n' +
      'Prospect LinkedIn Jobs — entreprise identifiée via extension de prospection.'.slice(
        0,
        MIN_DESCRIPTION_LENGTH - description.length - 2
      );
    description = description.slice(0, Math.max(description.length, MIN_DESCRIPTION_LENGTH));
  }

  const auth = swGetHubspotAuth(apiKey);
  const existingId = await swSearchHubSpotCompanyByName(companyName, auth);

  let res;
  if (existingId) {
    res = await swHubspotApi(
      `/crm/v3/objects/companies/${existingId}`,
      'PATCH',
      { properties: { description } },
      auth
    );
  } else {
    res = await swHubspotApi(
      '/crm/v3/objects/companies',
      'POST',
      { properties: { name: companyName, description } },
      auth
    );
  }

  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      const json = JSON.parse(text);
      if (json.message) msg = json.message;
    } catch (_) {}
    throw new Error(msg.slice(0, 200));
  }
  const data = await res.json();
  return { id: data?.id, updated: !!existingId };
}
