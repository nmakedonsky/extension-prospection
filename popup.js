/**
 * Popup — raccourcis recherches Jobs + configuration API (menu repliable).
 */

function $(id) {
  return document.getElementById(id);
}

const STORAGE_KEY_SAVED_SEARCHES = 'lphSavedJobSearches';
const MAX_SAVED_SEARCHES = 5;

function linkedInJobsSearchUrl(keywords) {
  return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}`;
}

const DEFAULT_SAVED_JOB_SEARCHES = [
  {
    title: 'Lead / ownership data',
    url: linkedInJobsSearchUrl('Head of Data OR Lead Data OR Data Platform Lead')
  },
  {
    title: 'Ingénieur / plateforme data',
    url: linkedInJobsSearchUrl('Data Engineer Snowflake Airflow dbt')
  },
  {
    title: 'BI (votre axe fort)',
    url: linkedInJobsSearchUrl('Power BI PowerBI Lead Senior Manager Expert')
  },
  {
    title: 'Gouvernance / qualité',
    url: linkedInJobsSearchUrl('Data Governance Data Quality Responsable données')
  },
  {
    title: 'Transfo / digital avec dimension data',
    url: linkedInJobsSearchUrl('Digital Manager data BI analytics données')
  }
];

function setStatus(el, text, kind) {
  el.textContent = text || '';
  el.classList.remove('ok', 'err', 'warn');
  if (kind === 'ok') el.classList.add('ok');
  if (kind === 'err') el.classList.add('err');
  if (kind === 'warn') el.classList.add('warn');
}

async function getConfig() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_CONFIG' }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!res || !res.ok) {
        reject(new Error((res && res.error) || 'Réponse invalide'));
        return;
      }
      resolve(res.config || {});
    });
  });
}

async function saveConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', payload: next }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!res || !res.ok) {
        reject(new Error((res && res.error) || 'Enregistrement impossible'));
        return;
      }
      resolve();
    });
  });
}

function sendTest(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(res);
    });
  });
}

function normalizeJobSearchUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function isLinkedInJobsUrl(u) {
  try {
    const p = new URL(u);
    const host = p.hostname.toLowerCase();
    const hostOk =
      host === 'linkedin.com' ||
      host === 'www.linkedin.com' ||
      host.endsWith('.linkedin.com');
    return hostOk && /\/jobs/i.test(`${p.pathname}${p.search}`);
  } catch {
    return false;
  }
}

function renderSavedSearches(rows) {
  const c = $('savedSearchesContainer');
  c.replaceChildren();

  for (let i = 0; i < MAX_SAVED_SEARCHES; i++) {
    const row = rows[i] || { title: '', url: '' };
    const slot = document.createElement('div');
    slot.className = 'search-slot';

    const head = document.createElement('div');
    head.className = 'search-slot-head';
    head.textContent = `Recherche ${i + 1}`;
    slot.appendChild(head);

    const lt = document.createElement('label');
    lt.htmlFor = `searchTitle${i}`;
    lt.textContent = 'Nom affiché';
    slot.appendChild(lt);

    const it = document.createElement('input');
    it.type = 'text';
    it.id = `searchTitle${i}`;
    it.placeholder = 'ex. Lead / ownership data';
    it.value = row.title || '';
    it.autocomplete = 'off';
    slot.appendChild(it);

    const lu = document.createElement('label');
    lu.htmlFor = `searchUrl${i}`;
    lu.style.marginTop = '8px';
    lu.textContent = 'URL';
    slot.appendChild(lu);

    const iu = document.createElement('input');
    iu.type = 'text';
    iu.id = `searchUrl${i}`;
    iu.placeholder = 'https://www.linkedin.com/jobs/search/?keywords=...';
    iu.value = row.url || '';
    iu.spellcheck = false;
    iu.autocomplete = 'off';
    slot.appendChild(iu);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const ob = document.createElement('button');
    ob.type = 'button';
    ob.className = 'secondary open-search';
    ob.textContent = 'Ouvrir';
    ob.addEventListener('click', () => openSavedSearch(i));
    actions.appendChild(ob);
    slot.appendChild(actions);

    c.appendChild(slot);
  }
}

function allSearchUrlsEmpty(rows) {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every((r) => !String(r?.url || '').trim())
  );
}

async function loadSavedSearches() {
  const result = await chrome.storage.local.get(STORAGE_KEY_SAVED_SEARCHES);
  let rows = result[STORAGE_KEY_SAVED_SEARCHES];
  if (!Array.isArray(rows)) rows = [];

  const shouldSeedDefaults = rows.length === 0 || allSearchUrlsEmpty(rows);
  if (shouldSeedDefaults) {
    rows = DEFAULT_SAVED_JOB_SEARCHES.map((r) => ({ ...r }));
    await chrome.storage.local.set({ [STORAGE_KEY_SAVED_SEARCHES]: rows });
  } else {
    while (rows.length < MAX_SAVED_SEARCHES) {
      rows.push({ title: '', url: '' });
    }
    rows = rows.slice(0, MAX_SAVED_SEARCHES);
  }

  renderSavedSearches(rows);
}

async function persistSearchesFromForm() {
  const rows = [];
  for (let i = 0; i < MAX_SAVED_SEARCHES; i++) {
    const t = $(`searchTitle${i}`);
    const u = $(`searchUrl${i}`);
    rows.push({
      title: (t && t.value.trim()) || '',
      url: (u && u.value.trim()) || ''
    });
  }
  await chrome.storage.local.set({ [STORAGE_KEY_SAVED_SEARCHES]: rows });
  return rows;
}

async function openSavedSearch(index) {
  const u = $(`searchUrl${index}`);
  const raw = u ? u.value.trim() : '';
  const url = normalizeJobSearchUrl(raw);
  const status = $('searchesStatus');

  if (!url) {
    setStatus(status, 'Indique une URL pour cette recherche.', 'warn');
    return;
  }
  if (!isLinkedInJobsUrl(url)) {
    setStatus(status, 'URL invalide : une page LinkedIn Jobs (…/jobs/…).', 'warn');
    return;
  }

  setStatus(status, '', '');
  await chrome.tabs.create({ url });
}

async function loadApiFields() {
  const config = await getConfig();
  $('geminiKey').value = config.geminiApiKey || '';
  $('supabaseUrl').value = config.supabaseUrl || '';
  $('supabaseKey').value = config.supabaseAnonKey || '';
  $('hubspotKey').value = config.hubspotApiKey || '';
  const region = String(config.hubspotRegion || 'eu').toLowerCase();
  $('hubspotRegion').value = region === 'us' ? 'us' : 'eu';
}

document.addEventListener('DOMContentLoaded', () => {
  loadSavedSearches().catch(() => {});
  loadApiFields().catch(() => {});

  $('saveSearches').addEventListener('click', async () => {
    const el = $('searchesStatus');
    try {
      await persistSearchesFromForm();
      setStatus(el, 'Recherches enregistrées ✓', 'ok');
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('saveGemini').addEventListener('click', async () => {
    const el = $('geminiStatus');
    try {
      await saveConfig({ geminiApiKey: $('geminiKey').value.trim() });
      setStatus(el, 'Gemini : configuration enregistrée.', 'ok');
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('testGemini').addEventListener('click', async () => {
    const el = $('geminiStatus');
    setStatus(el, 'Test en cours…', '');
    try {
      const key = $('geminiKey').value.trim();
      const r = await sendTest('TEST_GEMINI', { apiKey: key });
      if (r.ok) {
        setStatus(el, 'Gemini : connexion OK.', 'ok');
      } else {
        setStatus(el, `Gemini : échec — ${r.error || 'erreur inconnue'}`, 'err');
      }
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('saveSupabase').addEventListener('click', async () => {
    const el = $('supabaseStatus');
    try {
      await saveConfig({
        supabaseUrl: $('supabaseUrl').value.trim(),
        supabaseAnonKey: $('supabaseKey').value.trim()
      });
      setStatus(el, 'Supabase : configuration enregistrée.', 'ok');
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('testSupabase').addEventListener('click', async () => {
    const el = $('supabaseStatus');
    setStatus(el, 'Test en cours…', '');
    try {
      const r = await sendTest('TEST_SUPABASE', {
        supabaseUrl: $('supabaseUrl').value.trim(),
        supabaseAnonKey: $('supabaseKey').value.trim()
      });
      if (r.ok) {
        setStatus(el, 'Supabase : connexion OK.', 'ok');
      } else {
        setStatus(el, `Supabase : échec — ${r.error || 'erreur inconnue'}`, 'err');
      }
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('saveHubspot').addEventListener('click', async () => {
    const el = $('hubspotStatus');
    try {
      await saveConfig({
        hubspotApiKey: $('hubspotKey').value.trim(),
        hubspotRegion: $('hubspotRegion').value
      });
      setStatus(el, 'HubSpot : configuration enregistrée.', 'ok');
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('testHubspot').addEventListener('click', async () => {
    const el = $('hubspotStatus');
    setStatus(el, 'Test en cours…', '');
    try {
      const r = await sendTest('TEST_HUBSPOT', {
        hubspotApiKey: $('hubspotKey').value.trim(),
        hubspotRegion: $('hubspotRegion').value
      });
      if (r.ok) {
        setStatus(el, 'HubSpot : connexion OK.', 'ok');
      } else {
        setStatus(el, `HubSpot : échec — ${r.error || 'erreur inconnue'}`, 'err');
      }
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('runDomDiagnostic').addEventListener('click', async () => {
    const el = $('linkedinDiagStatus');
    const out = $('linkedinDiagOut');
    setStatus(el, 'Collecte…', '');
    out.value = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus(el, 'Onglet actif introuvable.', 'err');
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'PROSPECTION_DOM_DIAGNOSTIC' }, (res) => {
        const last = chrome.runtime.lastError;
        if (last) {
          setStatus(el, `Impossible d’atteindre la page — ${last.message}`, 'err');
          return;
        }
        if (!res || !res.ok) {
          setStatus(el, (res && res.error) || 'Réponse invalide.', 'err');
          return;
        }
        out.value = JSON.stringify(res.report, null, 2);
        setStatus(el, 'Rapport prêt.', 'ok');
      });
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });

  $('copyDomDiagnostic').addEventListener('click', async () => {
    const el = $('linkedinDiagStatus');
    const t = $('linkedinDiagOut').value;
    if (!t) {
      setStatus(el, 'Rien à copier.', 'err');
      return;
    }
    try {
      await navigator.clipboard.writeText(t);
      setStatus(el, 'Copié dans le presse-papiers.', 'ok');
    } catch (e) {
      setStatus(el, String(e.message || e), 'err');
    }
  });
});
