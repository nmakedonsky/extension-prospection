/**
 * Cache local + upsert table saved_jobs (offres LinkedIn).
 * S’appuie sur loadConfig, getOrClassifyCompany, upsertCompanyToSupabase (background.js)
 * et sanitizeForPostgres (sw-supabase-financial.js).
 */
const SW_SUPABASE_JOBS_TABLE = 'saved_jobs';
const STORAGE_KEY_JOB_OFFERS = 'pnJobOffersCache';
const FORCE_RESCRAPE_CUTOFF_ISO = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

function normalizeTextKey(value) {
  return String(value || '').trim().toLowerCase();
}

function buildJobOfferStorageKey(jobOffer) {
  return normalizeTextKey(jobOffer?.linkedinJobId || jobOffer?.jobUrl || `${jobOffer?.companyName || ''}::${jobOffer?.jobTitle || ''}`);
}

async function swGetJobOffersCache() {
  const result = await chrome.storage.local.get(STORAGE_KEY_JOB_OFFERS);
  return result[STORAGE_KEY_JOB_OFFERS] || {};
}

function swMergeLinkedinData(existingData, incomingData) {
  return sanitizeForPostgres({
    ...(existingData || {}),
    ...(incomingData || {}),
    card: {
      ...((existingData && existingData.card) || {}),
      ...((incomingData && incomingData.card) || {})
    },
    details: {
      ...((existingData && existingData.details) || {}),
      ...((incomingData && incomingData.details) || {})
    }
  });
}

