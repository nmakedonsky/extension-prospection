/**
 * Cache financier + getFinancialData + HubSpot CRM (dock).
 * S'appuie sur loadConfig() défini dans background.js ; importé après financial-gemini-context.js.
 */
const SW_FINANCIAL_CACHE_KEY = 'financialCache';
const SW_FINANCIAL_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

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
  cache[key] = entry;
  await chrome.storage.local.set({ [SW_FINANCIAL_CACHE_KEY]: cache });
}

function swAttachScoreBreakdownIfNeeded(unified) {
  if (!unified) return null;
  if (!unified.financials) return unified;
  if (unified.score_breakdown && unified.score_breakdown.model_version === 4) return unified;
  try {
    const bd = self.scoring.computeScoreBreakdown(unified);
    return {
      ...unified,
      score: bd.score,
      score_breakdown: bd,
      confidence: self.scoring.computeConfidence({ ...unified, score: bd.score, score_breakdown: bd })
    };
  } catch (_) {
    return unified;
  }
}

async function swGetFinancialData(companyName, forceRefresh = false, companyContext = null) {
  const config = await loadConfig();
  const geminiApiKey = config.geminiApiKey;
  if (!geminiApiKey) {
    throw new Error('Configure la clé API Gemini dans la popup pour les indicateurs financiers.');
  }

  const cached = await swGetFinancialCache(companyName);
  if (!forceRefresh && cached?.updatedAt && Date.now() - cached.updatedAt < SW_FINANCIAL_CACHE_TTL_MS) {
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
      partial: !!u?.partial
    };
  }

  const pipeline = await self.financialPipeline.runAdaptiveFinancialPipeline(
    companyName,
    {
      geminiApiKey,
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

  const entry = {
    data: mapped,
    unified,
    updatedAt: Date.now(),
    symbol: null,
    raw: {
      companyContext: pipeline?.raw?.companyContext || null,
      llmExtraction: pipeline?.raw?.llm || null,
      debug: pipeline?.raw?.debug || null
    }
  };
  await swSetFinancialCache(companyName, entry);

  return {
    data: mapped,
    fromCache: false,
    symbol: null,
    supabase: { ok: true, mode: 'local' },
    mode: unified.mode,
    score: unified.score,
    confidence: unified.confidence,
    sources: unified.sources,
    partial: !!unified.partial,
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
  const useBearer = /^pat-/.test(key) || key.length > 40;
  const headers = { 'Content-Type': 'application/json' };
  if (useBearer) headers.Authorization = `Bearer ${key}`;
  const qs = useBearer ? '' : `?hapikey=${encodeURIComponent(key)}`;
  return { headers, qs };
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
