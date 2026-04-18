(() => {
  function toNumberOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  function mergeFinancials(fmpFinancials, llmFinancials) {
    const base = { ...(fmpFinancials || {}) };
    const out = { ...base };
    const keys = [
      'revenue',
      'revenue_previous',
      'ebitda',
      'ebitda_margin',
      'net_margin',
      'gross_margin',
      'cash_to_total_assets',
      'net_debt_ebitda',
      'capex_to_revenue_pct',
      'rnd_to_revenue_pct',
      'revenue_growth_3y_cagr',
      'operating_cash_flow',
      'operating_cashflow_positive',
      'revenue_growth',
      'revenue_per_employee',
      'net_income_per_employee',
      'fcf_per_employee',
      'free_cash_flow',
      'employees',
      'market_cap'
    ];
    keys.forEach((k) => {
      if (out[k] == null && llmFinancials?.[k] != null) out[k] = llmFinancials[k];
    });
    out.revenue = toNumberOrNull(out.revenue);
    out.revenue_previous = toNumberOrNull(out.revenue_previous);
    out.ebitda = toNumberOrNull(out.ebitda);
    out.ebitda_margin = toNumberOrNull(out.ebitda_margin);
    out.net_margin = toNumberOrNull(out.net_margin);
    out.gross_margin = toNumberOrNull(out.gross_margin);
    out.cash_to_total_assets = toNumberOrNull(out.cash_to_total_assets);
    out.net_debt_ebitda = toNumberOrNull(out.net_debt_ebitda);
    out.capex_to_revenue_pct = toNumberOrNull(out.capex_to_revenue_pct);
    out.rnd_to_revenue_pct = toNumberOrNull(out.rnd_to_revenue_pct);
    out.revenue_growth_3y_cagr = toNumberOrNull(out.revenue_growth_3y_cagr);
    out.operating_cash_flow = toNumberOrNull(out.operating_cash_flow);
    out.revenue_growth = toNumberOrNull(out.revenue_growth);
    out.revenue_per_employee = toNumberOrNull(out.revenue_per_employee);
    out.net_income_per_employee = toNumberOrNull(out.net_income_per_employee);
    out.fcf_per_employee = toNumberOrNull(out.fcf_per_employee);
    out.free_cash_flow = toNumberOrNull(out.free_cash_flow);
    out.employees = toNumberOrNull(out.employees);
    out.market_cap = toNumberOrNull(out.market_cap);
    if (out.operating_cashflow_positive != null) out.operating_cashflow_positive = !!out.operating_cashflow_positive;
    return out;
  }

  function inferSignals(financials, llmSignals) {
    const fundingDate = llmSignals?.last_funding_date ? Date.parse(llmSignals.last_funding_date) : NaN;
    const fundingRecent = Number.isNaN(fundingDate) ? null : ((Date.now() - fundingDate) / (1000 * 60 * 60 * 24 * 30.44)) <= 24;
    const employeesEstimated = financials?.employees != null ? Number(financials.employees) : null;

    return {
      profitability_status: 'unknown',
      growth_signal: 'unknown',
      funding_detected: !!llmSignals?.funding_detected,
      last_funding_amount: llmSignals?.last_funding_amount ?? null,
      last_funding_date: llmSignals?.last_funding_date ?? null,
      funding_recent_24m: fundingRecent,
      funding_stage: llmSignals?.funding_stage ?? null,
      founding_year: llmSignals?.founding_year ?? null,
      hiring_signal: llmSignals?.hiring_signal ?? null,
      keywords_score: llmSignals?.keywords_score ?? null,
      revenue_public: financials?.revenue ?? null,
      employees_estimated: employeesEstimated,
      expansion_detected: llmSignals?.expansion_detected == null ? null : !!llmSignals?.expansion_detected
    };
  }

  self.merger = { mergeFinancials, inferSignals };
})();
