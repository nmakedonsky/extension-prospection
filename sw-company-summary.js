/**
 * Court résumé d’activité (OpenRouter) — aide à juger la pertinence d’un prospect.
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

function swParseSummaryPlainText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
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
  openRouterApiKey,
  identificationNotes,
  identifiedCompanyName
) {
  if (!openRouterApiKey) return null;
  const instruction = swBuildCompanySummaryInstruction(
    companyName,
    identificationNotes || '',
    identifiedCompanyName || ''
  );
  const parts = swBuildGeminiPartsWithMatchContext(companyName, companyContext || {}, instruction);
  const content = orPartsToOpenAIContent(parts);

  try {
    const data = await orChatCompletion({
      apiKey: openRouterApiKey,
      model: OR_MODEL_FAST,
      messages: [{ role: 'user', content }],
      temperature: 0.25,
      maxTokens: 512,
      label: 'OpenRouter résumé'
    });
    const s = swParseSummaryPlainText(orExtractMessageText(data));
    return s || null;
  } catch (err) {
    console.warn('[Prospection SW] Résumé entreprise:', err?.message || err);
    return null;
  }
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
async function swEnsureCompanySummaryCached(companyName, companyContext, openRouterApiKey, cached) {
  if (!cached || !openRouterApiKey) return null;
  if (cached.companySummary && String(cached.companySummary).trim()) return cached.companySummary;
  const v = swValidateMatchContext(companyContext);
  if (!v.ok) return null;
  const hints = swIdentificationNotesFromCached(cached);
  const resolvedName = swIdentifiedCompanyNameFromCached(cached);
  const summary = await swFetchCompanySummary(
    companyName,
    companyContext,
    openRouterApiKey,
    hints,
    resolvedName
  );
  if (!summary) return null;
  const merged = { ...cached, companySummary: summary };
  await swSetFinancialCache(companyName, merged);
  return summary;
}
