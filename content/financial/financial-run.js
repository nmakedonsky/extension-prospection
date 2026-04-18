/** Point d’entrée dock + suivi navigation SPA LinkedIn. */

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

/** Offre déjà sélectionnée dans l’URL (fond gris) : remplir le dock dès que la carte est classée, sans reclic. */
setInterval(() => {
  try {
    if (typeof trySyncFinancialPanelToUrlSelectedJob === 'function') {
      trySyncFinancialPanelToUrlSelectedJob();
    }
  } catch (_) {}
}, 450);
