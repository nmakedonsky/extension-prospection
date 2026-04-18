/**
 * Colonne fixe à gauche : score + indicateurs financiers (Gemini) + HubSpot.
 * S’appuie sur les cartes déjà classées (data-pn-processed / data-pn-type).
 */

const FINANCIAL_DOCK_ID = 'lph-financial-dock';
const FINANCIAL_CARD_CLASS = 'lph-financial-card';
const DATA_PN_PROCESSED = 'data-pn-processed';
const DATA_PN_TYPE = 'data-pn-type';
const JOB_LINK_TITLE_SEL =
  'a[href*="/jobs/view/"], a[href*="/jobs/search-results"], a[href*="currentJobId="]';

let lastFinancialCardJobWrapper = null;

function sendRuntimeMessageSafe(payload, callback) {
  try {
    if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
      callback?.(null, new Error('Extension context invalidated'));
      return;
    }
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime?.lastError ? new Error(chrome.runtime.lastError.message) : null;
      callback?.(response, err);
    });
  } catch (e) {
    callback?.(null, e);
  }
}

function isJobsSearchResultsPath() {
  return String(location.pathname || '').includes('/jobs/search-results');
}

function isJobsCollectionsPathDock() {
  return String(location.pathname || '').includes('/jobs/collections');
}

function isJobCardInListColumn(el) {
  const j = window.__prospectionJobs;
  if (!el) return false;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 4) return false;
  const vw = window.innerWidth || 1200;
  /** Même idée que Collections : dans la colonne gauche, ne pas bloquer sur isNodeInJobDetailsComposed (faux positifs wrappers). */
  if (j?.isInLeftJobListColumn?.(el)) {
    const cx = r.left + r.width / 2;
    if (cx <= vw * 0.72) {
      if (el.closest?.('[componentkey^="JobDetails"], [componentkey*="JobDetails_"]')) return false;
      if (el.closest?.('.jobs-unified-top-card, .jobs-search__job-details')) return false;
      return true;
    }
  }
  if (j?.isNodeInJobDetailsComposed?.(el)) return false;
  const cx = r.left + r.width / 2;
  return cx <= vw * 0.72;
}

function extractCompanyNameDock(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll?.('.pn-badge').forEach((n) => n.remove());
  return String(clone.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Aligné sur jobs-page.js — search-results SDUI : nom souvent dans un <p> sans classe artdeco. */
function isNoiseCompanyTextDock(t) {
  const s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2) return true;
  if (/Sponsorisé|Consulté|Enregistré/i.test(s)) return true;
  if (/Publiée le|il y a \d|weeks? ago|days? ago|mois|semaines?|jour/i.test(s)) return true;
  if (/€\s*K\/yr|€\/yr|\$\s*K/i.test(s)) return true;
  return false;
}

function findCompanyElementInCardDock(card) {
  if (!card?.querySelector) return null;
  const linked =
    card.querySelector(':scope a[href*="/company/"]') || card.querySelector('a[href*="/company/"]');
  if (linked) return linked;
  const classic = card.querySelector(
    '[class*="artdeco-entity-lockup__subtitle"], [class*="company-name"], [class*="job-card-container__company-name"], [class*="job-card-container__primary-description"], [class*="job-card-list__subtitle"]'
  );
  if (classic) return classic;
  const ps = Array.from(card.querySelectorAll(':scope p')).filter(
    (p) => !isNoiseCompanyTextDock(p.textContent)
  );
  if (ps.length >= 2) return ps[1];
  if (ps.length === 1) return ps[0];
  return null;
}

function getJobInfoFromWrapper(wrapper) {
  const link = wrapper.querySelector(JOB_LINK_TITLE_SEL);
  let titleEl = wrapper.querySelector(
    '[class*="base-search-card__title"], [class*="job-card-list__title"], a[href*="/jobs/"]'
  );
  if (!titleEl) {
    const firstP = wrapper.querySelector('p');
    if (firstP) titleEl = firstP;
  }
  let jobUrl = link ? String(link.href || '').trim() : '';
  if (!jobUrl) {
    const dj =
      wrapper.getAttribute?.('data-job-id') ||
      wrapper.getAttribute?.('data-occludable-job-id') ||
      '';
    if (dj) {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('currentJobId', dj);
        jobUrl = u.toString();
      } catch (_) {}
    }
  }
  return {
    jobTitle: titleEl ? String(titleEl.textContent || '').trim().slice(0, 200) : '',
    jobUrl
  };
}

