/** Clic sur une carte classée → remplit le dock ; clic sur la carte dock → ouvre l’offre. */

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
