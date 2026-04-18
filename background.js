/**
 * Service worker — tests de connexion + journalisation optionnelle (Supabase).
 */

const STORAGE_KEY_CONFIG = 'config';
const STORAGE_KEY_COMPANIES = 'prospectionCompaniesCache';
const SUPABASE_LOGS_TABLE = 'extension_logs';
const SUPABASE_COMPANIES_TABLE = 'companies';
const EXTENSION_SOURCE = 'extension-prospection-next';

const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** @type {Map<string, Promise<'Client'|'SS2I'|null>>} */
const inflightClassify = new Map();

/**
 * @returns {Promise<{ geminiApiKey?: string, supabaseUrl?: string, supabaseAnonKey?: string, hubspotApiKey?: string, hubspotRegion?: string }>}
 */
async function loadConfig() {
  const r = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  const c = r[STORAGE_KEY_CONFIG];
  return c && typeof c === 'object' ? c : {};
}

/**
 * Liste les modèles disponibles (vérifie la clé Gemini).
 */
async function testGemini(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Clé API Gemini manquante.' };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}` };
  }
  return { ok: true };
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
 * Requête CRM minimale — vérifie le jeton Private App.
 */
async function testHubSpot(apiKey, region) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Clé API HubSpot manquante.' };
  }
  const origin = hubspotApiOrigin(region);
  const res = await fetch(`${origin}/crm/v3/objects/contacts?limit=1`, {
    headers: {
      Authorization: `Bearer ${key}`
    }
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}` };
  }
  return { ok: true };
}

async function getGeminiApiKey() {
  const c = await loadConfig();
  const k = String(c.geminiApiKey || '').trim();
  return k || null;
}

/**
 * @param {string} companyName
 * @returns {Promise<'Client'|'SS2I'>}
 */
async function classifyCompanyWithGemini(companyName) {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) {
    throw new Error('Clé API Gemini non configurée.');
  }

  const prompt = `Tu es un expert en classification d'entreprises françaises.
Pour l'entreprise donnée, réponds UNIQUEMENT par un des deux mots suivants :
- SS2I : si c'est une ESN, SS2I, cabinet de conseil, ou société de services
- Client : si c'est une entreprise client finale (industrie, banque, retail, etc.)

Entreprise : "${companyName}"`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 20 }
  };

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`Gemini ${model} ${response.status}: ${text.slice(0, 200)}`);
        continue;
      }
      const data = JSON.parse(text);
      const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!out) {
        lastError = new Error(`Réponse vide (${model})`);
        continue;
      }
      const normalized = out.trim().toLowerCase();
      if (normalized.includes('client')) return 'Client';
      if (normalized.includes('ss2i') || normalized.includes('esn') || normalized.includes('consulting')) {
        return 'SS2I';
      }
      return 'SS2I';
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Tous les modèles Gemini ont échoué');
}

async function getCompanyFromSupabase(companyName) {
  const config = await loadConfig();
  const url = String(config.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = String(config.supabaseAnonKey || '').trim();
  if (!url || !key) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/${SUPABASE_COMPANIES_TABLE}?company_name=eq.${encodeURIComponent(companyName)}&select=type`,
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
    const t = rows?.[0]?.type;
    return t === 'Client' || t === 'SS2I' ? t : null;
  } catch (_) {
    return null;
  }
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
 * Cache local → Supabase → Gemini ; dédoublonne les appels en cours par nom d’entreprise.
 * @param {string} companyName
 * @returns {Promise<'Client'|'SS2I'|null>}
 */
async function getOrClassifyCompany(companyName) {
  const trimmed = String(companyName || '').trim();
  if (!trimmed) return null;

  const stored = await chrome.storage.local.get(STORAGE_KEY_COMPANIES);
  const companies = stored[STORAGE_KEY_COMPANIES] || {};
  if (companies[trimmed] === 'Client' || companies[trimmed] === 'SS2I') {
    upsertCompanyToSupabase(trimmed, companies[trimmed]).catch(() => {});
    return companies[trimmed];
  }

  const fromDb = await getCompanyFromSupabase(trimmed);
  if (fromDb) {
    void logToSupabase('company_classified', {
      company_name: trimmed.slice(0, 120),
      type: fromDb,
      via: 'supabase'
    });
    companies[trimmed] = fromDb;
    await chrome.storage.local.set({ [STORAGE_KEY_COMPANIES]: companies });
    return fromDb;
  }

  if (inflightClassify.has(trimmed)) {
    return inflightClassify.get(trimmed);
  }

  const task = (async () => {
    try {
      const type = await classifyCompanyWithGemini(trimmed);
      void logToSupabase('company_classified', {
        company_name: trimmed.slice(0, 120),
        type,
        via: 'gemini'
      });
      await upsertCompanyToSupabase(trimmed, type);
      const r2 = await chrome.storage.local.get(STORAGE_KEY_COMPANIES);
      const c2 = r2[STORAGE_KEY_COMPANIES] || {};
      c2[trimmed] = type;
      await chrome.storage.local.set({ [STORAGE_KEY_COMPANIES]: c2 });
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
  return { ok: true };
}

function logToSupabase(event, data, level) {
  return postExtensionLog(event, data, level || 'info').catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') {
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

  if (msg.type === 'TEST_GEMINI') {
    testGemini(msg.apiKey)
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

  if (msg.type === 'JOBS_PAGE_HEARTBEAT') {
    const p = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    if (!p.logToSupabase) {
      sendResponse({ ok: true, logged: false });
      return false;
    }
    postExtensionLog('jobs_page_heartbeat', {
      cardCount: p.cardCount,
      companyCount: p.companyCount,
      sampleCompanies: p.sampleCompanies,
      pageUrl: p.pageUrl,
      tabId: sender?.tab?.id ?? null
    })
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

  return false;
});
