/**
 * Extraction financière via OpenRouter (modèle Gemini) à partir du contexte LinkedIn.
 * sw-company-match-prompt.js + sw-openrouter.js doivent être chargés avant ce fichier.
 */

/** Instructions + schéma JSON uniquement (le bloc matching est ajouté par swBuildGeminiPartsWithMatchContext). */
function buildFinancialExtractionInstructions(companyName) {
  return `Tu es un analyste financier. Tu dois identifier l'entreprise réelle correspondant au **contexte d'identification ci-dessus** (image logo éventuelle + texte), puis estimer les indicateurs financiers et signaux startup à partir de TES CONNAISSANCES PUBLIQUES (rapports annuels, presse, marchés, données cotées si applicable). Tu ne reçois pas d'articles : uniquement le contexte fourni.

Référence nom pour les champs : "${String(companyName || '').replace(/"/g, '\\"')}"

Étapes :
1) Déduis quelle entreprise du monde réel correspond le mieux au contexte — en priorité l'encart entreprise LinkedIn (bas du descriptif : nom, effectifs, description) croisé avec le logo et l'URL /company/ si fournie (homonymes, filiales : précise dans identification_notes).
2) reporting_currency : **EUR** ou **USD** — devise unique pour tous les montants monétaires (société européenne dominante → EUR ; société US cotée en USD → USD).
3) **Convention unique (obligatoire)** : revenue, revenue_previous, market_cap, ebitda, net_income, operating_cash_flow, free_cash_flow, last_funding_amount = montant **en unités pleines** de reporting_currency (euros ou dollars entiers, pas de millions ni de milliards à convertir). Exemples : CA annuel ~4,79 Md$ → value **4790000000** ; ~96,5 Md€ → **96500000000** ; PME ~120 M€ → **120000000** ; résultat net ~1,3 Md$ → **1300000000**. Ne pas diviser ni multiplier par 1000 ou 1 000 000 : le nombre exact en € ou $.
4) employees = effectif (ETP) récent, **nombre de têtes entier**.
5) Marges et taux de croissance en pourcentage (ex. 12 pour 12 %, 9.3 pour 9.3 %). Ratios (ex. net_debt_ebitda) en multiplicateur simple (ex. 1.5).
6) Ne renvoie pas revenuePerEmployee, net_income_per_employee ni fcf_per_employee (calculés côté application).
7) Si tu ne peux pas estimer raisonnablement une métrique, mets null et une confidence basse sur ce champ.
8) globalConfidence : ta confiance globale 0–100 sur l'ensemble de l'extraction.

Retourne UNIQUEMENT un JSON valide :
{
  "identified_company_name": "string",
  "identification_notes": "string|null",
  "reporting_currency": "EUR"|"USD",
  "revenue": {"value": number|null, "confidence": number, "url": "string|null"},
  "revenue_previous": {"value": number|null, "confidence": number, "url": "string|null"},
  "employees": {"value": number|null, "confidence": number, "url": "string|null"},
  "ebitda": {"value": number|null, "confidence": number, "url": "string|null"},
  "net_income": {"value": number|null, "confidence": number, "url": "string|null"},
  "ebitda_margin": {"value": number|null, "confidence": number, "url": "string|null"},
  "operating_cash_flow": {"value": number|null, "confidence": number, "url": "string|null"},
  "operating_cashflow_positive": {"value": true|false|null, "confidence": number, "url": "string|null"},
  "revenue_growth": {"value": number|null, "confidence": number, "url": "string|null"},
  "revenue_growth_3y_cagr": {"value": number|null, "confidence": number, "url": "string|null"},
  "net_margin": {"value": number|null, "confidence": number, "url": "string|null"},
  "gross_margin": {"value": number|null, "confidence": number, "url": "string|null"},
  "cash_to_total_assets": {"value": number|null, "confidence": number, "url": "string|null"},
  "net_debt_ebitda": {"value": number|null, "confidence": number, "url": "string|null"},
  "capex_to_revenue_pct": {"value": number|null, "confidence": number, "url": "string|null"},
  "rnd_to_revenue_pct": {"value": number|null, "confidence": number, "url": "string|null"},
  "free_cash_flow": {"value": number|null, "confidence": number, "url": "string|null"},
  "market_cap": {"value": number|null, "confidence": number, "url": "string|null"},
  "funding_detected": boolean,
  "last_funding_amount": number|null,
  "last_funding_date": "YYYY-MM-DD|null",
  "funding_stage": "seed|series_a|series_b|series_c|other|null",
  "founding_year": number|null,
  "hiring_signal": {"value": number|null, "confidence": number, "url": "string|null"},
  "keywords_score": {"value": number|null, "confidence": number, "url": "string|null"},
  "keywords": ["string"],
  "expansion_detected": boolean|null,
  "globalConfidence": number
}`;
}

/**
 * @param {string} companyName
 * @param {object} companyContext
 * @param {string} openRouterApiKey
 */
async function extractFinancialFromCompanyContext(companyName, companyContext, openRouterApiKey) {
  if (!openRouterApiKey) return null;
  const instruction = buildFinancialExtractionInstructions(companyName);
  const parts = swBuildGeminiPartsWithMatchContext(companyName, companyContext || {}, instruction);
  const content = orPartsToOpenAIContent(parts);
  const data = await orChatCompletion({
    apiKey: openRouterApiKey,
    model: OR_MODEL_FAST,
    messages: [{ role: 'user', content }],
    temperature: 0,
    maxTokens: 2800,
    label: 'OpenRouter finance'
  });
  return orParseJsonFromText(orExtractMessageText(data));
}
