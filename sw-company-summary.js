/**
 * Court résumé d’activité (Gemini) — aide à juger la pertinence d’un prospect (réseau, enseigne, etc.).
 * Réutilise FGC_GEMINI_MODELS / FGC_GEMINI_BASE depuis financial-gemini-context.js.
 */

function swBuildCompanySummaryPrompt(companyName, ctx, identificationNotes) {
  const loc = ctx?.jobLocation || '';
  const li = ctx?.companyLinkedinUrl || '';
  const logoAlt = ctx?.logoAlt || '';
  const notes = identificationNotes ? String(identificationNotes).slice(0, 1200) : '';
  return `Tu aides un commercial B2B (services IT / conseil) en France.

Nom affiché sur LinkedIn : "${String(companyName || '').replace(/"/g, '\\"')}"
Lieu de l’offre (si connu) : "${String(loc).replace(/"/g, '\\"')}"
URL page entreprise LinkedIn : "${String(li).replace(/"/g, '\\"')}"
Texte alt du logo (si connu) : "${String(logoAlt).replace(/"/g, '\\"')}"
${notes ? `Notes internes d’identification (extrait LLM) : ${notes}` : ''}

Rédige UNIQUEMENT un texte en français, 2 à 4 phrases courtes (maximum environ 450 caractères), pour qu’on comprenne vite :
- À quoi correspond cette entité (réseau / groupement / franchise / siège / enseigne locale / ESN / autre) ;
- Le secteur ou l’activité principale ;
- Si le nom affiché est ambigu ou trompeur par rapport à l’activité réelle, l’indiquer clairement (ex. réseau de pharmacies indépendantes vs industrie pharmaceutique).

Pas de titre, pas de liste à puces, pas de guillemets englobant tout le texte.`;
}

function swParseGeminiPlainText(data) {
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof out !== 'string') return '';
  return out
    .replace(/\r/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .trim()
    .slice(0, 520);
}

/**
 * @returns {Promise<string|null>}
 */
async function swFetchCompanySummary(companyName, companyContext, geminiApiKey, identificationNotes) {
  if (!geminiApiKey) return null;
  const prompt = swBuildCompanySummaryPrompt(companyName, companyContext || {}, identificationNotes || '');
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 512
    }
  };

  let lastError = null;
  for (const model of FGC_GEMINI_MODELS) {
    try {
      const url = `${FGC_GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`Gemini résumé ${model} ${response.status}: ${text.slice(0, 200)}`);
        continue;
      }
      const data = JSON.parse(text);
      const s = swParseGeminiPlainText(data);
      return s || null;
    } catch (err) {
      lastError = err;
    }
  }
  console.warn('[Prospection SW] Résumé entreprise:', lastError?.message || lastError);
  return null;
}

function swIdentificationNotesFromCached(cached) {
  const u = cached?.unified;
  const raw = u?.llm_raw || cached?.raw?.llm;
  const n = raw?.identification_notes;
  return typeof n === 'string' ? n : '';
}

/**
 * Complète un cache ancien sans résumé (un seul appel LLM puis mise à jour locale).
 * @returns {Promise<string|null>}
 */
async function swEnsureCompanySummaryCached(companyName, companyContext, geminiApiKey, cached) {
  if (!cached || !geminiApiKey) return null;
  if (cached.companySummary && String(cached.companySummary).trim()) return cached.companySummary;
  const hints = swIdentificationNotesFromCached(cached);
  const summary = await swFetchCompanySummary(companyName, companyContext, geminiApiKey, hints);
  if (!summary) return null;
  const merged = { ...cached, companySummary: summary };
  await swSetFinancialCache(companyName, merged);
  return summary;
}
