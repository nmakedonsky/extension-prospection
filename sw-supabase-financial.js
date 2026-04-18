/**
 * Lecture / écriture enrichissement financier (table companies, JSONB).
 * S’appuie sur loadConfig() (background.js) et getOrClassifyCompany (background.js) à l’exécution.
 */
const SW_SUPABASE_COMPANIES_TABLE = 'companies';

/** Schéma extensible financial_providers (JSONB) — incrémenter si la forme des blocs change */
const FINANCIAL_PROVIDERS_SCHEMA_VERSION = 1;

function sanitizeForPostgres(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForPostgres(item));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      out[k] = sanitizeForPostgres(v);
    });
    return out;
  }
  return value;
}

function buildFinancialProvidersFromEntry(entry) {
  const ts = entry?.updatedAt ? new Date(entry.updatedAt).toISOString() : new Date().toISOString();
  const raw = entry?.raw || {};
  const llmOk = !!raw.llmExtraction;

  return {
    _schema_version: FINANCIAL_PROVIDERS_SCHEMA_VERSION,
    financialmodelingprep: {
      provider_id: 'financialmodelingprep',
      label: 'Financial Modeling Prep',
      fetched_at: ts,
      status: 'not_used',
      data: { note: 'Désactivé : pipeline Gemini uniquement (contexte carte job).' }
    },
    brave_search: {
      provider_id: 'brave_search',
      label: 'Brave Search',
      fetched_at: ts,
      status: 'not_used',
      data: { note: 'Désactivé : pas d’appel API web.' }
    },
    gemini_financial_extraction: {
      provider_id: 'google_gemini',
      label: 'Gemini (extraction financière)',
      fetched_at: ts,
      status: llmOk ? 'ok' : 'skipped',
      data: raw.llmExtraction || null
    }
  };
}

function mergeFinancialProviders(existing, fromEntry) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const built = buildFinancialProvidersFromEntry(fromEntry);
  return sanitizeForPostgres({ ...base, ...built });
}

async function swGetFinancialFromSupabase(companyName) {
  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) return null;

  try {
    const res = await fetch(
      `${url}/rest/v1/${SW_SUPABASE_COMPANIES_TABLE}?company_name=eq.${encodeURIComponent(companyName)}&select=fmp_payload,fmp_updated_at,mode,unified_payload,score,confidence,sources_count,financial_providers&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        }
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] || null;
  } catch (e) {
    console.warn('[Prospection SW] Supabase financial get:', e?.message || e);
    return null;
  }
}

/**
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
async function swUpsertFinancialToSupabase(companyName, entry) {
  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) {
    return { ok: false, error: 'Supabase non configuré (URL + clé anon)' };
  }

  try {
    const existing = await fetch(
      `${url}/rest/v1/${SW_SUPABASE_COMPANIES_TABLE}?company_name=eq.${encodeURIComponent(companyName)}&select=company_name,type,financial_providers&limit=1`,
      {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        }
      }
    );
    if (!existing.ok) {
      const text = await existing.text();
      return { ok: false, error: `lookup ${existing.status}: ${text.slice(0, 200)}` };
    }
    const rows = await existing.json();
    const hasRow = Array.isArray(rows) && rows.length > 0;
    const existingProviders = hasRow ? rows[0].financial_providers : null;

    const llmBlob = entry?.raw?.llmExtraction ?? null;
    const financialFields = {
      fmp_payload: sanitizeForPostgres(entry),
      fmp_updated_at: new Date(entry.updatedAt).toISOString(),
      fmp_provider: 'google_gemini',
      fmp_status: 'ok',
      llm_payload: sanitizeForPostgres(llmBlob),
      llm_updated_at: llmBlob ? new Date(entry.updatedAt).toISOString() : null,
      llm_confidence: Number.isFinite(Number(llmBlob?.confidence ?? llmBlob?.globalConfidence))
        ? Number(llmBlob?.confidence ?? llmBlob?.globalConfidence)
        : null,
      llm_sources_count: llmBlob ? 1 : 0,
      mode: entry?.unified?.mode || null,
      unified_payload: sanitizeForPostgres(entry?.unified || null),
      score: Number.isFinite(Number(entry?.unified?.score)) ? Number(entry?.unified?.score) : null,
      confidence: Number.isFinite(Number(entry?.unified?.confidence)) ? Number(entry?.unified?.confidence) : null,
      sources_count: Array.isArray(entry?.unified?.sources) ? entry.unified.sources.length : 0,
      financial_providers: mergeFinancialProviders(existingProviders, entry),
      updated_at: new Date().toISOString()
    };

    const patchRes = await fetch(
      `${url}/rest/v1/${SW_SUPABASE_COMPANIES_TABLE}?company_name=eq.${encodeURIComponent(companyName)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(financialFields)
      }
    );
    if (hasRow && patchRes.ok) return { ok: true, mode: 'patch' };

    if (!hasRow) {
      const resolveType =
        typeof getOrClassifyCompany === 'function' ? getOrClassifyCompany : async () => null;
      const detectedType = await resolveType(companyName);
      if (!detectedType) {
        return { ok: false, error: 'insert bloqué: type introuvable pour cette entreprise' };
      }
      const insertRes = await fetch(`${url}/rest/v1/${SW_SUPABASE_COMPANIES_TABLE}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          company_name: companyName,
          type: detectedType,
          ...financialFields
        })
      });
      if (insertRes.ok) return { ok: true, mode: 'insert' };
      const insertText = await insertRes.text();
      return { ok: false, error: `insert ${insertRes.status}: ${insertText.slice(0, 200)}` };
    }

    const patchText = await patchRes.text();
    return { ok: false, error: `patch ${patchRes.status}: ${patchText.slice(0, 200)}` };
  } catch (e) {
    console.warn('[Prospection SW] Supabase financial upsert:', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}
