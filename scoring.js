(() => {
  /**
   * v4 — « cash vs taille » : tout par employé, pas de hype / levée / market cap dans le score.
   *
   * Cas « rich » (remplace tout si dispo) :
   *   0.4 * norm(résultat net / employé) + 0.3 * norm(FCF / employé) + 0.3 * norm(marge)
   *   marge = marge nette si dispo, sinon marge EBITDA.
   *
   * Cas « simple » (données limitées) :
   *   0.7 * norm(CA / employé) + 0.3 * norm(croissance effectif)
   *   croissance effectif = hiring_signal (0–1 → 0–100) si présent ; sinon seul le CA/emp compte.
   *
   * La confiance (KPI présents / attendus) est exposée à part via computeConfidence et score_breakdown.kpi_confidence.
   */
  const SCORE_MODEL_VERSION = 4;

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  function normLinear(v, min, max) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const t = (Number(v) - min) / (max - min);
    return clamp01(t) * 100;
  }

  /** CA / salarié (k€ ou k$ — même unité que FMP / LLM) */
  function normRevenuePerEmployee(kPerEmp) {
    return normLinear(kPerEmp, 25, 400);
  }

  /** Résultat net / salarié (k par tête) */
  function normNetIncomePerEmployee(kPerEmp) {
    if (kPerEmp == null || !Number.isFinite(Number(kPerEmp))) return null;
    return normLinear(kPerEmp, -80, 120);
  }

  /** Free cash-flow / salarié (k par tête) */
  function normFcfPerEmployee(kPerEmp) {
    if (kPerEmp == null || !Number.isFinite(Number(kPerEmp))) return null;
    return normLinear(kPerEmp, -60, 100);
  }

  /** Marge % (nette prioritaire dans l’appelant) */
  function normMarginPct(marginPct) {
    if (marginPct == null || !Number.isFinite(Number(marginPct))) return null;
    return normLinear(marginPct, -25, 35);
  }

  /** Signal embauche / dynamique effectif (0–1 ou déjà 0–100) */
  function normHiringSignal(raw) {
    if (raw == null || !Number.isFinite(Number(raw))) return null;
    const h = Number(raw);
    if (h <= 1 && h >= 0) return h * 100;
    return clamp01(h / 100) * 100;
  }

  function canUseRichMode(f) {
    const margin = f?.net_margin != null && Number.isFinite(Number(f.net_margin)) ? f.net_margin : f?.ebitda_margin;
    return (
      f?.net_income_per_employee != null &&
      Number.isFinite(Number(f.net_income_per_employee)) &&
      f?.fcf_per_employee != null &&
      Number.isFinite(Number(f.fcf_per_employee)) &&
      margin != null &&
      Number.isFinite(Number(margin))
    );
  }

  function computeRichScore(f) {
    const marginRaw = f?.net_margin != null && Number.isFinite(Number(f.net_margin)) ? f.net_margin : f?.ebitda_margin;
    const nNet = normNetIncomePerEmployee(f.net_income_per_employee);
    const nFcf = normFcfPerEmployee(f.fcf_per_employee);
    const nMar = normMarginPct(marginRaw);
    if (nNet == null || nFcf == null || nMar == null) return null;
    return Math.round(0.4 * nNet + 0.3 * nFcf + 0.3 * nMar);
  }

  function computeSimpleScore(f, signals) {
    const nRev = normRevenuePerEmployee(f?.revenue_per_employee);
    if (nRev == null) return null;
    const nHire = normHiringSignal(signals?.hiring_signal);
    if (nHire == null) return Math.round(nRev);
    return Math.round(0.7 * nRev + 0.3 * nHire);
  }

  /**
   * @param {{ financials: object, signals?: object }} payload
   */
  function computeScoreBreakdown(payload) {
    const f = payload?.financials || {};
    const signals = payload?.signals || {};

    const norms = {
      revenue_per_employee: normRevenuePerEmployee(f.revenue_per_employee),
      net_income_per_employee: normNetIncomePerEmployee(f.net_income_per_employee),
      fcf_per_employee: normFcfPerEmployee(f.fcf_per_employee),
      margin:
        f?.net_margin != null && Number.isFinite(Number(f.net_margin))
          ? normMarginPct(f.net_margin)
          : normMarginPct(f?.ebitda_margin),
      hiring_growth: normHiringSignal(signals?.hiring_signal)
    };

    let mode = 'simple';
    let score = 0;
    let kpiTotal = 0;
    let kpiPresent = 0;

    if (canUseRichMode(f)) {
      const s = computeRichScore(f);
      if (s != null) {
        mode = 'rich';
        score = s;
        // KPI utilisés en mode rich
        kpiTotal = 4; // net/emp, fcf/emp, marge, CA/emp
        if (f.net_income_per_employee != null && Number.isFinite(Number(f.net_income_per_employee))) kpiPresent++;
        if (f.fcf_per_employee != null && Number.isFinite(Number(f.fcf_per_employee))) kpiPresent++;
        if ((f.net_margin != null && Number.isFinite(Number(f.net_margin))) || (f.ebitda_margin != null && Number.isFinite(Number(f.ebitda_margin)))) kpiPresent++;
        if (f.revenue_per_employee != null && Number.isFinite(Number(f.revenue_per_employee))) kpiPresent++;
      }
    }

    if (mode === 'simple') {
      const s = computeSimpleScore(f, signals);
      score = s != null ? s : 0;
      // KPI utilisés en mode simple
      kpiTotal = 2; // CA/emp, croissance effectif (hiring_signal)
      if (f.revenue_per_employee != null && Number.isFinite(Number(f.revenue_per_employee))) kpiPresent++;
      if (signals?.hiring_signal != null && Number.isFinite(Number(signals.hiring_signal))) kpiPresent++;
    }

    const kpiConfidence = kpiTotal > 0 ? kpiPresent / kpiTotal : 0;

    return {
      model_version: SCORE_MODEL_VERSION,
      score_model: 'cash_vs_headcount_v4',
      mode,
      score,
      norms,
      inputs: {
        revenue_per_employee: f.revenue_per_employee ?? null,
        net_income_per_employee: f.net_income_per_employee ?? null,
        fcf_per_employee: f.fcf_per_employee ?? null,
        net_margin: f.net_margin ?? null,
        ebitda_margin: f.ebitda_margin ?? null,
        hiring_signal: signals?.hiring_signal ?? null
      },
      kpi_total: kpiTotal,
      kpi_present: kpiPresent,
      kpi_confidence: kpiConfidence,
      coverage: kpiConfidence
    };
  }

  function computeScore(payload) {
    return computeScoreBreakdown(payload).score;
  }

  function isPartialDataset(financials) {
    const f = financials || {};
    if (f.revenue_per_employee != null && Number.isFinite(Number(f.revenue_per_employee))) return false;
    if (canUseRichMode(f)) return false;
    return true;
  }

  function computeConfidence(payload) {
    const bd = computeScoreBreakdown(payload);
    // Confiance = nb KPI dispo / nb KPI attendus (0–1), comme demandé
    return Math.max(0, Math.min(1, bd.kpi_confidence ?? 0));
  }

  self.scoring = {
    computeScore,
    computeScoreBreakdown,
    computeConfidence,
    isPartialDataset
  };
})();
