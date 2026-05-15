(() => {
  function getValue(maybe) {
    if (maybe == null) return null;
    if (typeof maybe === 'object' && Object.prototype.hasOwnProperty.call(maybe, 'value')) return maybe.value;
    return maybe;
  }

  /** Nombre brut renvoyé par le LLM (aucune conversion d'échelle). */
  function asNumber(v) {
    const x = getValue(v);
    if (x == null || !Number.isFinite(Number(x))) return null;
    return Number(x);
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

  /** CA/RN/FCF par salarié dérivés des montants absolus (même devise que le CA). */
  function derivePerEmployeeFromTotals(financials) {
    const out = { ...(financials || {}) };
    const employees = Number(out.employees);
    if (!Number.isFinite(employees) || employees <= 0) return out;
    if (out.revenue != null) out.revenue_per_employee = out.revenue / employees;
    if (out.net_income != null) out.net_income_per_employee = out.net_income / employees;
    if (out.free_cash_flow != null) out.fcf_per_employee = out.free_cash_flow / employees;
    return out;
  }

  function normalizeLlmFinancials(llm) {
    const reporting_currency = normalizeReportingCurrency(llm);
    const financials = {
      reporting_currency,
      revenue: asNumber(llm?.revenue),
      revenue_previous: asNumber(llm?.revenue_previous),
      employees: asNumber(llm?.employees),
      ebitda: asNumber(llm?.ebitda),
      net_income: asNumber(llm?.net_income) ?? asNumber(llm?.netIncome),
      ebitda_margin: asNumber(llm?.ebitda_margin),
      net_margin: asNumber(llm?.net_margin),
      gross_margin: asNumber(llm?.gross_margin),
      cash_to_total_assets: asNumber(llm?.cash_to_total_assets),
      net_debt_ebitda: asNumber(llm?.net_debt_ebitda),
      capex_to_revenue_pct: asNumber(llm?.capex_to_revenue_pct),
      rnd_to_revenue_pct: asNumber(llm?.rnd_to_revenue_pct),
      revenue_growth_3y_cagr: asNumber(llm?.revenue_growth_3y_cagr),
      operating_cash_flow: asNumber(llm?.operating_cash_flow),
      operating_cashflow_positive: getValue(llm?.operating_cashflow_positive),
      revenue_growth: asNumber(llm?.revenue_growth),
      free_cash_flow: asNumber(llm?.free_cash_flow),
      market_cap: asNumber(llm?.market_cap)
    };
    return derivePerEmployeeFromTotals(financials);
  }

  function normalizeLlmSignals(llm) {
    const expansionDetected = getValue(llm?.expansion_detected);
    const fy = getValue(llm?.founding_year);
    return {
      funding_detected: !!getValue(llm?.funding_detected),
      last_funding_amount: asNumber(llm?.last_funding_amount),
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

  self.llmFinancialHarmonize = derivePerEmployeeFromTotals;
  self.llmExtractor = { extractFromWeb, extractFromCompanyContext, harmonizeFinancialPerEmployee: derivePerEmployeeFromTotals };
})();
