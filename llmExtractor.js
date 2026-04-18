(() => {
  function getValue(maybe) {
    if (maybe == null) return null;
    if (typeof maybe === 'object' && Object.prototype.hasOwnProperty.call(maybe, 'value')) return maybe.value;
    return maybe;
  }

  /**
   * Prompt : revenue en millions (M€) sauf si ≥ 1e9 → CA annuel en € (unité pleine).
   * Sortie : k€ / tête (cohérent scoring ~25–400 pour la plupart des boîtes).
   */
  function inferRevenuePerEmployeeK(revenue, employees) {
    const R = Number(revenue);
    const E = Number(employees);
    if (!Number.isFinite(R) || !Number.isFinite(E) || E <= 0) return null;
    if (R >= 1e9) {
      return (R / E) / 1000;
    }
    return (R * 1000) / E;
  }

  /** LLM ou calcul parfois en €/tête au lieu de k€/tête */
  function coercePerEmployeeK(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    let x = Number(v);
    if (Math.abs(x) > 50000) x = x / 1000;
    return x;
  }

  function normalizeLlmFinancials(llm) {
    const revenue = getValue(llm?.revenue);
    const employees = getValue(llm?.employees);
    const revenuePerEmployeeRaw =
      getValue(llm?.revenuePerEmployee) ??
      (Number.isFinite(Number(revenue)) && Number.isFinite(Number(employees)) && Number(employees) > 0
        ? inferRevenuePerEmployeeK(revenue, employees)
        : null);
    const revenuePerEmployee = coercePerEmployeeK(revenuePerEmployeeRaw);
    return {
      revenue: revenue ?? null,
      revenue_per_employee: revenuePerEmployee,
      employees: Number.isFinite(Number(employees)) ? Number(employees) : null,
      ebitda: getValue(llm?.ebitda),
      ebitda_margin: getValue(llm?.ebitda_margin),
      net_margin: getValue(llm?.net_margin),
      gross_margin: getValue(llm?.gross_margin),
      cash_to_total_assets: getValue(llm?.cash_to_total_assets),
      net_debt_ebitda: getValue(llm?.net_debt_ebitda),
      capex_to_revenue_pct: getValue(llm?.capex_to_revenue_pct),
      rnd_to_revenue_pct: getValue(llm?.rnd_to_revenue_pct),
      revenue_growth_3y_cagr: getValue(llm?.revenue_growth_3y_cagr),
      operating_cash_flow: getValue(llm?.operating_cash_flow),
      operating_cashflow_positive: getValue(llm?.operating_cashflow_positive),
      revenue_growth: getValue(llm?.revenue_growth),
      revenue_previous: getValue(llm?.revenue_previous),
      net_income_per_employee: coercePerEmployeeK(getValue(llm?.net_income_per_employee)),
      fcf_per_employee: coercePerEmployeeK(getValue(llm?.fcf_per_employee)),
      free_cash_flow: getValue(llm?.free_cash_flow),
      market_cap: getValue(llm?.market_cap)
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
