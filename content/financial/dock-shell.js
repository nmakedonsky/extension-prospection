/** Création du dock HTML + visibilité selon la page. */

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
