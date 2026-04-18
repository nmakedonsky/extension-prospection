/**
 * Court résumé d’activité (Gemini) — aide à juger la pertinence d’un prospect (réseau, enseigne, etc.).
 * Réutilise FGC_GEMINI_MODELS / FGC_GEMINI_BASE depuis financial-gemini-context.js.
 */

/** Instructions résumé uniquement (bloc matching + image déjà ajoutés par swBuildGeminiPartsWithMatchContext). */
function swBuildCompanySummaryInstruction(companyName, identificationNotes, identifiedCompanyName) {
  const notes = identificationNotes ? String(identificationNotes).slice(0, 1200) : '';
  const resolved =
    identifiedCompanyName && String(identifiedCompanyName).trim()
      ? String(identifiedCompanyName).trim().replace(/"/g, '\\"')
      : '';

  const alignBlock = resolved
    ? `IMPORTANT — L’analyse financière (chiffres déjà calculés) porte sur l’entité : « ${resolved} ».
Ton résumé doit décrire **exactement cette même entreprise** (secteur, nature : industrie, retail, luxe, services, tech, etc.). Ne confonds pas avec une homonyme.

`
    : `Décris l’activité réelle la plus probable à partir du contexte d’identification ci-dessus.

`;

  return `Tu rédiges un court texte pour un lecteur business (prospection). Style neutre, tous secteurs — ne présuppose pas une ESN ou un cabinet IT.

${alignBlock}${notes ? `Notes complémentaires (extraction financière) : ${notes}\n\n` : ''}Rédige UNIQUEMENT un texte en français, 2 à 4 phrases courtes (maximum environ 450 caractères) :
- Nature de l’entité (réseau, groupement, siège, enseigne, industrie, services, etc.) ;
- Secteur ou activité principale, **alignée** sur l’entité résolue pour les chiffres (référence nom : "${String(companyName || '').replace(/"/g, '\\"')}") ;
- Si le nom LinkedIn est ambigu, une phrase pour lever l’ambiguïté.

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
async function swFetchCompanySummary(
  companyName,
  companyContext,
  geminiApiKey,
  identificationNotes,
  identifiedCompanyName
) {
  if (!geminiApiKey) return null;
  const instruction = swBuildCompanySummaryInstruction(
    companyName,
    identificationNotes || '',
    identifiedCompanyName || ''
  );
  const parts = swBuildGeminiPartsWithMatchContext(companyName, companyContext || {}, instruction);
  const requestBody = {
    contents: [{ parts }],
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

function swIdentifiedCompanyNameFromCached(cached) {
  const raw = cached?.unified?.llm_raw || cached?.raw?.llm;
  const n = raw?.identified_company_name;
  return typeof n === 'string' ? n.trim() : '';
}

/**
 * Complète un cache ancien sans résumé (un seul appel LLM puis mise à jour locale).
 * @returns {Promise<string|null>}
 */
async function swEnsureCompanySummaryCached(companyName, companyContext, geminiApiKey, cached) {
  if (!cached || !geminiApiKey) return null;
  if (cached.companySummary && String(cached.companySummary).trim()) return cached.companySummary;
  const v = swValidateMatchContext(companyContext);
  if (!v.ok) return null;
  const hints = swIdentificationNotesFromCached(cached);
  const resolvedName = swIdentifiedCompanyNameFromCached(cached);
  const summary = await swFetchCompanySummary(
    companyName,
    companyContext,
    geminiApiKey,
    hints,
    resolvedName
  );
  if (!summary) return null;
  const merged = { ...cached, companySummary: summary };
  await swSetFinancialCache(companyName, merged);
  return summary;
}
