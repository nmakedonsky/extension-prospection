/**
 * Upsert profils LinkedIn → public.saved_prospects (aligné import Waalaxy).
 */
const SUPABASE_PROSPECTS_TABLE = 'saved_prospects';

function pnProspectNormalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!s.startsWith('http')) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/in\/([^/]+)\/?/i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).replace(/\/+$/, '');
    if (!slug) return null;
    return `https://www.linkedin.com/in/${slug}`;
  } catch (_) {
    return null;
  }
}

function pnProspectSlug(url) {
  const m = String(url || '').match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : null;
}

function pnProspectNonEmpty(v) {
  return v != null && String(v).trim() !== '';
}

/**
 * Fusionne une ligne existante avec le payload extension :
 * - ne vide jamais un champ Waalaxy déjà rempli
 * - met à jour last_seen_at + linkedin_profile_json
 * - source reste waalaxy si déjà présent, sinon extension
 */
function pnMergeProspectRow(existing, incoming) {
  const now = new Date().toISOString();
  const url = pnProspectNormalizeUrl(incoming.linkedin_url) || (existing && existing.linkedin_url);
  if (!url) return null;

  const pick = (key) => {
    if (pnProspectNonEmpty(incoming[key])) return String(incoming[key]).trim();
    if (existing && pnProspectNonEmpty(existing[key])) return existing[key];
    return null;
  };

  let source = 'extension';
  if (existing && pnProspectNonEmpty(existing.source)) {
    source = existing.source === 'waalaxy' ? 'waalaxy' : existing.source;
  }

  // Ne jamais envoyer null (PostgREST upsert écraserait les champs Waalaxy).
  const row = {
    linkedin_url: url,
    source,
    last_seen_at: now,
    updated_at: now
  };

  const slug = pick('linkedin_slug') || pnProspectSlug(url);
  if (slug) row.linkedin_slug = slug;

  const setIf = (key, val) => {
    if (pnProspectNonEmpty(val)) row[key] = String(val).trim();
  };

  // Visite récente : privilégier les champs profil capturés
  setIf('first_name', incoming.first_name ?? pick('first_name'));
  setIf('last_name', incoming.last_name ?? pick('last_name'));
  setIf('full_name', incoming.full_name ?? pick('full_name'));
  setIf('job_title', incoming.job_title ?? pick('job_title'));
  setIf('company_name', incoming.company_name ?? pick('company_name'));
  setIf('location', incoming.location ?? pick('location'));
  setIf('email', pick('email'));
  setIf('phone', pick('phone'));

  if (incoming.linkedin_profile_json != null) {
    row.linkedin_profile_json = incoming.linkedin_profile_json;
  }

  if (!existing) {
    row.first_seen_at = now;
  }

  return row;
}

async function fetchProspectByUrl(supabaseUrl, supabaseKey, linkedinUrl) {
  const enc = encodeURIComponent(linkedinUrl);
  const res = await fetch(
    `${supabaseUrl}/rest/v1/${SUPABASE_PROSPECTS_TABLE}?linkedin_url=eq.${enc}&select=*`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: 'application/json'
      }
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function upsertLinkedInProspectToSupabase(payload) {
  const cfg = await loadConfig();
  const url = String(cfg.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(cfg.supabaseAnonKey || cfg.supabaseKey || '').trim();
  if (!url || !key) return { ok: false, error: 'missing_supabase_config' };

  const linkedinUrl = pnProspectNormalizeUrl(payload?.linkedin_url);
  if (!linkedinUrl) return { ok: false, error: 'invalid_linkedin_url' };

  let existing = null;
  try {
    existing = await fetchProspectByUrl(url, key, linkedinUrl);
  } catch (_) {}

  const row = pnMergeProspectRow(existing, { ...payload, linkedin_url: linkedinUrl });
  if (!row) return { ok: false, error: 'merge_failed' };

  const res = await fetch(`${url}/rest/v1/${SUPABASE_PROSPECTS_TABLE}?on_conflict=linkedin_url`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `http_${res.status}`, detail: text.slice(0, 400) };
  }

  const body = await res.json().catch(() => null);
  const saved = Array.isArray(body) ? body[0] : body;
  return {
    ok: true,
    id: saved?.id || existing?.id || null,
    created: !existing,
    linkedin_url: linkedinUrl
  };
}
