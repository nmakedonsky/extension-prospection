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
  $('linkedinCollectionsCardCss').value = config.linkedinCollectionsCardCss || '';
  $('linkedinCollectionsCompanyCss').value = config.linkedinCollectionsCompanyCss || '';
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

  $('saveLinkedinSelectors').addEventListener('click', async () => {
    const el = $('linkedinDiagStatus');
    try {
      await saveConfig({
        linkedinCollectionsCardCss: $('linkedinCollectionsCardCss').value.trim(),
        linkedinCollectionsCompanyCss: $('linkedinCollectionsCompanyCss').value.trim()
      });
      setStatus(el, 'Sélecteurs enregistrés. Rechargez l’onglet LinkedIn Jobs.', 'ok');
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
