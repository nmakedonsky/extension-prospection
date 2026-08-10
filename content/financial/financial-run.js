/** Point d’entrée dock + suivi navigation SPA LinkedIn. */

function initFinancialDock() {
  ensureFinancialDock();
  syncFinancialDockVisibility();
  if (typeof installFinancialPanelJobSelection === 'function') {
    installFinancialPanelJobSelection();
  }
  if (typeof attachFinancialPanelOpenJobClick === 'function') {
    attachFinancialPanelOpenJobClick();
  }
}

function pnDockPageKey() {
  try {
    return `${location.pathname || ''}${location.search || ''}`;
  } catch (_) {
    return String(location.pathname || '');
  }
}

function pnBootFinancialDock() {
  try {
    initFinancialDock();
  } catch (_) {}
  try {
    syncFinancialDockVisibility();
  } catch (_) {}
}

pnBootFinancialDock();

// LinkedIn remplace souvent le DOM juste après document_idle : re-monter le dock.
[400, 1200, 2800, 5000].forEach((ms) => {
  setTimeout(() => {
    try {
      syncFinancialDockVisibility();
      if (typeof ensureFinancialDock === 'function' && (isJobsSearchResultsPath() || isJobsCollectionsPathDock())) {
        ensureFinancialDock();
        syncFinancialDockVisibility();
      }
    } catch (_) {}
  }, ms);
});

let lastDockPageKey = pnDockPageKey();
setInterval(() => {
  const k = pnDockPageKey();
  if (k !== lastDockPageKey) {
    lastDockPageKey = k;
    syncFinancialDockVisibility();
  } else if (isJobsSearchResultsPath() || isJobsCollectionsPathDock()) {
    // Dock disparu du DOM sans changement d’URL → recréer.
    const dock = document.getElementById(typeof FINANCIAL_DOCK_ID !== 'undefined' ? FINANCIAL_DOCK_ID : 'lph-financial-dock');
    if (!dock?.isConnected) syncFinancialDockVisibility();
  }
}, 600);

/** Historique SPA (feed → jobs collections) sans reload. */
(function installDockHistoryHooks() {
  if (window.__pnDockHistoryHooks) return;
  window.__pnDockHistoryHooks = true;
  const bump = () => {
    lastDockPageKey = '';
    setTimeout(() => {
      try {
        syncFinancialDockVisibility();
      } catch (_) {}
    }, 50);
    setTimeout(() => {
      try {
        syncFinancialDockVisibility();
      } catch (_) {}
    }, 400);
  };
  try {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (...args) {
        const r = orig.apply(this, args);
        bump();
        return r;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  } catch (_) {}
  window.addEventListener('popstate', bump);
})();

/** Offre déjà sélectionnée dans l’URL (fond gris) : remplir le dock dès que la carte est classée, sans reclic. */
setInterval(() => {
  try {
    if (typeof trySyncFinancialPanelToUrlSelectedJob === 'function') {
      trySyncFinancialPanelToUrlSelectedJob();
    }
  } catch (_) {}
}, 450);
