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