async function swSaveJobOfferLocally(jobOffer) {
  const key = buildJobOfferStorageKey(jobOffer);
  if (!key) return { ok: false, error: 'Job offer key introuvable' };
  const cache = await swGetJobOffersCache();
  const existing = cache[key] || {};
  cache[key] = sanitizeForPostgres({
    ...existing,
    ...jobOffer,
    companyType: jobOffer?.companyType || existing?.companyType || null,
    location: jobOffer?.location || existing?.location || null,
    descriptionText: jobOffer?.descriptionText || existing?.descriptionText || null,
    firstSeenAt: existing?.firstSeenAt || jobOffer?.seenAt || new Date().toISOString(),
    lastSeenAt: jobOffer?.seenAt || existing?.lastSeenAt || new Date().toISOString(),
    detailsScrapedAt: jobOffer?.detailsScrapedAt || existing?.detailsScrapedAt || null,
    linkedinData: swMergeLinkedinData(existing?.linkedinData, jobOffer?.linkedinData || {
      card: jobOffer?.cardData || null
    }),
    updatedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({ [STORAGE_KEY_JOB_OFFERS]: cache });
  return { ok: true, key };
}

async function swUpsertJobOfferToSupabase(jobOffer) {
  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) {
    return { ok: false, error: 'Supabase non configuré (URL + clé anon)' };
  }

  const trimmedCompanyName = String(jobOffer?.companyName || '').trim();
  if (!trimmedCompanyName) {
    return { ok: false, error: 'companyName manquant' };
  }

  const detectedType = jobOffer?.companyType || (await getOrClassifyCompany(trimmedCompanyName));
  if (detectedType) {
    await upsertCompanyToSupabase(trimmedCompanyName, detectedType);
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };

  try {
    const lookupClauses = [];
    if (jobOffer?.linkedinJobId) {
      lookupClauses.push(`linkedin_job_id.eq.${encodeURIComponent(String(jobOffer.linkedinJobId))}`);
    }
    if (jobOffer?.jobUrl) {
      lookupClauses.push(`job_url.eq.${encodeURIComponent(String(jobOffer.jobUrl))}`);
    }
    let existingRows = [];
    if (lookupClauses.length) {
      const lookupUrl = `${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?or=(${lookupClauses.join(',')})&select=id&limit=1`;
      const lookupRes = await fetch(lookupUrl, { method: 'GET', headers });
      if (!lookupRes.ok) {
        const text = await lookupRes.text();
        return { ok: false, error: `lookup ${lookupRes.status}: ${text.slice(0, 200)}` };
      }
      existingRows = await lookupRes.json();
    }

    let existingRow = null;
    if (Array.isArray(existingRows) && existingRows[0]?.id) {
      const existingRes = await fetch(
        `${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?id=eq.${encodeURIComponent(existingRows[0].id)}&select=*`,
        { method: 'GET', headers }
      );
      if (!existingRes.ok) {
        const text = await existingRes.text();
        return { ok: false, error: `read ${existingRes.status}: ${text.slice(0, 200)}` };
      }
      const rows = await existingRes.json();
      existingRow = rows?.[0] || null;
    }

    const mergedLinkedinData = swMergeLinkedinData(
      existingRow?.linkedin_data,
      jobOffer?.linkedinData || (jobOffer?.cardData ? { card: jobOffer.cardData } : null)
    );

    const detailScrapeDone =
      jobOffer?.stage === 'details' &&
      jobOffer?.detailsScrapedAt &&
      String(jobOffer?.descriptionText || '').trim().length > 0;

    let needsRescrape;
    if (detailScrapeDone) {
      needsRescrape = false;
    } else if (existingRow) {
      needsRescrape = existingRow.needs_rescrape === true;
    } else {
      needsRescrape = false;
    }

    const payload = sanitizeForPostgres({
      linkedin_job_id: jobOffer?.linkedinJobId || existingRow?.linkedin_job_id || null,
      company_name: trimmedCompanyName || existingRow?.company_name || null,
      company_type: detectedType || existingRow?.company_type || null,
      job_title: jobOffer?.jobTitle || existingRow?.job_title || null,
      job_url: jobOffer?.jobUrl || existingRow?.job_url || null,
      location: jobOffer?.location || existingRow?.location || null,
      description_text: jobOffer?.descriptionText || existingRow?.description_text || null,
      source: jobOffer?.source || existingRow?.source || 'linkedin_jobs',
      linkedin_data: mergedLinkedinData,
      first_seen_at: existingRow?.first_seen_at || jobOffer?.seenAt || new Date().toISOString(),
      last_seen_at: jobOffer?.seenAt || new Date().toISOString(),
      details_scraped_at: jobOffer?.detailsScrapedAt || existingRow?.details_scraped_at || null,
      needs_rescrape: needsRescrape,
      updated_at: new Date().toISOString()
    });

    if (Array.isArray(existingRows) && existingRows[0]?.id) {
      const patchRes = await fetch(
        `${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?id=eq.${encodeURIComponent(existingRows[0].id)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(payload)
        }
      );
      if (patchRes.ok) return { ok: true, mode: 'patch' };
      const text = await patchRes.text();
      return { ok: false, error: `patch ${patchRes.status}: ${text.slice(0, 200)}` };
    }

    const insertRes = await fetch(`${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (insertRes.ok) return { ok: true, mode: 'insert' };
    const insertText = await insertRes.text();
    return { ok: false, error: `insert ${insertRes.status}: ${insertText.slice(0, 200)}` };
  } catch (e) {
    console.warn('[Prospection BG] Supabase job upsert:', e.message);
    return { ok: false, error: e.message };
  }
}

async function swSaveJobOffer(jobOffer) {
  if (!jobOffer?.companyName) {
    throw new Error('Offre incomplète: companyName est requis');
  }
  const local = await swSaveJobOfferLocally(jobOffer);
  const supabase = await swUpsertJobOfferToSupabase(jobOffer);
  if (!supabase.ok) {
    console.warn('[Prospection BG] Sauvegarde job Supabase KO:', supabase.error);
  }
  return { local, supabase };
}

function swNormalizeJobUrlForSupabaseMatch(u) {
  if (u == null || u === '') return '';
  const s = String(u).trim();
  const base = s.split('?')[0];
  return base.toLowerCase();
}

function swSavedJobRowHasCompleteJobDesk(row) {
  if (!row) return false;
  if (row.needs_rescrape === true) return false;
  const rowUpdatedAt = String(row.updated_at || row.details_scraped_at || row.created_at || '').trim();
  if (!rowUpdatedAt || rowUpdatedAt < FORCE_RESCRAPE_CUTOFF_ISO) return false;
  const hasDetailsAt = row.details_scraped_at != null && String(row.details_scraped_at).trim() !== '';
  const hasDescription = row.description_text != null && String(row.description_text).trim().length > 0;
  return hasDetailsAt && hasDescription;
}

/**
 * @param {{ dedupKey: string, linkedinJobId?: string|null, jobUrl?: string|null }[]} items
 * @returns {Promise<Record<string, boolean>>}
 */
async function swCheckSavedJobsPresenceInSupabase(items) {
  const out = {};
  if (!items?.length) return out;
  const config = await loadConfig();
  const baseUrl = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!baseUrl || !key) return out;

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };

  const usable = items.filter((it) => it?.dedupKey && (it.linkedinJobId || it.jobUrl));
  const chunkSize = 12;
  for (let c = 0; c < usable.length; c += chunkSize) {
    const chunk = usable.slice(c, c + chunkSize);
    const orParts = [];
    for (const it of chunk) {
      if (it.linkedinJobId) {
        orParts.push(`linkedin_job_id.eq.${encodeURIComponent(String(it.linkedinJobId))}`);
      }
      if (it.jobUrl) {
        orParts.push(`job_url.eq.${encodeURIComponent(String(it.jobUrl))}`);
      }
    }
    if (!orParts.length) continue;
    const orQuery = orParts.join(',');
    try {
      const res = await fetch(
        `${baseUrl}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?select=linkedin_job_id,job_url,details_scraped_at,description_text,needs_rescrape,created_at,updated_at&or=(${orQuery})`,
        { method: 'GET', headers }
      );
      if (!res.ok) continue;
      const rowList = await res.json();
      if (!Array.isArray(rowList)) continue;

      for (const row of rowList) {
        if (!swSavedJobRowHasCompleteJobDesk(row)) continue;
        const rowId = row?.linkedin_job_id != null ? String(row.linkedin_job_id) : '';
        const rowUrlNorm = swNormalizeJobUrlForSupabaseMatch(row?.job_url);
        for (const it of chunk) {
          if (it.linkedinJobId && String(it.linkedinJobId) === rowId) {
            out[it.dedupKey] = true;
          } else if (it.jobUrl && swNormalizeJobUrlForSupabaseMatch(it.jobUrl) === rowUrlNorm) {
            out[it.dedupKey] = true;
          }
        }
      }
    } catch (_) {}
  }
  return out;
}
