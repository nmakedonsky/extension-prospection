/**
 * Service worker — tests de connexion + journalisation optionnelle (Supabase).
 */

const STORAGE_KEY_CONFIG = 'config';
const SUPABASE_LOGS_TABLE = 'extension_logs';
const EXTENSION_SOURCE = 'extension-prospection-next';

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
 */
async function postExtensionLog(event, data) {
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

  const body = {
    source: EXTENSION_SOURCE,
    level: 'info',
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
