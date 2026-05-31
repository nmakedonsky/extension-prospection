/**
 * Extraction financière via Gemini à partir du contexte LinkedIn (logo image + texte).
 * sw-company-match-prompt.js doit être chargé avant ce fichier.
 */
/** Modèle unique extraction / résumé financiers (Google AI `generativelanguage` v1beta). */
const FGC_GEMINI_MODEL_ID = 'gemini-2.5-flash-lite';
const FGC_GEMINI_TRANSIENT_MAX_RETRIES = 1;
const FGC_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function fgcGeminiGenerateContentOnce(apiKey, requestBody, label) {
  const url = `${FGC_GEMINI_BASE}/${FGC_GEMINI_MODEL_ID}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let lastError = null;
  for (let attempt = 0; attempt <= FGC_GEMINI_TRANSIENT_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(`${label} ${FGC_GEMINI_MODEL_ID} ${response.status}: ${text.slice(0, 200)}`);
        const transient = response.status === 429 || response.status === 500 || response.status === 503;
        if (transient && attempt < FGC_GEMINI_TRANSIENT_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
          continue;
        }
        throw lastError;
      }
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || err);
      const m = /\bgemini-[\w.-]+\s+(\d{3})\b/.exec(msg);
      const status = m ? Number(m[1]) : null;
      const transient = status === 429 || status === 500 || status === 503;
      if (transient && attempt < FGC_GEMINI_TRANSIENT_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error(`${label}: Gemini ${FGC_GEMINI_MODEL_ID} a échoué`);
}

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

async function extractFinancialFromCompanyContext(companyName, companyContext, geminiApiKey) {
  if (!geminiApiKey) return null;
  const instruction = buildFinancialExtractionInstructions(companyName);
  const parts = swBuildGeminiPartsWithMatchContext(companyName, companyContext || {}, instruction);
  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2800
    }
  };

  const data = await fgcGeminiGenerateContentOnce(geminiApiKey, requestBody, 'Gemini context extraction');
  return parseGeminiCandidateJson(data);
}
