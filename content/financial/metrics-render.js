/** Formatage et rendu des lignes de métriques financières / startup. */

const FINANCIAL_METRIC_HELP = {
  Embauche:
    "Signal de dynamique d'effectif (0 à 1, parfois 0 à 100) estimé depuis des indices publics récents (offres, croissance d'équipes, annonces). Ce n'est pas un nombre d'embauches réalisées ni une promesse sur 12 mois.",
  'Mots-clés':
    "Score (0 à 1) de pertinence de mots-clés de croissance/expansion détectés dans le contexte public (ex: ouverture, recrutement, international). Plus c'est élevé, plus les signaux sont présents.",
  Expansion:
    "Oui si des signaux publics d'expansion sont détectés (nouveaux marchés, ouvertures, internationalisation, accélération commerciale). Non signifie qu'aucun signal clair n'a été retenu.",
  'Levée ?':
    "Oui si une levée de fonds est détectée dans les signaux publics. Non si aucun indice de levée récente n'a été trouvé.",
  Levée:
    "Date estimée de la dernière levée détectée. Vide si aucune levée fiable n'a été identifiée.",
  Montant:
    "Montant de la dernière levée détectée (si disponible). Peut être absent même si une levée existe.",
  Stage:
    "Stade estimé de levée (seed, series_a, series_b, series_c, other)."
};

function pnFinancialScalar(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'object' && v !== null && Number.isFinite(Number(v.value))) return Number(v.value);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pnFinancialMoneySuffix(currency) {
  return currency === 'USD' ? '$' : '€';
}

