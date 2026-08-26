/**
 * Service worker — tests de connexion + journalisation optionnelle (Supabase).
 */
importScripts(
  'modeDetector.js',
  'merger.js',
  'scoring.js',
  'llmExtractor.js',
  'financialPipeline.js',
  'sw-openrouter.js',
  'sw-company-match-prompt.js',
  'financial-gemini-context.js',
  'sw-company-summary.js',
  'sw-supabase-financial.js',
  'sw-supabase-jobs.js',
  'sw-supabase-prospects.js',
  'sw-company-linkedin-url.js',
  'sw-tab-flush-buffers.js',
  'sw-financial.js',
  'sw-financial-prefetch-queue.js'
);
try {
  importScripts('local-config.js');
} catch (_) {
  /* optionnel : copier local-config.example.js → local-config.js */
}

const STORAGE_KEY_CONFIG = 'config';
/** Ancien cache local sociétés — supprimé au démarrage (source de vérité : table `companies`). */
const LEGACY_COMPANIES_CACHE_KEY = 'prospectionCompaniesCache';
const SUPABASE_LOGS_TABLE = 'extension_logs';
const SUPABASE_COMPANIES_TABLE = 'companies';
const EXTENSION_SOURCE = 'extension-prospection';

/** Rotation des logs debug jobdesk (`jd_*`) — court historique uniquement. */
const JD_DEBUG_LOG_RETENTION_DAYS = 4;
const JD_DEBUG_LOG_ROTATE_MIN_MS = 4 * 60 * 60 * 1000;
let jdDebugLogRotateLastMs = 0;
const JD_DEBUG_LOG_EVENT_NAMES = [
  'jd_run',
  'jd_scroll',
  'jd_click',
  'jd_fail',
  'jd_sc',
  'jd_skip',
  'jd_seq',
  'jd_list'
];

async function maybeRotateJdDebugLogs(supabaseUrl, supabaseKey, eventName) {
  if (!String(eventName || '').startsWith('jd_')) return;
  const now = Date.now();
  if (now - jdDebugLogRotateLastMs < JD_DEBUG_LOG_ROTATE_MIN_MS) return;
  jdDebugLogRotateLastMs = now;
  const cutoffIso = new Date(now - JD_DEBUG_LOG_RETENTION_DAYS * 864e5).toISOString();
  const srcEnc = encodeURIComponent(EXTENSION_SOURCE);
  const cutoffEnc = encodeURIComponent(cutoffIso);
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    Prefer: 'return=minimal'
  };
  for (const ev of JD_DEBUG_LOG_EVENT_NAMES) {
    const evEnc = encodeURIComponent(ev);
    const endpoint = `${supabaseUrl}/rest/v1/${SUPABASE_LOGS_TABLE}?source=eq.${srcEnc}&event=eq.${evEnc}&created_at=lt.${cutoffEnc}`;
    try {
      await fetch(endpoint, { method: 'DELETE', headers });
    } catch (_) {}
  }
}

/** @type {Map<string, Promise<'Client'|'SS2I'|null>>} */
const inflightClassify = new Map();
/** Cache RAM session (onglet) — persistance = table Supabase `companies` uniquement. */
const memoryCompaniesType = new Map();
const COMPANIES_MEMORY_MAX_ENTRIES = 800;
const SUPABASE_COMPANIES_IN_CHUNK = 40;

function rememberCompanyTypeInMemory(companyName, type) {
  if (type !== 'Client' && type !== 'SS2I') return;
  memoryCompaniesType.set(companyName, type);
  while (memoryCompaniesType.size > COMPANIES_MEMORY_MAX_ENTRIES) {
    const oldest = memoryCompaniesType.keys().next().value;
    if (oldest != null) memoryCompaniesType.delete(oldest);
  }
}

/** Cache RAM session — légitimité (lecture seule depuis Supabase). */
const memoryCompaniesLegitimacy = new Map();
const LEGITIMACY_VERDICTS = new Set(['real', 'recruiter', 'shell', 'uncertain']);

