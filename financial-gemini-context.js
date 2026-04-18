/**
 * Extraction financière via Gemini à partir du contexte LinkedIn (logo, URL société, lieu).
 * Chargé par importScripts avant sw-financial.js
 */
const FGC_GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];
const FGC_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function parseGeminiCandidateJson(data) {
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const cleaned = out.replace(/```json/gi, '').replace(/```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Gemini extraction JSON introuvable');
  }
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

function buildFinancialExtractionFromContextPrompt(companyName, ctx) {
  const logoUrl = ctx?.logoUrl || '';
  const logoAlt = ctx?.logoAlt || '';
  const li = ctx?.companyLinkedinUrl || '';
  const loc = ctx?.jobLocation || '';
  return `Tu es un analyste financier. Tu dois identifier l'entreprise réelle derrière l'offre LinkedIn, puis estimer les indicateurs financiers et signaux startup à partir de TES CONNAISSANCES PUBLIQUES (rapports annuels, presse, marchés, données cotées si applicable). Tu ne reçois pas d'articles : uniquement le contexte ci-dessous.

Contexte LinkedIn / affichage :
- Nom affiché : "${companyName}"
- Lieu du poste (si fourni) : "${loc}"
- URL logo : "${logoUrl}"
- Texte alt logo : "${logoAlt}"
- URL page entreprise LinkedIn : "${li}"

Étapes :
1) Déduis quelle entreprise du monde réel correspond le mieux (homonymes, filiales : précise dans identification_notes).
2) Remplis les chiffres en millions de la devise principale (EUR pour une société européenne dominante, USD si société US dominante) ; indique la devise implicite dans identification_notes si utile.
3) revenue = chiffre d'affaires annuel récent en millions (M€ / M$), sauf si tu dois utiliser le montant absolu en euros (> 1e9). employees = effectif (ETP) récent.
4) revenuePerEmployee = uniquement le CA par employé en milliers (k€ ou k$ par tête), typiquement entre ~50 et ~800 pour les grands groupes — jamais en euros bruts par tête (pas 600000) ; sinon null.
5) net_income_per_employee et fcf_per_employee : en milliers par tête (k), pas en euros bruts ; sinon null.
6) Marges en pourcentage (ex. 12 pour 12 %).
7) Si tu ne peux pas estimer raisonnablement une métrique, mets null et une confidence basse sur ce champ.
8) globalConfidence : ta confiance globale 0–100 sur l'ensemble de l'extraction.

Retourne UNIQUEMENT un JSON valide :
{
  "identified_company_name": "string",
  "identification_notes": "string|null",
  "revenue": {"value": number|null, "confidence": number, "url": "string|null"},
  "revenue_previous": {"value": number|null, "confidence": number, "url": "string|null"},
  "employees": {"value": number|null, "confidence": number, "url": "string|null"},
  "ebitda": {"value": number|null, "confidence": number, "url": "string|null"},
  "ebitda_margin": {"value": number|null, "confidence": number, "url": "string|null"},
  "operating_cash_flow": {"value": number|null, "confidence": number, "url": "string|null"},
  "operating_cashflow_positive": {"value": true|false|null, "confidence": number, "url": "string|null"},
  "revenue_growth": {"value": number|null, "confidence": number, "url": "string|null"},
  "revenue_growth_3y_cagr": {"value": number|null, "confidence": number, "url": "string|null"},
  "revenuePerEmployee": {"value": number|null, "confidence": number, "url": "string|null"},
  "net_margin": {"value": number|null, "confidence": number, "url": "string|null"},
  "gross_margin": {"value": number|null, "confidence": number, "url": "string|null"},
  "cash_to_total_assets": {"value": number|null, "confidence": number, "url": "string|null"},
  "net_debt_ebitda": {"value": number|null, "confidence": number, "url": "string|null"},
  "capex_to_revenue_pct": {"value": number|null, "confidence": number, "url": "string|null"},
  "rnd_to_revenue_pct": {"value": number|null, "confidence": number, "url": "string|null"},
  "net_income_per_employee": {"value": number|null, "confidence": number, "url": "string|null"},
  "fcf_per_employee": {"value": number|null, "confidence": number, "url": "string|null"},
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

async function extractFinancialFromCompanyContext(companyName, companyContext, geminiApiKey) {
  if (!geminiApiKey) return null;
  const prompt = buildFinancialExtractionFromContextPrompt(companyName, companyContext || {});
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2800
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
        lastError = new Error(`Gemini context extraction ${model} ${response.status}: ${text.slice(0, 200)}`);
        continue;
      }
      const data = JSON.parse(text);
      return parseGeminiCandidateJson(data);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Extraction financière (contexte) : tous les modèles ont échoué');
}