function buildCompanyContextForWrapper(wrapper, companyName) {
  const logoImg = wrapper.querySelector('img[alt*="Logo"], img[class*="EntityPhoto"]');
  const companyLink = wrapper.querySelector('a[href*="/company/"]');
  return {
    logoUrl: logoImg?.src ? String(logoImg.src).trim() : null,
    logoAlt: logoImg?.alt ? String(logoImg.alt).trim() : companyName ? `Logo de ${companyName}` : null,
    companyLinkedinUrl: companyLink?.href ? String(companyLink.href).trim() : null,
    jobLocation: null
  };
}

function ensureFinancialDock() {
  let dock = document.getElementById(FINANCIAL_DOCK_ID);
  if (dock) return dock;
  dock = document.createElement('aside');
  dock.id = FINANCIAL_DOCK_ID;
  dock.className = 'lph-financial-dock';
  dock.setAttribute('aria-label', 'Prospection — données entreprise');
  const header = document.createElement('div');
  header.className = 'lph-financial-dock__header';
  header.textContent = 'Prospection';
  const body = document.createElement('div');
  body.className = 'lph-financial-dock__body';
  const ph = document.createElement('div');
  ph.className = 'lph-financial-dock__placeholder';
  ph.textContent =
    'Cliquez sur une offre classée Client ou SS2I pour afficher le score et les indicateurs.';
  body.appendChild(ph);
  dock.appendChild(header);
  dock.appendChild(body);
  document.body.appendChild(dock);
  return dock;
}

function getDockBody() {
  const dock = ensureFinancialDock();
  return /** @type {HTMLElement} */ (dock.querySelector('.lph-financial-dock__body'));
}

function getFinancialCardMount() {
  const body = getDockBody();
  let card = body.querySelector(`.${FINANCIAL_CARD_CLASS}`);
  if (!card) {
    card = document.createElement('div');
    card.className = `${FINANCIAL_CARD_CLASS} lph-financial-card--docked`;
    card.setAttribute('aria-hidden', 'false');
    body.appendChild(card);
  }
  return /** @type {HTMLElement} */ (card);
}

