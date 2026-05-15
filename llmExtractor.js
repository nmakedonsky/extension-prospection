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

  /** Montant agrégé (unités pleines) → k€ ou k$ par tête. */
  function inferPerEmployeeKFromAbsolute(moneyAbsolute, employees) {
    const M = Number(moneyAbsolute);
    const E = Number(employees);
    if (!Number.isFinite(M) || !Number.isFinite(E) || E <= 0) return null;
    return (M / E) / 1000;
  }

  /** Résultat net / salarié à partir du CA/tête et de la marge nette (%). */
  function inferNetIncomePerEmployeeKFromMargin(revenuePerEmployeeK, netMarginPct) {
    const rpe = Number(revenuePerEmployeeK);
    const m = Number(netMarginPct);
    if (!Number.isFinite(rpe) || !Number.isFinite(m)) return null;
    return rpe * (m / 100);
  }

  /**
   * Normalise une métrique / tête en k€ (ou k$).
   * - ≥ 50 000 : €/tête bruts → ÷1000
   * - entre ~8× le CA/tête et 50 000 : idem (ex. 15 000–40 000 €)
   * - &lt; 1 : souvent M€/tête (net_income_millions / employees) → ×1000
   * Les valeurs déjà plausibles en k€ (ex. 15–400) ne sont pas modifiées.
   */
  function coercePerEmployeeK(v, referenceK) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    let x = Number(v);
    const ref =
      referenceK != null && Number.isFinite(Number(referenceK)) && Number(referenceK) > 0
        ? Number(referenceK)
        : null;

    if (Math.abs(x) >= 50000) x /= 1000;
    else if (ref != null) {
      if (Math.abs(x) >= ref * 8 && Math.abs(x) < 50000) x /= 1000;
      else if (Math.abs(x) > 0 && Math.abs(x) < 1) x *= 1000;
    }

    return x;
  }

  function relativeDelta(a, b) {
    if (!Number.isFinite(Number(a)) || !Number.isFinite(Number(b))) return Infinity;
    return Math.abs(Number(a) - Number(b)) / Math.max(Math.abs(Number(b)), 1);
  }

  /** Préfère le calcul dérivé si le LLM est incohérent (&gt; 45 % d'écart). */
  function pickPerEmployeeK(llmK, inferredK) {
    if (inferredK == null || !Number.isFinite(Number(inferredK))) return llmK ?? null;
    if (llmK == null || !Number.isFinite(Number(llmK))) return inferredK;
    if (relativeDelta(llmK, inferredK) > 0.45) return inferredK;
    return llmK;
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

  function harmonizeFinancialPerEmployee(financials) {
    const out = { ...(financials || {}) };
    const employees = Number(out.employees);
    if (!Number.isFinite(employees) || employees <= 0) return out;

    const revenue = out.revenue;
    const rpeInferred = inferRevenuePerEmployeeK(revenue, employees);
    if (rpeInferred != null) {
      const rpe = out.revenue_per_employee;
      if (rpe == null || relativeDelta(rpe, rpeInferred) > 0.3) {
        out.revenue_per_employee = rpeInferred;
      }
    }

    const rpeRef = out.revenue_per_employee;
    const netIncome = out.net_income;
    const netMargin = out.net_margin;
    const freeCashFlow = out.free_cash_flow;

    const niFromAbsolute = inferPerEmployeeKFromAbsolute(netIncome, employees);
    const niFromMargin = inferNetIncomePerEmployeeKFromMargin(rpeRef, netMargin);
    const niInferred = niFromAbsolute ?? niFromMargin;
    const niLlm = coercePerEmployeeK(out.net_income_per_employee, rpeRef);
    out.net_income_per_employee =
      niFromAbsolute != null ? niFromAbsolute : pickPerEmployeeK(niLlm, niInferred);

    const fcfFromAbsolute = inferPerEmployeeKFromAbsolute(freeCashFlow, employees);
    const fcfLlm = coercePerEmployeeK(out.fcf_per_employee, rpeRef);
    out.fcf_per_employee = fcfFromAbsolute != null ? fcfFromAbsolute : pickPerEmployeeK(fcfLlm, fcfFromAbsolute);

    return out;
  }

  function normalizeLlmFinancials(llm) {
    const reporting_currency = normalizeReportingCurrency(llm);
    const revenue = llmMoneyMillionsToAbsolute(getValue(llm?.revenue));
    const employees = getValue(llm?.employees);
    const netIncome = llmMoneyMillionsToAbsolute(getValue(llm?.net_income) ?? getValue(llm?.netIncome));
    const revenuePerEmployeeRaw =
      getValue(llm?.revenuePerEmployee) ??
      (Number.isFinite(Number(revenue)) && Number.isFinite(Number(employees)) && Number(employees) > 0
        ? inferRevenuePerEmployeeK(revenue, employees)
        : null);
    const revenuePerEmployee = coercePerEmployeeK(revenuePerEmployeeRaw, null);
    const netMargin = getValue(llm?.net_margin);
    const freeCashFlow = llmMoneyMillionsToAbsolute(getValue(llm?.free_cash_flow));

    const financials = {
      reporting_currency,
      revenue: revenue ?? null,
      revenue_per_employee: revenuePerEmployee,
      employees: Number.isFinite(Number(employees)) ? Number(employees) : null,
      net_income: netIncome ?? null,
      ebitda: llmMoneyMillionsToAbsolute(getValue(llm?.ebitda)),
      ebitda_margin: getValue(llm?.ebitda_margin),
      net_margin: netMargin,
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
      net_income_per_employee: coercePerEmployeeK(getValue(llm?.net_income_per_employee), revenuePerEmployee),
      fcf_per_employee: coercePerEmployeeK(getValue(llm?.fcf_per_employee), revenuePerEmployee),
      free_cash_flow: freeCashFlow,
      market_cap: llmMoneyMillionsToAbsolute(getValue(llm?.market_cap))
    };

    return harmonizeFinancialPerEmployee(financials);
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

  self.llmFinancialHarmonize = harmonizeFinancialPerEmployee;
  self.llmExtractor = { extractFromWeb, extractFromCompanyContext, harmonizeFinancialPerEmployee };
})();