function rememberCompanyLegitimacyInMemory(companyName, info) {
  const n = String(companyName || '').trim();
  if (!n || !info || typeof info !== 'object') return;
  const verdict = String(info.verdict || '').trim().toLowerCase();
  if (!LEGITIMACY_VERDICTS.has(verdict)) return;
  memoryCompaniesLegitimacy.set(n, {
    verdict,
    india_bodyshop: !!info.india_bodyshop,
    confidence: info.confidence ?? null,
    payload: info.payload && typeof info.payload === 'object' ? info.payload : null,
    at: info.at || null
  });
  while (memoryCompaniesLegitimacy.size > COMPANIES_MEMORY_MAX_ENTRIES) {
    const oldest = memoryCompaniesLegitimacy.keys().next().value;
    if (oldest != null) memoryCompaniesLegitimacy.delete(oldest);
  }
}

/**
 * @param {string[]} companyNames
 * @returns {Promise<Record<string, object>>}
 */
async function getCompaniesLegitimacyBatch(companyNames) {
  const unique = [
    ...new Set(
      (companyNames || [])
        .map((n) => String(n || '').trim())
        .filter((n) => n.length >= 2)
    )
  ];
  const out = {};
  if (!unique.length) return out;

  const needDb = [];
  for (const n of unique) {
    const mem = memoryCompaniesLegitimacy.get(n);
    if (mem && LEGITIMACY_VERDICTS.has(mem.verdict)) {
      out[n] = mem;
    } else {
      needDb.push(n);
    }
  }

  if (needDb.length) {
    const fromDb = await getCompaniesFromSupabaseBatch(needDb);
    for (const [n, info] of Object.entries(fromDb.legitimacy || {})) {
      rememberCompanyLegitimacyInMemory(n, info);
      out[n] = info;
    }
  }
  return out;
}

try {
  chrome.storage.local.remove('prospectionCompaniesCache');
} catch (_) {}

const SENDPILOT_API_BASE = 'https://api.sendpilot.ai/v1';

/**
 * Fusionne `local-config.js` dans chrome.storage :
 * - preferLocalFile: true → le fichier prime sur le popup (dev)
 * - sinon → complète uniquement les champs vides / manquants (recharge extension sans tout effacer)
 */
async function loadConfig() {
  const r = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  let c = r[STORAGE_KEY_CONFIG];
  if (!c || typeof c !== 'object') c = {};

  const local =
    typeof self !== 'undefined' && self.__PN_LOCAL_DEV_CONFIG && typeof self.__PN_LOCAL_DEV_CONFIG === 'object'
      ? self.__PN_LOCAL_DEV_CONFIG
      : null;
  if (!local) return c;

  const preferLocal = local.preferLocalFile === true;
  const merged = { ...c };
  let changed = false;
  for (const [k, v] of Object.entries(local)) {
    if (k === 'preferLocalFile') continue;
    if (v == null || String(v).trim() === '') continue;
    const stored = merged[k];
    const storedEmpty = stored == null || String(stored).trim() === '';
    if (preferLocal || storedEmpty) {
      if (merged[k] !== v) {
        merged[k] = v;
        changed = true;
      }
    }
  }
  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: merged });
  }
  return merged;
}


/**
 * Appelle l’endpoint REST racine (OpenAPI) — vérifie URL + clé anon.
 */
async function testSupabase(projectUrl, anonKey) {
  const base = String(projectUrl || '').trim().replace(/\/$/, '');
  const key = String(anonKey || '').trim();
  if (!base || !key) {
    return { ok: false, error: 'URL Supabase ou clé anon manquante.' };
  }
  const res = await fetch(`${base}/rest/v1/`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}` };
  }
  return { ok: true };
}

function hubspotApiOrigin(region) {
  const r = String(region || 'eu').toLowerCase();
  if (r === 'eu' || r === 'eu1') {
    return 'https://api-eu1.hubapi.com';
  }
  return 'https://api.hubapi.com';
}

/**
 * Test de connexion : endpoint compte uniquement (pas CRM contacts / companies).
 * Certains GET CRM renvoient un message trompeur « scopes contacts requis » selon le compte HubSpot.
 */
async function testHubSpot(apiKey, region) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Clé API HubSpot manquante.' };
  }
  const primary = hubspotApiOrigin(region);
  const alternate =
    primary.includes('eu1') || primary.includes('eu-')
      ? 'https://api.hubapi.com'
      : 'https://api-eu1.hubapi.com';

  async function getAccountDetails(base) {
    return fetch(`${base.replace(/\/$/, '')}/account-info/v3/details`, {
      headers: {
        Authorization: `Bearer ${key}`
      }
    });
  }

  let res = await getAccountDetails(primary);
  if (res.status === 401 || res.status === 404) {
    res = await getAccountDetails(alternate);
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}` };
  }
  return { ok: true };
}

