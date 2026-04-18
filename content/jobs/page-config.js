/** Config LinkedIn (sélecteurs optionnels Collections) depuis chrome.storage. */

/** @type {{ linkedinCollectionsCardCss?: string, linkedinCollectionsCompanyCss?: string }} */
let pageConfig = {};

function hydratePageConfig() {
  try {
    chrome.storage.local.get('config', (r) => {
      const c = r && r.config && typeof r.config === 'object' ? r.config : {};
      pageConfig = {
        linkedinCollectionsCardCss: String(c.linkedinCollectionsCardCss || '').trim(),
        linkedinCollectionsCompanyCss: String(c.linkedinCollectionsCompanyCss || '').trim()
      };
    });
  } catch (_) {}
}

hydratePageConfig();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) hydratePageConfig();
  });
} catch (_) {}