/** Montants agrégés (CA, cape, etc.) : unités pleines en entrée → échelle lisible + symbole devise. */
function formatMoneyScaleAbsolute(n, currency) {
  const sym = pnFinancialMoneySuffix(currency);
  const v = pnFinancialScalar(n);
  if (v == null) return null;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} Md${sym}`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} M${sym}`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)} k${sym}`;
  return `${Math.round(v)}${sym}`;
}

function appendMetricRow(list, labelText, valueText, valueClass) {
  const li = document.createElement('li');
  li.className = 'lph-financial-card__item';
  const label = document.createElement('span');
  label.className = 'lph-financial-card__label';
  label.textContent = labelText;
  const hint = FINANCIAL_METRIC_HELP[labelText] || null;
  if (hint) {
    label.classList.add('lph-financial-card__label--help');
    label.title = hint;
    li.title = hint;
  }
  const value = document.createElement('span');
  value.className = `lph-financial-card__value ${valueClass}`.trim();
  value.textContent = valueText;
  li.appendChild(label);
  li.appendChild(value);
  list.appendChild(li);
}

function appendSectionHeader(list, titleText) {
  const li = document.createElement('li');
  li.className = 'lph-financial-card__section-title';
  li.textContent = titleText;
  list.appendChild(li);
}

function renderFinancialMetrics(list, response) {
  while (list.firstChild) list.removeChild(list.firstChild);
  const u = response?.unified || {};
  const f = u.financials || {};
  const s = u.signals || {};
  const reportingCurrency = f.reporting_currency === 'USD' ? 'USD' : 'EUR';
  const moneySym = pnFinancialMoneySuffix(reportingCurrency);

  const pct = (x) => (x == null || x === '' ? '—' : `${Math.round(Number(x) * 10) / 10} %`);
  const num = (x) => (x == null || x === '' ? '—' : `${Math.round(Number(x))}`);
  const yesNo = (b) => (b == null ? '—' : b ? 'Oui' : 'Non');
  const ratioX = (x) => (x == null || x === '' ? '—' : `${Math.round(Number(x) * 10) / 10}×`);

  const revenue = f.revenue ?? s.revenue_public ?? null;
  const revScalar = pnFinancialScalar(revenue);
  const revStr = revScalar != null ? formatMoneyScaleAbsolute(revenue, reportingCurrency) : '—';
  const marketCap = f.market_cap;
  const capScalar = pnFinancialScalar(marketCap);

  appendSectionHeader(list, 'Finance');
  if (response?.symbol) {
    appendMetricRow(list, 'Ticker', response.symbol, 'lph-financial-card__value--ok');
  }
  appendMetricRow(
    list,
    'Mkt cap',
    capScalar != null ? formatMoneyScaleAbsolute(marketCap, reportingCurrency) : '—',
    capScalar != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'CA',
    revStr,
    revScalar != null && revScalar >= 10_000_000
      ? 'lph-financial-card__value--ok'
      : revScalar != null
        ? 'lph-financial-card__value--warn'
        : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Marge EBITDA',
    pct(f.ebitda_margin),
    f.ebitda_margin == null
      ? 'lph-financial-card__value--n/a'
      : Number(f.ebitda_margin) >= 10
        ? 'lph-financial-card__value--ok'
        : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Marge N.',
    pct(f.net_margin),
    f.net_margin == null
      ? 'lph-financial-card__value--n/a'
      : Number(f.net_margin) >= 5
        ? 'lph-financial-card__value--ok'
        : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Marge B.',
    pct(f.gross_margin),
    f.gross_margin == null
      ? 'lph-financial-card__value--n/a'
      : Number(f.gross_margin) >= 25
        ? 'lph-financial-card__value--ok'
        : 'lph-financial-card__value--warn'
  );
  const g = f.revenue_growth;
  appendMetricRow(
    list,
    'CA YoY',
    pct(g),
    g == null ? 'lph-financial-card__value--n/a' : Number(g) > 6 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  if (f.revenue_growth_3y_cagr != null) {
    appendMetricRow(
      list,
      'CAGR 3a',
      pct(f.revenue_growth_3y_cagr),
      Number(f.revenue_growth_3y_cagr) > 5 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
    );
  }
  const cta = f.cash_to_total_assets;
  appendMetricRow(
    list,
    'Trésor./actifs',
    cta == null ? '—' : `${Math.round(Number(cta) * 1000) / 10} %`,
    cta == null ? 'lph-financial-card__value--n/a' : Number(cta) >= 0.08 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Dette/EBITDA',
    ratioX(f.net_debt_ebitda),
    f.net_debt_ebitda == null ? 'lph-financial-card__value--n/a' : Number(f.net_debt_ebitda) <= 3 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Effect.',
    f.employees == null ? '—' : num(f.employees),
    f.employees != null && Number(f.employees) >= 200
      ? 'lph-financial-card__value--ok'
      : f.employees != null
        ? 'lph-financial-card__value--warn'
        : 'lph-financial-card__value--n/a'
  );
  const rpe = f.revenue_per_employee;
  const rpeScalar = pnFinancialScalar(rpe);
  appendMetricRow(
    list,
    'CA / sal.',
    rpeScalar != null ? formatMoneyScaleAbsolute(rpe, reportingCurrency) : '—',
    rpeScalar == null ? 'lph-financial-card__value--n/a' : rpeScalar >= 120000 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  const niPe = f.net_income_per_employee;
  const niPeScalar = pnFinancialScalar(niPe);
  appendMetricRow(
    list,
    'RN / sal.',
    niPeScalar != null ? formatMoneyScaleAbsolute(niPe, reportingCurrency) : '—',
    niPeScalar == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
  );
  const fcfPe = f.fcf_per_employee;
  const fcfPeScalar = pnFinancialScalar(fcfPe);
  appendMetricRow(
    list,
    'FCF / sal.',
    fcfPeScalar != null ? formatMoneyScaleAbsolute(fcfPe, reportingCurrency) : '—',
    fcfPeScalar == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
  );
  appendMetricRow(
    list,
    'CAPEX / CA',
    pct(f.capex_to_revenue_pct),
    f.capex_to_revenue_pct == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
  );
  appendMetricRow(
    list,
    'R&D / CA',
    pct(f.rnd_to_revenue_pct),
    f.rnd_to_revenue_pct == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
  );
  appendMetricRow(
    list,
    'CFO+',
    yesNo(f.operating_cashflow_positive),
    f.operating_cashflow_positive === true
      ? 'lph-financial-card__value--ok'
      : f.operating_cashflow_positive === false
        ? 'lph-financial-card__value--warn'
        : 'lph-financial-card__value--n/a'
  );

  appendSectionHeader(list, 'Startup');
  appendMetricRow(
    list,
    'Levée',
    s.last_funding_date || '—',
    s.last_funding_date ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  const fundingAmt = s.last_funding_amount;
  const fundingScalar = pnFinancialScalar(fundingAmt);
  appendMetricRow(
    list,
    'Montant',
    fundingScalar != null ? formatMoneyScaleAbsolute(fundingAmt, reportingCurrency) : '—',
    fundingScalar != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(list, 'Stage', s.funding_stage || '—', s.funding_stage ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a');
  appendMetricRow(
    list,
    'Création',
    s.founding_year == null ? '—' : String(s.founding_year),
    s.founding_year != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Embauche',
    s.hiring_signal == null ? '—' : String(s.hiring_signal),
    s.hiring_signal != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Mots-clés',
    s.keywords_score == null ? '—' : String(s.keywords_score),
    s.keywords_score != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Levée ?',
    yesNo(s.funding_detected),
    s.funding_detected ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Expansion',
    s.expansion_detected == null ? '—' : yesNo(s.expansion_detected),
    s.expansion_detected === true ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
}
