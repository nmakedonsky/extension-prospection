/**
 * Point d’entrée LLM unique : OpenRouter (API compatible OpenAI).
 * Tous les appels modèle de l’extension passent par ici.
 */

const OR_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OR_TRANSIENT_MAX_RETRIES = 1;

/** Classification Client/SS2I + extraction financière + résumé. */
const OR_MODEL_FAST = 'google/gemini-2.5-flash-lite';
/** Bench / backfill légitimité (recherche web). */
const OR_MODEL_LEGITIMACY = 'google/gemini-2.5-flash';

/**
 * @param {object} [config]
 * @returns {string|null}
 */
function orResolveApiKey(config) {
  const c = config && typeof config === 'object' ? config : {};
  const or = String(c.openRouterApiKey || '').trim();
  if (or) return or;
  // Ancien champ : n’accepter que si c’est déjà une clé OpenRouter (pas AIza…).
  const legacy = String(c.geminiApiKey || '').trim();
  if (legacy.startsWith('sk-or-')) return legacy;
  return null;
}

async function getOpenRouterApiKey() {
  if (typeof loadConfig !== 'function') return null;
  return orResolveApiKey(await loadConfig());
}

/**
 * Convertit les parts style Gemini ({ text } | { inlineData }) en content OpenAI multimodal.
 * @param {Array<{ text?: string, inlineData?: { mimeType: string, data: string } }>} parts
 * @returns {Array<{ type: string, text?: string, image_url?: { url: string } }>}
 */
function orPartsToOpenAIContent(parts) {
  const content = [];
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    if (p.inlineData?.data && p.inlineData?.mimeType) {
      const mime = String(p.inlineData.mimeType).trim() || 'image/png';
      const b64 = String(p.inlineData.data).replace(/\s+/g, '');
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` }
      });
    }
    if (typeof p.text === 'string' && p.text) {
      content.push({ type: 'text', text: p.text });
    }
  }
  return content.length ? content : [{ type: 'text', text: '' }];
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {Array} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {Array|null} [opts.plugins] — ex. [{ id: 'web' }] pour recherche
 * @param {string} [opts.label]
 * @returns {Promise<object>} réponse JSON brute OpenRouter
 */
async function orChatCompletion(opts) {
  const apiKey = String(opts?.apiKey || '').trim();
  if (!apiKey) throw new Error('Clé API OpenRouter manquante.');
  const model = String(opts?.model || OR_MODEL_FAST).trim();
  const label = String(opts?.label || 'OpenRouter').slice(0, 64);
  const body = {
    model,
    messages: opts.messages || [],
    temperature: opts.temperature != null ? Number(opts.temperature) : 0,
    max_tokens: opts.maxTokens != null ? Number(opts.maxTokens) : 1024
  };
  if (Array.isArray(opts.plugins) && opts.plugins.length) {
    body.plugins = opts.plugins;
  }

  let lastError = null;
  for (let attempt = 0; attempt <= OR_TRANSIENT_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(OR_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/prospection-extension',
          'X-Title': 'Prospection LinkedIn Extension'
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`${label} ${model} ${response.status}: ${text.slice(0, 220)}`);
        const transient = response.status === 429 || response.status === 500 || response.status === 503;
        if (transient && attempt < OR_TRANSIENT_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
          continue;
        }
        throw lastError;
      }
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const m = /\s(\d{3}):\s/.exec(msg);
      const status = m ? Number(m[1]) : null;
      const transient = status === 429 || status === 500 || status === 503;
      if (transient && attempt < OR_TRANSIENT_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error(`${label}: OpenRouter ${model} a échoué`);
}

function orExtractMessageText(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : ''))
      .join('\n')
      .trim();
  }
  return '';
}

function orParseJsonFromText(raw) {
  const cleaned = String(raw || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('JSON introuvable dans la réponse LLM');
  }
  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

/**
 * Test de clé : liste des modèles (léger).
 * @param {string} apiKey
 */
async function testOpenRouter(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { ok: false, error: 'Clé API OpenRouter manquante.' };
  }
  const res = await fetch(OR_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text.slice(0, 500) || `HTTP ${res.status}` };
  }
  return { ok: true };
}
