/**
 * URL LinkedIn canonique par entreprise (table companies).
 * Écrite une seule fois (création ou premier scrape détail), puis figée.
 */

const SW_COMPANY_LINKEDIN_TABLE = 'companies';

function swNormalizeNameForUrlMatch(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function swNameTokensForUrlMatch(name) {
  const stop = new Set(['sa', 'sas', 'sarl', 'gmbh', 'inc', 'ltd', 'llc', 'group', 'groupe', 'the', 'and', 'de', 'la', 'le', 'les']);
  return swNormalizeNameForUrlMatch(name)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stop.has(t));
}

function swCompanySlugFromUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const m = new URL(s).pathname.match(/\/company\/([^/?#]+)/i);
    if (!m) return '';
    return decodeURIComponent(m[1]).replace(/-/g, ' ').toLowerCase();
  } catch {
    return '';
  }
}

/** Slug URL-encoded pour index / jointure (forme LinkedIn). */
function swLinkedinCompanySlugKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const m = new URL(s).pathname.match(/\/company\/([^/?#]+)/i);
    if (!m) return '';
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return '';
  }
}

function swNormalizeLinkedinCompanyUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('linkedin.com')) return '';
    const m = u.pathname.match(/^(\/company\/[^/?#]+)/i);
    if (!m) return '';
    return `https://www.linkedin.com${m[1].replace(/\/$/, '')}/`;
  } catch {
    return '';
  }
}

function swUrlMatchesCompanyName(url, companyName) {
  if (!swIsValidLinkedinCompanyUrl(url) || !String(companyName || '').trim()) return false;
  const slug = swCompanySlugFromUrl(url);
  const nameNorm = swNormalizeNameForUrlMatch(companyName);
  const slugNorm = swNormalizeNameForUrlMatch(slug);
  if (!slugNorm || !nameNorm) return false;
  if (slugNorm.includes(nameNorm) || nameNorm.includes(slugNorm)) return true;
  const nameTokens = swNameTokensForUrlMatch(companyName);
  const slugTokens = swNameTokensForUrlMatch(slug);
  if (!nameTokens.length || !slugTokens.length) return false;
  const overlap = nameTokens.filter((t) =>
    slugTokens.some((st) => st === t || st.startsWith(t) || t.startsWith(st))
  );
  if (overlap.length >= 1 && nameTokens.length <= 2) return true;
  if (overlap.length >= 1 && nameTokens[0].length >= 4) {
    if (slugTokens.some((st) => st.startsWith(nameTokens[0]) || nameTokens[0].startsWith(st))) {
      return true;
    }
  }
  return overlap.length >= Math.max(1, Math.ceil(nameTokens.length * 0.5));
}

function swExtractValidatedLinkedinUrlFromJobOffer(jobOffer, companyName) {
  const ld = jobOffer?.linkedinData && typeof jobOffer.linkedinData === 'object' ? jobOffer.linkedinData : {};
  const ci = ld.details?.companyInsight && typeof ld.details.companyInsight === 'object' ? ld.details.companyInsight : {};
  const candidates = [jobOffer?.companyLinkedinUrl, ld.companyLinkedinUrl, ci.companyLinkedinUrl]
    .map(swNormalizeLinkedinCompanyUrl)
    .filter(Boolean);
  const seen = new Set();
  for (const u of candidates) {
    if (seen.has(u)) continue;
    seen.add(u);
    if (swUrlMatchesCompanyName(u, companyName)) return u;
  }
  return null;
}

async function swFetchCompanyLinkedinFields(companyName) {
  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/${SW_COMPANY_LINKEDIN_TABLE}?company_name=eq.${encodeURIComponent(companyName)}&select=company_name,type,linkedin_company_url,linkedin_company_slug,linkedin_company_url_at,linkedin_company_url_source,financial_pipeline_cache&limit=1`,
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
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    console.warn('[Prospection SW] company linkedin url get:', e?.message || e);
    return null;
  }
}

async function swFetchCompanyByLinkedinSlug(slugKey) {
  const sk = String(slugKey || '').trim().toLowerCase();
  if (!sk) return null;
  const config = await loadConfig();
  const baseUrl = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!baseUrl || !key) return null;
  try {
    const res = await fetch(
      `${baseUrl}/rest/v1/${SW_COMPANY_LINKEDIN_TABLE}?linkedin_company_slug=eq.${encodeURIComponent(sk)}&select=company_name,type,linkedin_company_url,linkedin_company_slug&limit=1`,
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
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_) {
    return null;
  }
}

async function swClearLocalFinancialCacheEntry(companyName) {
  const key = swNormalizeCompanyKey(companyName);
  if (!key || typeof swGetFinancialCache !== 'function') return;
  try {
    const result = await chrome.storage.local.get(SW_FINANCIAL_CACHE_KEY);
    const cache = result[SW_FINANCIAL_CACHE_KEY] || {};
    if (cache[key]) {
      delete cache[key];
      await chrome.storage.local.set({ [SW_FINANCIAL_CACHE_KEY]: cache });
    }
  } catch (_) {}
}

function swFinancialCacheContextUrl(row) {
  const cache = row?.financial_pipeline_cache;
  const ctx = cache?.raw?.companyContext;
  return swNormalizeLinkedinCompanyUrl(ctx?.companyLinkedinUrl || '');
}

function swLinkedinUrlPatchFields(validatedUrl, source) {
  const slugKey = swLinkedinCompanySlugKey(validatedUrl);
  return {
    linkedin_company_url: validatedUrl,
    linkedin_company_slug: slugKey,
    linkedin_company_url_at: new Date().toISOString(),
    linkedin_company_url_source: source || 'job_scrape',
    updated_at: new Date().toISOString()
  };
}

async function swInsertCompanyWithLinkedinUrl(companyName, companyType, validatedUrl) {
  const config = await loadConfig();
  const baseUrl = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!baseUrl || !key) return { ok: false, error: 'supabase_non_configure' };
  if (!companyType || (companyType !== 'Client' && companyType !== 'SS2I')) {
    return { ok: false, error: 'type_introuvable' };
  }

  const body = sanitizeForPostgres({
    company_name: companyName,
    type: companyType,
    ...swLinkedinUrlPatchFields(validatedUrl, 'job_scrape_create')
  });

  try {
    const res = await fetch(`${baseUrl}/rest/v1/${SW_COMPANY_LINKEDIN_TABLE}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `insert ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, mode: 'insert' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Applique l'URL canonique companies au contexte prefetch / Gemini.
 */
function swApplyCanonicalCompanyUrl(companyName, ctx, canonicalUrl) {
  const normalized = swNormalizeLinkedinCompanyUrl(canonicalUrl);
  const base = ctx && typeof ctx === 'object' ? { ...ctx } : {};
  if (!normalized) return base;
  base.companyName = base.companyName || companyName;
  base.companyLinkedinUrl = normalized;
  base.linkedinUrlValidated = swUrlMatchesCompanyName(normalized, companyName);
  base.companyUrlSource = 'companies_canonical';
  base.matchContextVersion = Math.max(Number(base.matchContextVersion || 0), SW_MATCH_CONTEXT_VERSION);
  return base;
}

function swBuildFinancialContextFromJobOffer(jobOffer, companyName, canonicalUrl) {
  const ld = jobOffer?.linkedinData && typeof jobOffer.linkedinData === 'object' ? jobOffer.linkedinData : {};
  const ci = ld.details?.companyInsight && typeof ld.details.companyInsight === 'object' ? ld.details.companyInsight : {};
  const ctx = {
    matchContextVersion: SW_MATCH_CONTEXT_VERSION,
    companyName,
    jobTitle: jobOffer?.jobTitle || null,
    jobUrl: jobOffer?.jobUrl || null,
    jobLocation: jobOffer?.location || null,
    logoUrl: ci.logoUrl || ld.card?.logoUrl || null,
    logoAlt: ci.logoAlt || null,
    companyInsightName: ci.companyName || null,
    companyInsightAbout: ci.aboutSnippet || null,
    companyInsightEmployees: ci.employeesHint || null,
    companyInsightSource: ci.insightSource || null
  };
  return swApplyCanonicalCompanyUrl(companyName, ctx, canonicalUrl || jobOffer?.companyLinkedinUrl);
}

/**
 * Lors d'un scrape job détail :
 * - société absente → création + URL LinkedIn
 * - société présente sans URL → initialisation unique
 * - société avec URL déjà renseignée → figée (jamais écrasée au re-scrape)
 */
async function swEnsureCompanyLinkedinUrlFromJob(jobOffer, companyType) {
  const companyName = String(jobOffer?.companyName || '').trim();
  if (!companyName) return { ok: false, error: 'companyName manquant' };

  const detailScrapeDone =
    jobOffer?.stage === 'details' &&
    jobOffer?.detailsScrapedAt &&
    String(jobOffer?.descriptionText || '').trim().length > 0;
  if (!detailScrapeDone) return { ok: false, error: 'scrape_incomplet' };

  const validatedUrl = swExtractValidatedLinkedinUrlFromJobOffer(jobOffer, companyName);
  if (!validatedUrl) return { ok: false, error: 'url_non_validee' };

  const slugKey = swLinkedinCompanySlugKey(validatedUrl);
  let existing = await swFetchCompanyLinkedinFields(companyName);
  const prevUrl = swNormalizeLinkedinCompanyUrl(existing?.linkedin_company_url || '');

  // URL déjà figée sur cette société : ne jamais la modifier au re-scrape.
  if (prevUrl) {
    return {
      ok: true,
      mode: 'frozen',
      canonicalUrl: prevUrl,
      slug: swLinkedinCompanySlugKey(prevUrl),
      forceFinancialRefresh: false,
      urlChanged: false,
      companyExisted: true
    };
  }

  // Même URL LinkedIn déjà rattachée à une autre ligne companies (clé slug).
  if (slugKey) {
    const bySlug = await swFetchCompanyByLinkedinSlug(slugKey);
    if (bySlug?.linkedin_company_url) {
      const otherName = String(bySlug.company_name || '').trim();
      if (otherName && otherName !== companyName) {
        return {
          ok: false,
          error: 'linkedin_slug_deja_utilise',
          existingCompanyName: otherName,
          canonicalUrl: swNormalizeLinkedinCompanyUrl(bySlug.linkedin_company_url)
        };
      }
    }
  }

  const config = await loadConfig();
  const baseUrl = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!baseUrl || !key) return { ok: false, error: 'supabase_non_configure' };

  // Société inexistante : création avec URL (type requis).
  if (!existing) {
    const inserted = await swInsertCompanyWithLinkedinUrl(companyName, companyType, validatedUrl);
    if (!inserted.ok) return inserted;
    return {
      ok: true,
      mode: 'created',
      canonicalUrl: validatedUrl,
      slug: slugKey,
      forceFinancialRefresh: true,
      urlChanged: true,
      companyExisted: false
    };
  }

  // Société existante sans URL : écriture unique.
  const cacheCtxUrl = swFinancialCacheContextUrl(existing);
  const shouldInvalidateFinancial =
    !!existing?.financial_pipeline_cache && !!cacheCtxUrl && cacheCtxUrl !== validatedUrl;

  const patch = swLinkedinUrlPatchFields(validatedUrl, 'job_scrape_init');

  if (shouldInvalidateFinancial) {
    patch.financial_pipeline_cache = null;
    patch.financial_pipeline_cache_at = null;
    patch.unified_payload = null;
    patch.llm_payload = null;
    patch.llm_updated_at = null;
    patch.llm_confidence = null;
    patch.mode = null;
    patch.score = null;
    patch.confidence = null;
    await swClearLocalFinancialCacheEntry(companyName);
  }

  try {
    const res = await fetch(
      `${baseUrl}/rest/v1/${SW_COMPANY_LINKEDIN_TABLE}?company_name=eq.${encodeURIComponent(companyName)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(sanitizeForPostgres(patch))
      }
    );
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `patch ${res.status}: ${text.slice(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  return {
    ok: true,
    mode: 'initialized',
    canonicalUrl: validatedUrl,
    slug: slugKey,
    forceFinancialRefresh: shouldInvalidateFinancial,
    urlChanged: true,
    companyExisted: true
  };
}

/** @deprecated alias — préférer swEnsureCompanyLinkedinUrlFromJob */
async function swPromoteCompanyLinkedinUrlFromJob(jobOffer, companyType) {
  return swEnsureCompanyLinkedinUrlFromJob(jobOffer, companyType);
}

async function swGetCanonicalCompanyLinkedinUrl(companyName) {
  const row = await swFetchCompanyLinkedinFields(companyName);
  return swNormalizeLinkedinCompanyUrl(row?.linkedin_company_url || '');
}

async function swMergeCanonicalUrlIntoContext(companyName, ctx) {
  const canonical = await swGetCanonicalCompanyLinkedinUrl(companyName);
  if (!canonical) return ctx;
  return swApplyCanonicalCompanyUrl(companyName, ctx, canonical);
}
