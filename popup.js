/**
 * Popup — charge / enregistre la config et déclenche les tests via le service worker.
 */

function $(id) {
  return document.getElementById(id);
}

function setStatus(el, text, kind) {
  el.textContent = text || '';
  el.classList.remove('ok', 'err');
  if (kind === 'ok') el.classList.add('ok');
  if (kind === 'err') el.classList.add('err');
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

async function loadFields() {
  const config = await getConfig();
  $('geminiKey').value = config.geminiApiKey || '';
  $('supabaseUrl').value = config.supabaseUrl || '';
  $('supabaseKey').value = config.supabaseAnonKey || '';
  $('hubspotKey').value = config.hubspotApiKey || '';
  const region = String(config.hubspotRegion || 'eu').toLowerCase();
  $('hubspotRegion').value = region === 'us' ? 'us' : 'eu';
}

document.addEventListener('DOMContentLoaded', () => {
  loadFields().catch(() => {});

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
});