/**
 * Liste des campagnes (lecture seule) — vérifie la clé SendPilot.
 * @see https://docs.sendpilot.ai/api-reference/introduction
 */
async function testSendPilot(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Clé API SendPilot manquante.' };
  }
  const res = await fetch(`${SENDPILOT_API_BASE}/campaigns`, {
    method: 'GET',
    headers: {
      'X-API-Key': key,
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}` };
  }
  let count = null;
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) count = data.length;
    else if (data && Array.isArray(data.data)) count = data.data.length;
    else if (data && typeof data.total === 'number') count = data.total;
  } catch (_) {}
  return { ok: true, meta: count != null ? { campaignsHint: count } : undefined };
}

/**
 * Interprète la sortie LLM sans utiliser includes('client'), qui fausse la classe
 * dès qu'une phrase contient le mot « client » (ex. « clients finaux », « relation client »).
 * @param {string} raw
 * @returns {'Client'|'SS2I'|null}
 */
function parseClassificationLabel(raw) {
  const lines = String(raw || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) =>
      s
        .trim()
        .replace(/^[-*•\d.\s]+/, '')
        .replace(/[*_`]/g, '')
        .trim()
    )
    .filter((s) => s.length > 0);
  for (const cleaned of lines) {
    const m = /\b(SS2I|Client)\b/i.exec(cleaned);
    if (m) {
      return m[1].toLowerCase() === 'client' ? 'Client' : 'SS2I';
    }
  }
  return null;
}

/**
 * @param {string} companyName
 * @returns {Promise<'Client'|'SS2I'>}
 */
async function classifyCompanyWithLlm(companyName) {
  const apiKey = await getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error('Clé API OpenRouter non configurée.');
  }

  const prompt = `Tu classifie les entreprises pour de la prospection commerciale (France / international).
Réponds par UN SEUL MOT, sans phrase ni ponctuation : exactement SS2I ou Client.

Définitions :
- SS2I : ESN, SSII, société de services du numérique, intégrateur, prestataire informatique, régie tech, cabinet de conseil ou de services IT (conseil en technologies, transformation digitale pour le compte de donneurs d’ordres). Si le cœur de métier est la prestation intellectuelle / la régie / le service IT pour tiers → SS2I.
- Client : entreprise dont l’activité principale n’est pas la prestation IT ou le conseil pour compte de tiers (industrie manufacturière, retail, banque, assurance, santé, énergie, média, etc.). Éditeur logiciel « produit » ou scale-up SaaS sans activité type ESN peut être Client ; en cas de doute entre ESN / conseil IT et autre, choisir SS2I si la description ressemble à une société de services ou de conseil IT.

Attention aux homonymes de raison sociale : privilégie le profil le plus probable pour une offre d’emploi tech / conseil (souvent SS2I).

Entreprise : "${String(companyName || '').replace(/"/g, '\\"')}"`;

  const data = await orChatCompletion({
    apiKey,
    model: OR_MODEL_FAST,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    maxTokens: 16,
    label: 'OpenRouter classify'
  });
  const out = orExtractMessageText(data);
  if (!out) {
    throw new Error(`Réponse vide (${OR_MODEL_FAST})`);
  }
  const parsed = parseClassificationLabel(out);
  if (parsed) return parsed;
  return 'SS2I';
}

function quoteSupabaseInValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function getCompanyFromSupabase(companyName) {
  const batch = await getCompaniesFromSupabaseBatch([companyName]);
  return batch.types?.[companyName] || null;
}

function legitimacyInfoFromCompanyRow(row) {
  const verdict = String(row?.legitimacy_verdict || '')
    .trim()
    .toLowerCase();
  if (!LEGITIMACY_VERDICTS.has(verdict) || !row?.legitimacy_at) return null;
  return {
    verdict,
    india_bodyshop: !!row.legitimacy_india_bodyshop,
    confidence: row.legitimacy_confidence ?? null,
    payload: row.legitimacy_payload && typeof row.legitimacy_payload === 'object' ? row.legitimacy_payload : null,
    at: row.legitimacy_at || null
  };
}

