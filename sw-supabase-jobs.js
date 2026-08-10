/**
 * Cache local + upsert table saved_jobs (offres LinkedIn).
 * S’appuie sur loadConfig, getOrClassifyCompany, upsertCompanyToSupabase (background.js)
 * et sanitizeForPostgres (sw-supabase-financial.js).
 */
const SW_SUPABASE_JOBS_TABLE = 'saved_jobs';

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

function swBuildJobLookupClauses(jobOffer, payload) {
  const out = [];
  const linkedinJobId = jobOffer?.linkedinJobId || payload?.linkedin_job_id;
  const jobUrl = jobOffer?.jobUrl || payload?.job_url;
  if (linkedinJobId) {
    out.push(`linkedin_job_id.eq.${encodeURIComponent(String(linkedinJobId))}`);
  }
  if (jobUrl) {
    out.push(`job_url.eq.${encodeURIComponent(String(jobUrl))}`);
  }
  return out;
}

async function swFetchExistingSavedJobRow(url, headers, lookupClauses) {
  if (!lookupClauses?.length) return null;
  const lookupUrl = `${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?or=(${lookupClauses.join(',')})&select=*&limit=1`;
  const lookupRes = await fetch(lookupUrl, { method: 'GET', headers });
  if (!lookupRes.ok) return null;
  const rows = await lookupRes.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function swIsDuplicateConstraintError(text) {
  const s = String(text || '').toLowerCase();
  return s.includes('duplicate key value') || s.includes('unique constraint');
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

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };

  try {
    const lookupClauses = swBuildJobLookupClauses(jobOffer);
    let existingRow = await swFetchExistingSavedJobRow(url, headers, lookupClauses);

    const mergedLinkedinData = swMergeLinkedinData(
      existingRow?.linkedin_data,
      jobOffer?.linkedinData || (jobOffer?.cardData ? { card: jobOffer.cardData } : null)
    );

    const detailScrapeDone =
      jobOffer?.stage === 'details' &&
      jobOffer?.detailsScrapedAt &&
      String(jobOffer?.descriptionText || '').trim().length > 0;

    let linkedinPromote = null;
    if (detailScrapeDone && typeof swEnsureCompanyLinkedinUrlFromJob === 'function') {
      linkedinPromote = await swEnsureCompanyLinkedinUrlFromJob(jobOffer, detectedType);
      if (linkedinPromote?.ok) {
        try {
          console.info(
            '[Prospection BG] linkedin_company_url',
            trimmedCompanyName,
            linkedinPromote.mode,
            linkedinPromote.canonicalUrl
          );
        } catch (_) {}
      }
    }

    const companyRowHandled =
      linkedinPromote?.ok &&
      (linkedinPromote.mode === 'created' ||
        linkedinPromote.mode === 'initialized' ||
        linkedinPromote.mode === 'frozen');
    if (detectedType && !companyRowHandled) {
      await upsertCompanyToSupabase(trimmedCompanyName, detectedType);
    }

    let needsRescrape;
    if (detailScrapeDone) {
      needsRescrape = false;
    } else if (existingRow) {
      needsRescrape = existingRow.needs_rescrape === true;
    } else {
      needsRescrape = false;
    }

    const seenNow = jobOffer?.seenAt || new Date().toISOString();
    const scrapeNow = detailScrapeDone ? jobOffer?.detailsScrapedAt || seenNow : null;
    const firstScrapedAt =
      existingRow?.first_scraped_at || (detailScrapeDone ? scrapeNow : null);

    const applicantsCount =
      typeof jobOffer?.applicantsCount === 'number' && Number.isFinite(jobOffer.applicantsCount)
        ? Math.max(0, Math.floor(jobOffer.applicantsCount))
        : existingRow?.applicants_count ?? null;

    const payload = sanitizeForPostgres({
      linkedin_job_id: jobOffer?.linkedinJobId || existingRow?.linkedin_job_id || null,
      company_name: trimmedCompanyName || existingRow?.company_name || null,
      company_type: detectedType || existingRow?.company_type || null,
      job_title: jobOffer?.jobTitle || existingRow?.job_title || null,
      job_url: jobOffer?.jobUrl || existingRow?.job_url || null,
      location: jobOffer?.location || existingRow?.location || null,
      employment_type: jobOffer?.employmentType || existingRow?.employment_type || null,
      workplace_type: jobOffer?.workplaceType || existingRow?.workplace_type || null,
      posted_at: jobOffer?.postedAt || existingRow?.posted_at || null,
      posted_text: jobOffer?.postedText || existingRow?.posted_text || null,
      applicants_count: applicantsCount,
      description_text: jobOffer?.descriptionText || existingRow?.description_text || null,
      source: jobOffer?.source || existingRow?.source || 'linkedin_jobs',
      linkedin_data: mergedLinkedinData,
      first_seen_at: existingRow?.first_seen_at || seenNow,
      first_scraped_at: firstScrapedAt,
      last_seen_at: seenNow,
      details_scraped_at: scrapeNow || existingRow?.details_scraped_at || null,
      needs_rescrape: needsRescrape,
      updated_at: new Date().toISOString()
    });

    if (existingRow?.id) {
      const patchRes = await fetch(
        `${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?id=eq.${encodeURIComponent(existingRow.id)}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(payload)
        }
      );
      if (patchRes.ok) {
        return { ok: true, mode: 'patch', linkedinPromote };
      }
      const text = await patchRes.text();
      return { ok: false, error: `patch ${patchRes.status}: ${text.slice(0, 200)}` };
    }

    const insertRes = await fetch(`${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (insertRes.ok) return { ok: true, mode: 'insert', linkedinPromote };
    const insertText = await insertRes.text();
    if (swIsDuplicateConstraintError(insertText)) {
      const recoveredLookup = swBuildJobLookupClauses(jobOffer, payload);
      const recoveredRow = await swFetchExistingSavedJobRow(url, headers, recoveredLookup);
      if (recoveredRow?.id) {
        const retryPatchRes = await fetch(
          `${url}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?id=eq.${encodeURIComponent(recoveredRow.id)}`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify(payload)
          }
        );
        if (retryPatchRes.ok) return { ok: true, mode: 'insert-duplicate-recovered', linkedinPromote };
        const retryText = await retryPatchRes.text();
        return { ok: false, error: `patch-after-duplicate ${retryPatchRes.status}: ${retryText.slice(0, 200)}` };
      }
    }
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
  const supabase = await swUpsertJobOfferToSupabase(jobOffer);
  if (!supabase.ok) {
    console.warn('[Prospection BG] Sauvegarde job Supabase KO:', supabase.error);
  }
  return { supabase };
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
  const allWithLinkedinIdOnly =
    usable.length > 0 && usable.every((it) => it?.linkedinJobId && (!it?.jobUrl || String(it.jobUrl).trim() === ''));

  // Fast path: one Supabase request for the whole page when we only match by linkedin_job_id.
  if (allWithLinkedinIdOnly) {
    const byId = new Map();
    for (const it of usable) {
      const id = String(it.linkedinJobId || '').trim();
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(it.dedupKey);
    }
    const ids = Array.from(byId.keys());
    if (ids.length > 0) {
      const idsEncoded = ids.map((id) => encodeURIComponent(id)).join(',');
      try {
        const res = await fetch(
          `${baseUrl}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?select=linkedin_job_id,job_url,details_scraped_at,description_text,needs_rescrape,created_at,updated_at&linkedin_job_id=in.(${idsEncoded})`,
          { method: 'GET', headers }
        );
        if (res.ok) {
          const rowList = await res.json();
          if (Array.isArray(rowList)) {
            for (const row of rowList) {
              if (!swSavedJobRowHasCompleteJobDesk(row)) continue;
              const rowId = row?.linkedin_job_id != null ? String(row.linkedin_job_id) : '';
              const dedupKeys = byId.get(rowId) || [];
              for (const k of dedupKeys) out[k] = true;
            }
            return out;
          }
        }
      } catch (_) {}
    }
  }

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

const SW_TOUCH_LAST_SEEN_CHUNK = 50;

/**
 * Met à jour last_seen_at (dernière vue LinkedIn) sans toucher first_scraped_at.
 * @param {string[]} linkedinJobIds
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function swTouchSavedJobsLastSeenAt(linkedinJobIds) {
  const ids = [
    ...new Set(
      (linkedinJobIds || [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )
  ];
  if (!ids.length) return { ok: true };

  const config = await loadConfig();
  const baseUrl = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!baseUrl || !key) return { ok: false, skipped: true };

  const now = new Date().toISOString();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };

  try {
    for (let i = 0; i < ids.length; i += SW_TOUCH_LAST_SEEN_CHUNK) {
      const chunk = ids.slice(i, i + SW_TOUCH_LAST_SEEN_CHUNK);
      const inList = chunk.map((id) => encodeURIComponent(id)).join(',');
      const res = await fetch(
        `${baseUrl}/rest/v1/${SW_SUPABASE_JOBS_TABLE}?linkedin_job_id=in.(${inList})`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ last_seen_at: now, updated_at: now })
        }
      );
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `touch ${res.status}: ${text.slice(0, 200)}` };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
