(() => {
  function getValue(maybe) {
    if (maybe == null) return null;
    if (typeof maybe === 'object' && Object.prototype.hasOwnProperty.call(maybe, 'value')) return maybe.value;
    return maybe;
  }

  /** Plafond raisonnable (unités pleines) pour CA, cape, trésorerie agrégée — au-delà, on considère une erreur d'échelle. */
  const LLM_MONEY_MAX_ABS = 12e12;
  const LLM_MONEY_FROM_MILLIONS = 1e6;

  function withinMoneyCap(absVal) {
    return Number.isFinite(absVal) && Math.abs(absVal) <= LLM_MONEY_MAX_ABS;
  }

  /**
   * Contrat harmonisé (prompt Gemini) : `value` est **toujours en millions** de la devise de reporting
   * (ex. CA ~96,5 Md → 96500 ; ~130 Md$ → 130000). Le dock attend des unités pleines.
   * Repli si échelle incohérente : millions gonflés ×1000 ; ou valeurs déjà en unités pleines ≥ 1e9 (legacy / erreur prompt).
   */
  function llmMoneyMillionsToAbsolute(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const x = Number(v);
    if (x === 0) return 0;
    const primary = x * LLM_MONEY_FROM_MILLIONS;
    if (withinMoneyCap(primary)) return primary;
    const altThousands = (x / 1000) * LLM_MONEY_FROM_MILLIONS;
    if (withinMoneyCap(altThousands)) return altThousands;
    if (Math.abs(x) >= 1e9 && withinMoneyCap(x)) return x;
    return null;
  }

  /**
   * Calcule CA/salarié en milliers (k€ / k$) : revenue attendu en unités pleines, employees en têtes.
   */
  function inferRevenuePerEmployeeK(revenue, employees) {
    const R = Number(revenue);
    const E = Number(employees);
    if (!Number.isFinite(R) || !Number.isFinite(E) || E <= 0) return null;
    return (R / E) / 1000;
  }

  /** LLM ou calcul parfois en €/tête au lieu de k€/tête */
  function coercePerEmployeeK(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    let x = Number(v);
    if (Math.abs(x) > 50000) x = x / 1000;
    return x;
  }

  function normalizeReportingCurrency(llm) {
    const raw =
      (typeof llm?.reporting_currency === 'string' && llm.reporting_currency) ||
      (typeof llm?.reportingCurrency === 'string' && llm.reportingCurrency) ||
      '';
    const s = String(raw)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
    if (s === 'USD' || s === 'US$' || s === 'DOLLARS' || s === 'DOLLAR') return 'USD';
    if (s === 'EUR' || s === '€' || s === 'EUROS' || s === 'EURO') return 'EUR';
    return null;
  }

  function normalizeLlmFinancials(llm) {
    const reporting_currency = normalizeReportingCurrency(llm);
    const revenue = llmMoneyMillionsToAbsolute(getValue(llm?.revenue));
    const employees = getValue(llm?.employees);
    const revenuePerEmployeeRaw =
      getValue(llm?.revenuePerEmployee) ??
      (Number.isFinite(Number(revenue)) && Number.isFinite(Number(employees)) && Number(employees) > 0
        ? inferRevenuePerEmployeeK(revenue, employees)
        : null);
    const revenuePerEmployee = coercePerEmployeeK(revenuePerEmployeeRaw);
    return {
      reporting_currency,
      revenue: revenue ?? null,
      revenue_per_employee: revenuePerEmployee,
      employees: Number.isFinite(Number(employees)) ? Number(employees) : null,
      ebitda: llmMoneyMillionsToAbsolute(getValue(llm?.ebitda)),
      ebitda_margin: getValue(llm?.ebitda_margin),
      net_margin: getValue(llm?.net_margin),
      gross_margin: getValue(llm?.gross_margin),
      cash_to_total_assets: getValue(llm?.cash_to_total_assets),
      net_debt_ebitda: getValue(llm?.net_debt_ebitda),
      capex_to_revenue_pct: getValue(llm?.capex_to_revenue_pct),
      rnd_to_revenue_pct: getValue(llm?.rnd_to_revenue_pct),
      revenue_growth_3y_cagr: getValue(llm?.revenue_growth_3y_cagr),
      operating_cash_flow: llmMoneyMillionsToAbsolute(getValue(llm?.operating_cash_flow)),
      operating_cashflow_positive: getValue(llm?.operating_cashflow_positive),
      revenue_growth: getValue(llm?.revenue_growth),
      revenue_previous: llmMoneyMillionsToAbsolute(getValue(llm?.revenue_previous)),
      net_income_per_employee: coercePerEmployeeK(getValue(llm?.net_income_per_employee)),
      fcf_per_employee: coercePerEmployeeK(getValue(llm?.fcf_per_employee)),
      free_cash_flow: llmMoneyMillionsToAbsolute(getValue(llm?.free_cash_flow)),
      market_cap: llmMoneyMillionsToAbsolute(getValue(llm?.market_cap))
    };
  }

  function normalizeLlmSignals(llm) {
    const expansionDetected = getValue(llm?.expansion_detected);
    const fy = getValue(llm?.founding_year);
    return {
      funding_detected: !!getValue(llm?.funding_detected),
      last_funding_amount: getValue(llm?.last_funding_amount) ?? null,
      last_funding_date: llm?.last_funding_date ?? null,
      funding_stage: getValue(llm?.funding_stage) ?? null,
      founding_year: fy != null && Number.isFinite(Number(fy)) ? Number(fy) : null,
      hiring_signal: getValue(llm?.hiring_signal) ?? null,
      keywords_score: getValue(llm?.keywords_score) ?? null,
      expansion_detected: expansionDetected == null ? null : !!expansionDetected
    };
  }

  async function extractFromWeb(companyName, articles, deps) {
    const { geminiApiKey, extractFinancialWithGemini } = deps;
    if (!geminiApiKey || !articles?.length) return null;
    const raw = await extractFinancialWithGemini(companyName, articles, geminiApiKey);
    return {
      financials: normalizeLlmFinancials(raw),
      signals: normalizeLlmSignals(raw),
      confidence: Number(raw?.globalConfidence || 0) || 0,
      raw
    };
  }

  async function extractFromCompanyContext(companyName, companyContext, deps) {
    const { geminiApiKey, extractFinancialFromCompanyContext } = deps;
    if (!geminiApiKey || !extractFinancialFromCompanyContext) return null;
    const raw = await extractFinancialFromCompanyContext(companyName, companyContext || {}, geminiApiKey);
    if (!raw) return null;
    return {
      financials: normalizeLlmFinancials(raw),
      signals: normalizeLlmSignals(raw),
      confidence: Number(raw?.globalConfidence || 0) || 0,
      raw
    };
  }

  self.llmExtractor = { extractFromWeb, extractFromCompanyContext };
})();