/**
 * Un seul SELECT : type Client/SS2I + légitimité (si déjà backfillée).
 * @param {string[]} companyNames
 * @returns {Promise<{ types: Record<string, 'Client'|'SS2I'>, legitimacy: Record<string, object> }>}
 */
async function getCompaniesFromSupabaseBatch(companyNames) {
  const types = {};
  const legitimacy = {};
  const names = [
    ...new Set(
      (companyNames || [])
        .map((n) => String(n || '').trim())
        .filter((n) => n.length >= 2)
    )
  ];
  if (!names.length) return { types, legitimacy };

  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) return { types, legitimacy };

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };

  for (let i = 0; i < names.length; i += SUPABASE_COMPANIES_IN_CHUNK) {
    const chunk = names.slice(i, i + SUPABASE_COMPANIES_IN_CHUNK);
    const inList = chunk.map(quoteSupabaseInValue).join(',');
    try {
      const res = await fetch(
        `${url}/rest/v1/${SUPABASE_COMPANIES_TABLE}?company_name=in.(${inList})&select=company_name,type,legitimacy_verdict,legitimacy_india_bodyshop,legitimacy_confidence,legitimacy_payload,legitimacy_at`,
        { method: 'GET', headers }
      );
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const n = String(row?.company_name || '').trim();
        if (!n) continue;
        const t = row?.type;
        if (t === 'Client' || t === 'SS2I') types[n] = t;
        const legit = legitimacyInfoFromCompanyRow(row);
        if (legit) legitimacy[n] = legit;
      }
    } catch (_) {}
  }
  return { types, legitimacy };
}

