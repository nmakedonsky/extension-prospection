/** Clic sur une carte classée → remplit le dock ; clic sur la carte dock → ouvre l’offre.
 *  Synchronisation avec l’offre déjà sélectionnée (URL currentJobId) pour afficher le dock sans re-clic. */

function getCurrentJobIdFromPage() {
  try {
    const u = new URL(location.href);
    const fromQuery = u.searchParams.get('currentJobId');
    if (fromQuery) return String(fromQuery).trim();
    const m = u.pathname.match(/\/jobs\/view\/(\d+)/i);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function getJobIdFromCardWrapper(wrapper) {
  if (!wrapper) return null;
  const a =
    wrapper.getAttribute('data-occludable-job-id') ||
    wrapper.getAttribute('data-job-id') ||
    wrapper.querySelector?.('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') ||
    wrapper.querySelector?.('[data-job-id]')?.getAttribute('data-job-id');
  return a ? String(a).trim() : null;
}

function findJobListCardByJobId(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return null;
  for (const sel of [`[data-occludable-job-id="${id}"]`, `[data-job-id="${id}"]`]) {
    let nodes;
    try {
      nodes = document.querySelectorAll(sel);
    } catch (_) {
      continue;
    }
    for (const start of nodes) {
      let n = start;
      for (let i = 0; i < 18 && n; i++) {
        if (isJobCardInListColumn(n)) return n;
        n = n.parentElement;
      }
    }
  }
  return null;
}

/** Évite de re-remplir en boucle pour le même currentJobId (URL). */
let syncedFinancialPanelJobId = null;
let lastFinancialSyncPathname = '';

async function openFinancialPanelForListedJob(wrapper) {
  if (!wrapper?.isConnected) return;
  const t = wrapper.getAttribute(DATA_PN_TYPE);
  if (t !== 'Client' && t !== 'SS2I') return;
  const companyEl = findCompanyElementInCardDock(wrapper);
  const companyName = companyEl ? extractCompanyNameDock(companyEl) : '';
  if (!companyName) return;
  const { jobTitle, jobUrl } = getJobInfoFromWrapper(wrapper);
  // Afficher tout de suite (évite le placeholder « en attente » pendant le match Gemini).
  populateFinancialPanel(companyName, {
    type: t,
    jobTitle,
    jobUrl,
    companyContext: null,
    matchContextOk: false,
    matchContextMissing: [],
    jobWrapper: wrapper
  });
  const jid = getCurrentJobIdFromPage() || getJobIdFromCardWrapper(wrapper);
  if (jid) syncedFinancialPanelJobId = jid;

  try {
    const ens = await ensureCompanyMatchContext(wrapper, companyName);
    if (!wrapper.isConnected) return;
    populateFinancialPanel(companyName, {
      type: t,
      jobTitle,
      jobUrl,
      companyContext: ens.context,
      matchContextOk: ens.ok,
      matchContextMissing: ens.missing,
      jobWrapper: wrapper
    });
  } catch (_) {}
}

/**
 * Remplit le dock dès qu’une offre Client/SS2I est sélectionnée (URL currentJobId).
 * Search-results et collections : même comportement (Jobdesk a toujours un currentJobId).
 */
function trySyncFinancialPanelToUrlSelectedJob() {
  const path = String(location.pathname || '');
  if (path !== lastFinancialSyncPathname) {
    lastFinancialSyncPathname = path;
    syncedFinancialPanelJobId = null;
  }

  if (typeof isClassificationTargetPage === 'function' && !isClassificationTargetPage()) return;

  const jobId = getCurrentJobIdFromPage();
  if (!jobId) {
    syncedFinancialPanelJobId = null;
    return;
  }

  if (syncedFinancialPanelJobId === jobId) return;

  let wrapper = findJobListCardByJobId(jobId);
  // Jobdesk SDUI : souvent pas de data-job-id — retrouver via componentkey.
  if (!wrapper?.isConnected) {
    try {
      wrapper =
        document.querySelector(`[componentkey="job-card-component-ref-${jobId}"]`) ||
        document.querySelector(`[componentkey$="-${jobId}"]`);
      if (wrapper && typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(wrapper)) {
        wrapper = null;
      }
    } catch (_) {
      wrapper = null;
    }
  }
  if (!wrapper?.isConnected) return;

  // Carte pas encore classifiée : retenter au prochain tick (ne pas figer synced id).
  if (!wrapper.hasAttribute(DATA_PN_PROCESSED)) return;

  const t = wrapper.getAttribute(DATA_PN_TYPE);
  if (t !== 'Client' && t !== 'SS2I') {
    syncedFinancialPanelJobId = jobId;
    return;
  }

  syncedFinancialPanelJobId = jobId;
  void openFinancialPanelForListedJob(wrapper).catch(() => {
    syncedFinancialPanelJobId = null;
  });
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
      void openFinancialPanelForListedJob(wrapper);
    },
    true
  );
}

function attachFinancialPanelOpenJobClick() {
  if (window.__pnFinancialPanelOpenJob) return;
  window.__pnFinancialPanelOpenJob = true;
  // Intention utilisateur: aucun clic dans le panneau financier ne doit rediriger vers la job.
}