function syncFinancialDockVisibility() {
  const dock = document.getElementById(FINANCIAL_DOCK_ID);
  if (!dock) return;
  const show = isJobsSearchResultsPath() || isJobsCollectionsPathDock();
  dock.hidden = !show;
  document.documentElement.classList.toggle('lph-financial-dock-active', show);
}

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

  appendSectionHeader(list, 'Indicateurs financiers');
  if (response?.symbol) {
    appendMetricRow(list, 'Ticker', response.symbol, 'lph-financial-card__value--ok');
  }
  appendMetricRow(
    list,
    'Market cap',
    f.market_cap != null ? formatRevenueRaw(f.market_cap) : '—',
    f.market_cap != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Chiffre d’affaires',
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
    'Marge nette',
    pct(f.net_margin),
    f.net_margin == null
      ? 'lph-financial-card__value--n/a'
      : Number(f.net_margin) >= 5
        ? 'lph-financial-card__value--ok'
        : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Marge brute',
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
    'Croissance CA (YoY)',
    pct(g),
    g == null ? 'lph-financial-card__value--n/a' : Number(g) > 6 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  if (f.revenue_growth_3y_cagr != null) {
    appendMetricRow(
      list,
      'CAGR CA (~3 ans)',
      pct(f.revenue_growth_3y_cagr),
      Number(f.revenue_growth_3y_cagr) > 5 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
    );
  }
  const cta = f.cash_to_total_assets;
  appendMetricRow(
    list,
    'Trésorerie / total actifs',
    cta == null ? '—' : `${Math.round(Number(cta) * 1000) / 10} %`,
    cta == null ? 'lph-financial-card__value--n/a' : Number(cta) >= 0.08 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Dette nette / EBITDA',
    ratioX(f.net_debt_ebitda),
    f.net_debt_ebitda == null ? 'lph-financial-card__value--n/a' : Number(f.net_debt_ebitda) <= 3 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Effectifs',
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
    'CA / salarié (k€ env.)',
    rpe == null ? '—' : `${Math.round(Number(rpe) * 10) / 10} k€`,
    rpe == null ? 'lph-financial-card__value--n/a' : Number(rpe) >= 120 ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--warn'
  );
  appendMetricRow(
    list,
    'Résultat net / salarié (k)',
    f.net_income_per_employee == null ? '—' : `${Math.round(Number(f.net_income_per_employee) * 10) / 10} k`,
    f.net_income_per_employee == null ? 'lph-financial-card__value--n/a' : 'lph-financial-card__value--ok'
  );
  appendMetricRow(
    list,
    'Free cash-flow / salarié (k)',
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
    'Cash-flow op. positif',
    yesNo(f.operating_cashflow_positive),
    f.operating_cashflow_positive === true
      ? 'lph-financial-card__value--ok'
      : f.operating_cashflow_positive === false
        ? 'lph-financial-card__value--warn'
        : 'lph-financial-card__value--n/a'
  );

  appendSectionHeader(list, 'Levée & startup');
  appendMetricRow(
    list,
    'Dernière levée (date)',
    s.last_funding_date || '—',
    s.last_funding_date ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Montant levée',
    s.last_funding_amount == null ? '—' : String(s.last_funding_amount),
    s.last_funding_amount != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(list, 'Stage (levée)', s.funding_stage || '—', s.funding_stage ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a');
  appendMetricRow(
    list,
    'Année de création',
    s.founding_year == null ? '—' : String(s.founding_year),
    s.founding_year != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Signal embauche (0–1)',
    s.hiring_signal == null ? '—' : String(s.hiring_signal),
    s.hiring_signal != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Score mots-clés (SaaS, IA…)',
    s.keywords_score == null ? '—' : String(s.keywords_score),
    s.keywords_score != null ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Levée détectée',
    yesNo(s.funding_detected),
    s.funding_detected ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
  appendMetricRow(
    list,
    'Expansion (signal)',
    s.expansion_detected == null ? '—' : yesNo(s.expansion_detected),
    s.expansion_detected === true ? 'lph-financial-card__value--ok' : 'lph-financial-card__value--n/a'
  );
}

function populateFinancialPanel(companyName, jobInfo = {}) {
  const { type, jobTitle, jobUrl, companyContext, jobWrapper } = jobInfo;
  lastFinancialCardJobWrapper = jobWrapper && jobWrapper.isConnected ? jobWrapper : null;

  ensureFinancialDock();
  const body = getDockBody();
  body.querySelector('.lph-financial-dock__placeholder')?.remove();

  const card = getFinancialCardMount();
  while (card.firstChild) card.removeChild(card.firstChild);

  if (jobUrl) {
    card.dataset.lphJobUrl = jobUrl;
    card.classList.add('lph-financial-card--clickable');
    card.title = 'Cliquer pour ouvrir l’offre';
  } else {
    delete card.dataset.lphJobUrl;
    card.classList.remove('lph-financial-card--clickable');
    card.removeAttribute('title');
  }

  const title = document.createElement('div');
  title.className = 'lph-financial-card__title';
  title.textContent = companyName;
  card.appendChild(title);

  const scoreRow = document.createElement('div');
  scoreRow.className = 'lph-financial-card__score-row';

  const scoreEl = document.createElement('div');
  scoreEl.className = 'lph-financial-card__score';
  scoreEl.textContent = '—';

  const confidenceEl = document.createElement('div');
  confidenceEl.className = 'lph-financial-card__confidence';
  confidenceEl.hidden = true;

  scoreRow.appendChild(scoreEl);
  scoreRow.appendChild(confidenceEl);
  card.appendChild(scoreRow);

  const metricsWrap = document.createElement('div');
  metricsWrap.className = 'lph-financial-card__metrics-wrap';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'lph-financial-card__metrics-toggle';
  toggleBtn.textContent = 'Afficher les indicateurs';
  toggleBtn.hidden = true;

  const metricsPanel = document.createElement('div');
  metricsPanel.className = 'lph-financial-card__metrics-panel';
  metricsPanel.setAttribute('aria-hidden', 'true');

  const list = document.createElement('ul');
  list.className = 'lph-financial-card__list';
  const listId = `lph-financial-metrics-${Date.now()}`;
  list.id = listId;
  toggleBtn.setAttribute('aria-controls', listId);

  const financialStatus = document.createElement('div');
  financialStatus.className = 'lph-financial-card__financial-status';

  metricsPanel.appendChild(list);
  metricsPanel.appendChild(financialStatus);

  let metricsExpanded = false;

  const syncMetricsToggle = () => {
    const hasRows = list.children.length > 0;
    const hasMeta = !!(financialStatus.textContent && financialStatus.textContent.trim());
    toggleBtn.hidden = !hasRows;
    if (!hasRows && !hasMeta) {
      metricsPanel.classList.add('lph-financial-card__metrics-panel--collapsed');
      metricsExpanded = false;
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.textContent = 'Afficher les indicateurs';
      return;
    }
    if (!hasRows && hasMeta) {
      metricsPanel.classList.remove('lph-financial-card__metrics-panel--collapsed');
      return;
    }
    if (metricsExpanded) {
      metricsPanel.classList.remove('lph-financial-card__metrics-panel--collapsed');
    } else {
      metricsPanel.classList.add('lph-financial-card__metrics-panel--collapsed');
    }
    toggleBtn.setAttribute('aria-expanded', metricsExpanded ? 'true' : 'false');
    toggleBtn.textContent = metricsExpanded ? 'Masquer les indicateurs' : 'Afficher les indicateurs';
  };

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (toggleBtn.hidden) return;
    metricsExpanded = !metricsExpanded;
    syncMetricsToggle();
  });

  metricsWrap.appendChild(toggleBtn);
  metricsWrap.appendChild(metricsPanel);
  card.appendChild(metricsWrap);

  metricsPanel.classList.add('lph-financial-card__metrics-panel--collapsed');

  const financialBtn = document.createElement('button');
  financialBtn.type = 'button';
  financialBtn.className = 'lph-financial-card__financial-btn';
  financialBtn.textContent = 'Charger les données financières';

  const updateSummary = (response) => {
    if (!response?.ok || !response.unified) return;
    const score = response.score ?? response.unified?.score;
    const confRaw = response.unified?.confidence ?? response.confidence;
    if (score != null && Number.isFinite(Number(score))) {
      const n = Math.round(Number(score));
      scoreEl.textContent = `${n} / 100`;
      scoreEl.className =
        'lph-financial-card__score ' +
        (n >= 58 ? 'lph-financial-card__score--ok' : n >= 38 ? 'lph-financial-card__score--warn' : 'lph-financial-card__score--low');
    } else {
      scoreEl.textContent = '—';
      scoreEl.className = 'lph-financial-card__score';
    }
    if (confRaw != null && Number.isFinite(Number(confRaw))) {
      const p = Math.round(Number(confRaw) * 100);
      confidenceEl.textContent = `Confiance ${p} %`;
      confidenceEl.hidden = false;
      confidenceEl.className =
        'lph-financial-card__confidence ' +
        (p >= 80
          ? 'lph-financial-card__confidence--ok'
          : p >= 50
            ? 'lph-financial-card__confidence--mid'
            : 'lph-financial-card__confidence--low');
    } else {
      confidenceEl.textContent = '';
      confidenceEl.hidden = true;
      confidenceEl.className = 'lph-financial-card__confidence';
    }
  };

  const applyFinancialResponse = (response) => {
    if (!response?.ok || !response.data) return false;
    renderFinancialMetrics(list, response);
    updateSummary(response);

    financialBtn.textContent = 'Rafraîchir les données';
    if (response?.supabase?.ok === false) {
      financialStatus.textContent = 'Supabase indisponible';
      financialStatus.classList.add('lph-financial-card__financial-status--warn');
    } else if (response.partial) {
      financialStatus.textContent = 'Données partielles';
      financialStatus.classList.add('lph-financial-card__financial-status--warn');
    } else {
      financialStatus.textContent = '';
      financialStatus.classList.remove('lph-financial-card__financial-status--warn');
    }
    syncMetricsToggle();
    return true;
  };

  financialBtn.addEventListener('click', () => {
    financialBtn.disabled = true;
    financialBtn.textContent = 'Chargement…';
    financialStatus.textContent = '';
    sendRuntimeMessageSafe(
      { action: 'getFinancialData', companyName, forceRefresh: true, companyContext: companyContext || null },
      (response, error) => {
        if (error) {
          financialBtn.disabled = false;
          financialBtn.textContent = 'Réessayer';
          financialStatus.textContent = 'Erreur de communication';
          financialStatus.classList.add('lph-financial-card__financial-status--warn');
          syncMetricsToggle();
          return;
        }
        if (!response?.ok || !response.data) {
          financialBtn.disabled = false;
          financialBtn.textContent = 'Réessayer';
          financialStatus.textContent = response?.error || 'Données indisponibles';
          financialStatus.classList.add('lph-financial-card__financial-status--warn');
          syncMetricsToggle();
          return;
        }
        financialBtn.disabled = false;
        applyFinancialResponse(response);
      }
    );
  });
  card.appendChild(financialBtn);

  sendRuntimeMessageSafe(
    { action: 'getFinancialData', companyName, forceRefresh: false, companyContext: companyContext || null },
    (response, error) => {
      if (error || !financialStatus.isConnected) return;
      if (applyFinancialResponse(response)) {
        financialStatus.classList.remove('lph-financial-card__financial-status--warn');
      }
    }
  );

  const hubspotStatus = document.createElement('div');
  hubspotStatus.className = 'lph-financial-card__hubspot-status';
  hubspotStatus.textContent = type ? 'HubSpot…' : '';
  if (!type) hubspotStatus.style.display = 'none';
  card.appendChild(hubspotStatus);

  const hubspotBtn = document.createElement('button');
  hubspotBtn.type = 'button';
  hubspotBtn.className = 'lph-financial-card__hubspot-btn';
  hubspotBtn.textContent = 'Ajouter à HubSpot';
  if (!type) hubspotBtn.style.display = 'none';
  hubspotBtn.addEventListener('click', () => {
    if (!type) return;
    hubspotBtn.disabled = true;
    hubspotBtn.textContent = 'Envoi…';
    sendRuntimeMessageSafe(
      { action: 'addToHubSpot', companyName, type, jobTitle, jobUrl },
      (response, error) => {
        if (error) {
          hubspotBtn.textContent = 'Erreur';
          hubspotBtn.disabled = false;
          return;
        }
        if (response?.ok) {
          hubspotBtn.textContent = response.updated ? 'Mis à jour ✓' : 'Ajouté ✓';
          hubspotStatus.textContent = 'Déjà dans HubSpot';
          hubspotStatus.classList.remove('lph-financial-card__hubspot-status--new');
          hubspotStatus.classList.add('lph-financial-card__hubspot-status--exists');
        } else {
          hubspotBtn.textContent = response?.error ? `Erreur: ${String(response.error).slice(0, 80)}` : 'Erreur';
          hubspotBtn.disabled = false;
        }
      }
    );
  });
  card.appendChild(hubspotBtn);

  if (type) {
    sendRuntimeMessageSafe({ action: 'checkHubSpotCompany', companyName }, (hs, error) => {
      if (error || !hubspotStatus.isConnected) return;
      if (!hs?.configured) {
        hubspotStatus.textContent = 'Configure la clé HubSpot dans la popup';
        return;
      }
      if (hs.exists) {
        hubspotStatus.textContent = 'Déjà dans HubSpot';
        hubspotStatus.classList.add('lph-financial-card__hubspot-status--exists');
        hubspotBtn.textContent = 'Mettre à jour dans HubSpot';
      } else {
        hubspotStatus.textContent = 'Pas encore dans HubSpot';
        hubspotStatus.classList.add('lph-financial-card__hubspot-status--new');
      }
    });
  }

  card.style.display = 'block';
}

function installFinancialPanelJobSelection() {
  if (window.__pnFinancialPanelSelection) return;
  window.__pnFinancialPanelSelection = true;
  document.body.addEventListener(
    'click',
    (e) => {
      if (e.target.closest('.lph-financial-dock')) return;
      const wrapper = e.target.closest(`[${DATA_PN_PROCESSED}]`);
      if (!wrapper || !isJobCardInListColumn(wrapper)) return;
      const t = wrapper.getAttribute(DATA_PN_TYPE);
      if (t !== 'Client' && t !== 'SS2I') return;
      const openInNewTab = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
      const companyA = e.target.closest?.('a[href*="/company/"]');
      if (companyA && !openInNewTab) {
        e.preventDefault();
        e.stopPropagation();
      }
      const companyEl = findCompanyElementInCardDock(wrapper);
      const companyName = companyEl ? extractCompanyNameDock(companyEl) : '';
      if (!companyName) return;
      const { jobTitle, jobUrl } = getJobInfoFromWrapper(wrapper);
      const companyContext = buildCompanyContextForWrapper(wrapper, companyName);
      populateFinancialPanel(companyName, {
        type: t,
        jobTitle,
        jobUrl,
        companyContext,
        jobWrapper: wrapper
      });
    },
    true
  );
}

function attachFinancialPanelOpenJobClick() {
  if (window.__pnFinancialPanelOpenJob) return;
  window.__pnFinancialPanelOpenJob = true;
  document.body.addEventListener(
    'click',
    (e) => {
      const dock = e.target.closest('.lph-financial-dock');
      if (!dock || dock.hidden) return;
      const card = e.target.closest(`.${FINANCIAL_CARD_CLASS}`);
      if (!card) return;
      if (e.target.closest('button')) return;
      const url = card.dataset.lphJobUrl;
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.assign(url);
    },
    true
  );
}

function initFinancialDock() {
  ensureFinancialDock();
  syncFinancialDockVisibility();
  installFinancialPanelJobSelection();
  attachFinancialPanelOpenJobClick();
}

initFinancialDock();

let lastDockPath = String(location.pathname || '');
setInterval(() => {
  const p = String(location.pathname || '');
  if (p !== lastDockPath) {
    lastDockPath = p;
    syncFinancialDockVisibility();
  }
}, 600);