async function upsertCompanyToSupabase(companyName, type) {
  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/${SUPABASE_COMPANIES_TABLE}?on_conflict=company_name`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        company_name: companyName,
        type,
        updated_at: new Date().toISOString()
      })
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn('[Prospection BG] Supabase companies:', res.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn('[Prospection BG] Supabase upsert:', e);
  }
}

/**
 * OpenRouter + upsert Supabase (une société).
 * @param {string} trimmed
 * @returns {Promise<'Client'|'SS2I'|null>}
 */
async function classifyWithLlmAndPersist(trimmed) {
  if (inflightClassify.has(trimmed)) {
    return inflightClassify.get(trimmed);
  }

  const task = (async () => {
    try {
      const type = await classifyCompanyWithLlm(trimmed);
      void logToSupabase('company_classified', {
        company_name: trimmed.slice(0, 120),
        type,
        via: 'openrouter'
      });
      await upsertCompanyToSupabase(trimmed, type);
      rememberCompanyTypeInMemory(trimmed, type);
      return type;
    } catch (e) {
      console.warn('[Prospection BG] Classification:', trimmed, e?.message || e);
      void logToSupabase(
        'classification_failed',
        {
          company_name: trimmed.slice(0, 120),
          error: String(e?.message || e).slice(0, 500)
        },
        'warn'
      );
      return null;
    } finally {
      inflightClassify.delete(trimmed);
    }
  })();

  inflightClassify.set(trimmed, task);
  return task;
}

/**
 * RAM session → Supabase (batch) → OpenRouter pour les inconnues.
 * @param {string} companyName
 * @returns {Promise<'Client'|'SS2I'|null>}
 */
async function getOrClassifyCompany(companyName) {
  const trimmed = String(companyName || '').trim();
  if (!trimmed) return null;

  const memType = memoryCompaniesType.get(trimmed);
  if (memType === 'Client' || memType === 'SS2I') {
    return memType;
  }

  const fromDb = await getCompanyFromSupabase(trimmed);
  if (fromDb) {
    void logToSupabase('company_classified', {
      company_name: trimmed.slice(0, 120),
      type: fromDb,
      via: 'supabase'
    });
    rememberCompanyTypeInMemory(trimmed, fromDb);
    return fromDb;
  }

  return classifyWithLlmAndPersist(trimmed);
}

/**
 * @param {string[]} companyNames
 * @returns {Promise<{ types: Record<string, 'Client'|'SS2I'|null>, legitimacy: Record<string, object> }>}
 */
async function classifyCompaniesBatch(companyNames) {
  const unique = [
    ...new Set(
      (companyNames || [])
        .map((n) => String(n || '').trim())
        .filter((n) => n.length >= 2)
    )
  ];
  const typesOut = {};
  const legitimacyOut = {};
  if (!unique.length) return { types: typesOut, legitimacy: legitimacyOut };

  const needDb = [];
  for (const n of unique) {
    const memType = memoryCompaniesType.get(n);
    if (memType === 'Client' || memType === 'SS2I') typesOut[n] = memType;
    const memLegit = memoryCompaniesLegitimacy.get(n);
    if (memLegit && LEGITIMACY_VERDICTS.has(memLegit.verdict)) {
      legitimacyOut[n] = memLegit;
    }
    // Un round-trip Supabase si type OU légitimité manquent.
    if (!(memType === 'Client' || memType === 'SS2I') || !legitimacyOut[n]) {
      needDb.push(n);
    }
  }

  if (needDb.length) {
    const fromDb = await getCompaniesFromSupabaseBatch(needDb);
    for (const [n, t] of Object.entries(fromDb.types || {})) {
      rememberCompanyTypeInMemory(n, t);
      typesOut[n] = t;
      void logToSupabase('company_classified', {
        company_name: n.slice(0, 120),
        type: t,
        via: 'supabase'
      });
    }
    for (const [n, info] of Object.entries(fromDb.legitimacy || {})) {
      rememberCompanyLegitimacyInMemory(n, info);
      legitimacyOut[n] = info;
    }
  }

  const needLlm = unique.filter((n) => !typesOut[n]);
  if (needLlm.length) {
    const concurrency = 3;
    let nextIdx = 0;
    async function worker() {
      while (true) {
        const idx = nextIdx++;
        if (idx >= needLlm.length) return;
        const n = needLlm[idx];
        const type = await classifyWithLlmAndPersist(n);
        if (type) typesOut[n] = type;
      }
    }
    const nWorkers = Math.min(concurrency, needLlm.length);
    await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  }

  for (const n of unique) {
    if (!(n in typesOut)) typesOut[n] = null;
  }
  return { types: typesOut, legitimacy: legitimacyOut };
}

function sanitizeJsonValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 5) return null;
  if (typeof value === 'string') return value.slice(0, 8000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((v) => sanitizeJsonValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    Object.entries(value).slice(0, 60).forEach(([k, v]) => {
      out[String(k).slice(0, 200)] = sanitizeJsonValue(v, depth + 1);
    });
    return out;
  }
  return String(value);
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} data
 * @param {'info'|'warn'|'error'} [level]
 */
async function postExtensionLog(event, data, level = 'info') {
  const config = await loadConfig();
  const supabaseUrl = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const supabaseKey = String(config.supabaseAnonKey || '').trim();
  if (!supabaseUrl || !supabaseKey) return { ok: false, skipped: true };

  const raw = data && typeof data === 'object' ? data : {};
  const pageUrl = typeof raw.pageUrl === 'string' ? raw.pageUrl.slice(0, 2000) : null;
  const tabId = Number.isInteger(raw.tabId) ? raw.tabId : null;
  const rest = { ...raw };
  delete rest.pageUrl;
  delete rest.tabId;

  const safeLevel = level === 'warn' || level === 'error' ? level : 'info';

  const body = {
    source: EXTENSION_SOURCE,
    level: safeLevel,
    event: String(event || 'event').slice(0, 200),
    data: sanitizeJsonValue(rest),
    sender: null,
    page_url: pageUrl,
    tab_id: tabId,
    frame_id: null,
    client_ts: new Date().toISOString(),
    created_at: new Date().toISOString()
  };

  const res = await fetch(`${supabaseUrl}/rest/v1/${SUPABASE_LOGS_TABLE}`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: t.slice(0, 400) || `HTTP ${res.status}` };
  }
  if (String(event || '').startsWith('jd_')) {
    void maybeRotateJdDebugLogs(supabaseUrl, supabaseKey, event);
  }
  return { ok: true };
}

function logToSupabase(event, data, level) {
  return postExtensionLog(event, data, level || 'info').catch(() => {});
}

/**
 * Rotation du stockage local quand on approche du quota (~5 Mo).
 * Les données financières détaillées restent sur Supabase ; le local est un cache léger.
 */
async function pnExtensionStorageRotateHeavy(reason, opts) {
  opts = opts || {};
  const force = !!opts.force;
  const cacheCap =
    typeof opts.cacheCap === 'number' && opts.cacheCap > 0 ? opts.cacheCap : 48;

  try {
    let bytesBefore = null;
    if (chrome.storage.local && chrome.storage.local.getBytesInUse) {
      bytesBefore = await new Promise((resolve, reject) => {
        chrome.storage.local.getBytesInUse(null, (bytes) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(bytes);
        });
      }).catch(() => null);
    }

    const LIMIT =
      typeof chrome.storage.local.QUOTA_BYTES === 'number'
        ? chrome.storage.local.QUOTA_BYTES
        : 5242880;
    const TRIGGER = Math.floor(LIMIT * 0.72);

    const aboveThreshold =
      typeof bytesBefore === 'number' && bytesBefore >= TRIGGER;

    if (!force && !aboveThreshold) {
      return { rotated: false, bytesBefore };
    }

    await chrome.storage.local.remove([
      'pnFinancialPrefetchQueue',
      'pnFinancialPrefetchLastCtx'
    ]);

    const fc = await chrome.storage.local.get('financialCache');
    const cache = fc.financialCache;
    if (cache && typeof cache === 'object') {
      const pairs = Object.entries(cache).sort(
        (a, b) =>
          Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0)
      );
      const capped = Object.fromEntries(pairs.slice(0, cacheCap));
      await chrome.storage.local.set({ financialCache: capped });
    }

    void logToSupabase(
      'extension_storage_rotate',
      {
        reason,
        bytes_before: bytesBefore,
        quota_bytes: LIMIT,
        prefetch_cleared: true,
        cache_cap: cacheCap,
        forced: force
      },
      'warn'
    );

    return { rotated: true, bytesBefore };
  } catch (e) {
    void logToSupabase(
      'extension_storage_rotate_failed',
      { reason, error: String(e && e.message ? e.message : e).slice(0, 400) },
      'warn'
    );
    return { rotated: false, error: String(e && e.message ? e.message : e) };
  }
}

self.pnExtensionStorageRotateHeavy = pnExtensionStorageRotateHeavy;

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await pnExtensionStorageRotateHeavy('startup');
    void swFinancialPrefetchKick();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await pnExtensionStorageRotateHeavy('installed');
    void swFinancialPrefetchKick();
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    return pnHandleRuntimeMessage(msg, sender, sendResponse);
  } catch (e) {
    try {
      sendResponse({
        ok: false,
        error: String(e && e.message ? e.message : e)
      });
    } catch (_) {}
    return false;
  }
});

function pnHandleRuntimeMessage(msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  if (msg.type === 'PN_FLUSH_JOBS_TAB_STATE') {
    const tid = sender?.tab?.id;
    if (typeof tid === 'number') {
      pnFlushTabBuffer(tid)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    sendResponse({ ok: false, error: 'no_tab' });
    return false;
  }

  if (msg.type === 'GET_CONFIG') {
    loadConfig().then((config) => sendResponse({ ok: true, config })).catch((e) => {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    });
    return true;
  }

  if (msg.type === 'SAVE_CONFIG') {
    const next = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    chrome.storage.local
      .set({ [STORAGE_KEY_CONFIG]: next })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true;
  }

  if (msg.type === 'TEST_OPENROUTER' || msg.type === 'TEST_GEMINI') {
    const run =
      typeof testOpenRouter === 'function'
        ? testOpenRouter(msg.apiKey)
        : Promise.reject(new Error('OpenRouter non chargé — recharge l’extension'));
    run
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'TEST_SUPABASE') {
    testSupabase(msg.supabaseUrl, msg.supabaseAnonKey)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'TEST_HUBSPOT') {
    testHubSpot(msg.hubspotApiKey, msg.hubspotRegion)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'TEST_SENDPILOT') {
    testSendPilot(msg.sendPilotApiKey)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'CLASSIFY_COMPANY') {
    const name = String(msg.companyName || '').trim();
    if (!name) {
      sendResponse(null);
      return false;
    }
    getOrClassifyCompany(name)
      .then((type) => sendResponse(type))
      .catch(() => sendResponse(null));
    return true;
  }

  if (msg.type === 'CLASSIFY_COMPANIES_BATCH') {
    const names = Array.isArray(msg.companyNames) ? msg.companyNames : [];
    classifyCompaniesBatch(names)
      .then((payload) => sendResponse(payload && typeof payload === 'object' ? payload : { types: {}, legitimacy: {} }))
      .catch(() => sendResponse({ types: {}, legitimacy: {} }));
    return true;
  }

  if (msg.type === 'LEGITIMACY_COMPANIES_BATCH') {
    const names = Array.isArray(msg.companyNames) ? msg.companyNames : [];
    getCompaniesLegitimacyBatch(names)
      .then((map) => sendResponse(map))
      .catch(() => sendResponse({}));
    return true;
  }

  if (msg.type === 'UPSERT_LINKEDIN_PROSPECT') {
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    upsertLinkedInProspectToSupabase(payload)
      .then(async (r) => {
        try {
          await postExtensionLog(
            r && r.ok ? 'prospect_upsert' : 'prospect_upsert_fail',
            {
              linkedin_url: r?.linkedin_url || payload.linkedin_url || null,
              created: !!(r && r.created),
              id: r?.id || null,
              has_json: payload.linkedin_profile_json != null,
              stripped_json: !!(r && r.stripped_json),
              error: r?.error || null,
              detail: r?.detail || null,
              capture_from: payload.capture_from || null
            },
            r && r.ok ? 'info' : 'error'
          );
        } catch (_) {}
        sendResponse(r);
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'EXTENSION_LOG') {
    const event = String(msg.event || '').trim().slice(0, 200);
    if (!event) {
      sendResponse({ ok: false, error: 'missing_event' });
      return false;
    }
    const raw = msg.data && typeof msg.data === 'object' ? msg.data : {};
    const pageUrl =
      typeof raw.pageUrl === 'string'
        ? raw.pageUrl.slice(0, 2000)
        : typeof sender?.tab?.url === 'string'
          ? String(sender.tab.url).slice(0, 2000)
          : null;
    const data = { ...raw };
    delete data.pageUrl;
    const payload = { ...data, pageUrl, tabId: sender?.tab?.id ?? null };
    const level = msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info';
    // Écriture immédiate (pas de tampon) : ces logs `jd_*` sont peu nombreux et
    // indispensables pour diagnostiquer en direct le workflow Jobdesk (le tampon par
    // onglet ne flush qu'au pagehide, ce qui les rendait invisibles pendant des heures).
    postExtensionLog(event, payload, level)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === 'JOBS_PAGE_HEARTBEAT') {
    const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    if (!p.logToSupabase) {
      sendResponse({ ok: true, logged: false });
      return false;
    }
    const hbPayload = { ...p };
    delete hbPayload.logToSupabase;
    hbPayload.tabId = sender?.tab?.id ?? null;
    if (pnBufferExtensionLogForTab(sender?.tab?.id, sender?.tab?.url, 'jobs_page_heartbeat', hbPayload, 'info')) {
      sendResponse({ ok: true, buffered: true });
      return false;
    }
    postExtensionLog('jobs_page_heartbeat', hbPayload)
      .then((r) => {
        if (r && r.skipped) {
          sendResponse({ ok: true, logged: false, skipped: true });
        } else {
          sendResponse(r);
        }
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.action === 'enqueueFinancialPrefetch') {
    const companyName = String(msg.companyName || '').trim();
    swFinancialPrefetchEnqueue(companyName, msg.companyContext || null)
      .then((r) => {
        void postExtensionLog('financial_prefetch_message', {
          company_name: companyName.slice(0, 120),
          mode: r?.mode || null,
          ok: !!r?.ok,
          tabId: sender?.tab?.id ?? null,
          pageUrl: sender?.tab?.url || null
        }).catch(() => {});
        sendResponse(r);
      })
      .catch((e) => {
        const err = String(e && e.message ? e.message : e);
        void postExtensionLog(
          'financial_prefetch_message',
          {
            company_name: companyName.slice(0, 120),
            ok: false,
            error: err.slice(0, 500),
            tabId: sender?.tab?.id ?? null,
            pageUrl: sender?.tab?.url || null
          },
          'warn'
        ).catch(() => {});
        sendResponse({ ok: false, error: err });
      });
    return true;
  }

  if (msg.action === 'getFinancialData') {
    const name = String(msg.companyName || '').trim();
    if (!name) {
      sendResponse({ ok: false, error: 'Nom manquant' });
      return false;
    }
    swGetFinancialData(name, !!msg.forceRefresh, msg.companyContext || null)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => {
        const msgStr = String(err && err.message ? err.message : err);
        if (msgStr.startsWith('CONTEXTE_MATCH_INCOMPLET:')) {
          try {
            const parsed = JSON.parse(msgStr.slice('CONTEXTE_MATCH_INCOMPLET:'.length));
            sendResponse({
              ok: false,
              error: 'Contexte de matching incomplet.',
              missing: parsed.missing,
              code: 'MATCH_CONTEXT'
            });
            return;
          } catch (_) {}
        }
        sendResponse({ ok: false, error: msgStr });
      });
    return true;
  }

  if (msg.action === 'checkHubSpotCompany') {
    swCheckHubSpotCompany(String(msg.companyName || '').trim())
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ exists: false, configured: false }));
    return true;
  }

  if (msg.action === 'addToHubSpot') {
    swAddToHubSpot(
      String(msg.companyName || '').trim(),
      msg.type,
      msg.jobTitle || '',
      msg.jobUrl || ''
    )
      .then((data) => sendResponse({ ok: true, id: data?.id, updated: !!data?.updated }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (msg.action === 'checkSavedJobsInSupabase') {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    swCheckSavedJobsPresenceInSupabase(items)
      .then((present) => {
        const merged =
          typeof tabId === 'number'
            ? pnMergeBufferedJobDedupKeys(tabId, tabUrl, items, present)
            : present || {};
        const idsToTouch = [];
        for (const it of items) {
          const dk = it?.dedupKey;
          const jid = it?.linkedinJobId != null ? String(it.linkedinJobId).trim() : '';
          if (dk && jid && merged[dk]) idsToTouch.push(jid);
        }
        if (idsToTouch.length && typeof tabId === 'number') {
          pnBufferTouchJobIdsForTab(tabId, tabUrl, idsToTouch);
        }
        sendResponse({ ok: true, present: merged });
      })
      .catch((err) =>
        sendResponse({ ok: false, error: err?.message || String(err), present: {} })
      );
    return true;
  }

  if (msg.action === 'touchSavedJobsLastSeen') {
    const ids = Array.isArray(msg.linkedinJobIds) ? msg.linkedinJobIds : [];
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    if (pnBufferTouchJobIdsForTab(tabId, tabUrl, ids)) {
      sendResponse({ ok: true, buffered: true });
      return false;
    }
    swTouchSavedJobsLastSeenAt(ids)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'saveJobOffer') {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    const dedupKey = msg.dedupKey != null ? String(msg.dedupKey) : '';
    if (pnBufferSaveJobOfferForTab(tabId, tabUrl, msg.jobOffer || null, dedupKey)) {
      sendResponse({ ok: true, buffered: true });
      return false;
    }
    swSaveJobOffer(msg.jobOffer || null)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'saveJobOfferAndConfirm') {
    const jobOffer = msg.jobOffer || null;
    swSaveJobOffer(jobOffer)
      .then(async (result) => {
        let persistedComplete = false;
        try {
          const linkedinJobId = String(jobOffer?.linkedinJobId || '').trim();
          const jobUrl = String(jobOffer?.jobUrl || '').trim();
          const probe = [{ dedupKey: '__confirm__', linkedinJobId: linkedinJobId || null, jobUrl: jobUrl || null }];
          const present = await swCheckSavedJobsPresenceInSupabase(probe);
          persistedComplete = !!present.__confirm__;
        } catch (_) {}
        sendResponse({ ok: true, persistedComplete, ...result });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message, persistedComplete: false }));
    return true;
  }

  return false;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void pnFlushTabBuffer(tabId);
});
