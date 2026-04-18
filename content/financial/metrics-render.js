/** Formatage et rendu des lignes de métriques financières / startup. */

function formatRevenueRaw(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} Md`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)} k`;
  return `${Math.round(v)}`;
}

function appendMetricRow(list, labelText, valueText, valueClass) {
  const li = document.createElement('li');
  li.className = 'lph-financial-card__item';
  const label = document.createElement('span');
  label.className = 'lph-financial-card__label';
  label.textContent = labelText;
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

  const pct = (x) => (x == null || x === '' ? '—' : `${Math.round(Number(x) * 10) / 10} %`);
  const num = (x) => (x == null || x === '' ? '—' : `${Math.round(Number(x))}`);
  const yesNo = (b) => (b == null ? '—' : b ? 'Oui' : 'Non');
  const ratioX = (x) => (x == null || x === '' ? '—' : `${Math.round(Number(x) * 10) / 10}×`);

  const revenue = f.revenue ?? s.revenue_public ?? null;
  const revStr = revenue != null ? formatRevenueRaw(revenue) : '—';

  appendSectionHeader(list, 'Finance');
  if (response?.symbol) {
    appendMetricRow(list, 'Ticker', response.symbol, 'lph-financial-card__value--ok');
  }
  appendMetricRow(
    list,
    'Mkt cap',
    f.market_cap != null ? formatRevenueRaw(f.market_cap) : '—',
    f.market_cap != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'CA',
    revStr,
    revenue != null && Number(revenue) >= 10_000_000
      ? 'lph-financial-card__value--ok'
      : revenue != null
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
  appendMetricRow(
    list,
    'CA / sal.',
    rpe == null ? '—' : `${Math.round(Number(rpe) * 10) / 10} k€`,
    rpe == null ? 'lph-financial-card__value--n/a' : Number(rpe) >= 120 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'RN / sal.',
    f.net_income_per_employee == null ? '—' : `${Math.round(Number(f.net_income_per_employee) * 10) / 10} k`,
    f.net_income_per_employee == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
  );
  appendMetricRow(
    list,
    'FCF / sal.',
    f.fcf_per_employee == null ? '—' : `${Math.round(Number(f.fcf_per_employee) * 10) / 10} k`,
    f.fcf_per_employee == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
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
  appendMetricRow(
    list,
    'Montant',
    s.last_funding_amount == null ? '—' : String(s.last_funding_amount),
    s.last_funding_amount != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
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
