/** Création du dock HTML + visibilité selon la page. */

function ensureFinancialDock() {
  let dock = document.getElementById(FINANCIAL_DOCK_ID);
  if (dock?.isConnected) return dock;
  // LinkedIn SPA peut avoir retiré le nœud : on recrée.
  if (dock && !dock.isConnected) {
    try {
      dock.remove();
    } catch (_) {}
  }
  const mount = document.body || document.documentElement;
  if (!mount) return null;

  dock = document.createElement('aside');
  dock.id = FINANCIAL_DOCK_ID;
  dock.className = 'lph-financial-dock';
  dock.setAttribute('aria-label', 'Prospection — données entreprise');
  const header = document.createElement('div');
  header.className = 'lph-financial-dock__header';
  const brand = document.createElement('span');
  brand.className = 'lph-financial-dock__brand';
  brand.textContent = 'Prospection';
  const statusHost = document.createElement('div');
  statusHost.className = 'lph-financial-dock__status-host';
  statusHost.setAttribute('data-pn-status-host', '1');
  header.appendChild(brand);
  header.appendChild(statusHost);
  const body = document.createElement('div');
  body.className = 'lph-financial-dock__body';
  const ph = document.createElement('div');
  ph.className = 'lph-financial-dock__placeholder';
  ph.textContent =
    'Cliquez sur une offre classée Client ou SS2I pour afficher le score et les indicateurs.';
  body.appendChild(ph);
  dock.appendChild(header);
  dock.appendChild(body);
  try {
    mount.appendChild(dock);
  } catch (_) {
    return null;
  }
  try {
    const orphan = document.getElementById('pn-page-status');
    if (orphan && orphan.parentElement !== statusHost) statusHost.appendChild(orphan);
  } catch (_) {}
  return dock;
}

function getDockBody() {
  const dock = ensureFinancialDock();
  return /** @type {HTMLElement} */ (dock?.querySelector('.lph-financial-dock__body'));
}

function getFinancialCardMount() {
  const body = getDockBody();
  if (!body) return null;
  let card = body.querySelector(`.${FINANCIAL_CARD_CLASS}`);
  if (!card) {
    card = document.createElement('div');
    card.className = `${FINANCIAL_CARD_CLASS} lph-financial-card--docked`;
    card.setAttribute('aria-hidden', 'false');
    body.appendChild(card);
  }
  return /** @type {HTMLElement} */ (card);
}

function getFinancialDockWidthPx() {
  try {
    const raw = String(
      getComputedStyle(document.documentElement).getPropertyValue('--lph-financial-dock-width') || ''
    ).trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  return 280;
}

/** Top du dock = bas des filtres / haut de main (évite de chevaucher la barre de filtres). */
function measureFinancialDockTopPx() {
  try {
    const filters = document.getElementById('JobsSearchFilters');
    if (filters) {
      const bottom = Math.round(filters.getBoundingClientRect().bottom);
      if (bottom > 52 && bottom < window.innerHeight * 0.4) return bottom;
    }
  } catch (_) {}
  try {
    const main = document.querySelector('main');
    if (main) {
      const top = Math.round(main.getBoundingClientRect().top);
      if (top > 52 && top < window.innerHeight * 0.4) return top;
    }
  } catch (_) {}
  return 109;
}

/**
 * Layout dock : #root intact (Jobdesk), main décalé pour la liste.
 * Dock sous la barre de filtres (pleine largeur LinkedIn).
 */
function applyFinancialDockLayout() {
  const dockW = getFinancialDockWidthPx();
  const dockTop = measureFinancialDockTopPx();
  const root = document.getElementById('root');
  if (root) {
    try {
      root.style.removeProperty('width');
      root.style.setProperty('margin-left', '0', 'important');
      root.style.setProperty('transform', 'none', 'important');
    } catch (_) {}
  }
  try {
    document.body?.style?.removeProperty('padding-left');
  } catch (_) {}

  // Filtres : plus de décalage horizontal — le dock ne les chevauche plus verticalement.
  try {
    document.getElementById('JobsSearchFilters')?.style?.removeProperty('margin-left');
  } catch (_) {}

  let sty = document.getElementById('lph-dock-no-shift');
  if (!sty) {
    sty = document.createElement('style');
    sty.id = 'lph-dock-no-shift';
    (document.head || document.documentElement).appendChild(sty);
  }
  sty.textContent =
    'html.lph-financial-dock-active #root{margin-left:0!important;transform:none!important;}' +
    'html.lph-financial-dock-active main{padding-left:var(--lph-financial-dock-width)!important;box-sizing:border-box!important;}' +
    'html.lph-financial-dock-active body:not(:has(#root)){padding-left:0!important;}';

  const dock = document.getElementById(FINANCIAL_DOCK_ID);
  if (dock) {
    try {
      dock.style.setProperty('top', `${dockTop}px`, 'important');
    } catch (_) {}
  }
}

function releaseFinancialDockLayout() {
  const root = document.getElementById('root');
  if (root) {
    try {
      root.style.removeProperty('margin-left');
      root.style.removeProperty('width');
      root.style.removeProperty('transform');
    } catch (_) {}
  }
  try {
    document.body?.style?.removeProperty('padding-left');
  } catch (_) {}
  try {
    document.getElementById('JobsSearchFilters')?.style?.removeProperty('margin-left');
  } catch (_) {}
  try {
    document.getElementById(FINANCIAL_DOCK_ID)?.style?.removeProperty('top');
  } catch (_) {}
  try {
    document.getElementById('lph-dock-no-shift')?.remove();
  } catch (_) {}
}

function syncFinancialDockVisibility() {
  const show =
    typeof isJobsSearchResultsPath === 'function' &&
    typeof isJobsCollectionsPathDock === 'function' &&
    (isJobsSearchResultsPath() || isJobsCollectionsPathDock());

  if (!show) {
    const dock = document.getElementById(FINANCIAL_DOCK_ID);
    if (dock) dock.hidden = true;
    document.documentElement.classList.remove('lph-financial-dock-active');
    releaseFinancialDockLayout();
    return;
  }

  // Recréer si LinkedIn a remplacé le DOM (1er chargement SPA / navigation).
  const dock = ensureFinancialDock();
  if (!dock) return;
  dock.hidden = false;
  document.documentElement.classList.add('lph-financial-dock-active');
  applyFinancialDockLayout();
}
