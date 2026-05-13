/**
 * Lecture panneau Jobdesk (droite) + envoi saveJobOffer au background.
 * Reprise logique « repoll » jusqu’à description exploitable ou délai max.
 */

const JOB_SCRAPE_AFTER_OPEN_FIRST_DELAY_MS = 520;
const JOB_SCRAPE_AFTER_OPEN_STEP_MS = 380;
const JOB_SCRAPE_AFTER_OPEN_MAX_MS = 18000;

const JOB_DETAIL_PANEL_SELECTORS = [
  '.jobs-search__job-details--container',
  '[class*="jobs-search__job-details"]',
  '[class*="job-details-jobs-unified-top-card"]',
  '[class*="scaffold-layout__detail"]'
];

const JOB_DESCRIPTION_SELECTORS = [
  '.jobs-description-content__text',
  '.jobs-box__html-content',
  '[class*="jobs-description-content__text"]',
  '[class*="jobs-box__html-content"]',
  '[class*="jobs-description"]'
];

const JOB_METADATA_ITEM_SELECTORS = [
  '.job-details-jobs-unified-top-card__job-insight',
  '[class*="job-details-jobs-unified-top-card__job-insight"]',
  '.jobs-unified-top-card__job-insight',
  '[class*="jobs-unified-top-card__job-insight"]'
];

let lastSavedJobFingerprint = null;

function jdScPageKey() {
  try {
    const u = new URL(location.href);
    return `${u.pathname}|st=${u.searchParams.get('start') || '0'}`.slice(0, 200);
  } catch (_) {
    return '';
  }
}

/** Aligné sur `jobdesk-autoopen.js` (liste sans `currentJobId`). */
function jdListPageKeyForLog() {
  try {
    const u = new URL(location.href);
    const sp = new URLSearchParams(u.search);
    sp.delete('currentJobId');
    const qs = sp.toString();
    return `${u.pathname || ''}${qs ? `?${qs}` : ''}`.slice(0, 200);
  } catch (_) {
    return '';
  }
}

function jdScLog(payload) {
  try {
    sendRuntimeMessageSafe(
      {
        type: 'EXTENSION_LOG',
        event: 'jd_sc',
        level: 'info',
        data: { ...(payload || {}), pk: jdScPageKey(), lk: jdListPageKeyForLog() || undefined, t: Date.now() }
      },
      () => {}
    );
  } catch (_) {}
}

function pnNormalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getJobDetailsPanel() {
  for (const selector of JOB_DETAIL_PANEL_SELECTORS) {
    const panel = document.querySelector(selector);
    if (panel) return panel;
  }
  return null;
}

function getFirstText(root, selectors) {
  if (!root) return '';
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    const text = pnNormalizeText(el?.innerText || el?.textContent || '');
    if (text) return text;
  }
  return '';
}

function getAllTexts(root, selectors) {
  if (!root) return [];
  const values = [];
  selectors.forEach((selector) => {
    root.querySelectorAll(selector).forEach((el) => {
      const text = pnNormalizeText(el.innerText || el.textContent || '');
      if (text) values.push(text);
    });
  });
  return Array.from(new Set(values));
}

function splitJobMetadata(metadataItems) {
  const location = metadataItems[0] || '';
  const details = metadataItems.slice(1).join(' | ');
  return { location, details };
}

function getCardMetadata(wrapper) {
  return getAllTexts(wrapper, [
    '.job-card-container__metadata-item',
    '[class*="job-card-container__metadata-item"]',
    '.job-card-container__footer-item',
    '[class*="job-card-container__footer-item"]',
    '.artdeco-entity-lockup__caption',
    '[class*="artdeco-entity-lockup__caption"]'
  ]);
}

function getCompanyNameFromJobWrapper(wrapper) {
  const companyEl = findCompanyElementInCard(wrapper);
  return extractCompanyName(companyEl);
}

function buildJobCardPayload(wrapper) {
  const { jobTitle, jobUrl } = getJobInfoFromWrapper(wrapper || document.body);
  const companyName = getCompanyNameFromJobWrapper(wrapper);
  const linkedinJobId = getJobIdFromWrapper(wrapper, jobUrl);
  const metadataItems = getCardMetadata(wrapper);
  const { location, details } = splitJobMetadata(metadataItems);
  if (!companyName && !jobTitle && !linkedinJobId && !jobUrl) return null;

  return {
    stage: 'card',
    linkedinJobId: linkedinJobId || null,
    companyName: companyName || null,
    companyType: wrapper?.getAttribute?.(DATA_TYPE) || null,
    jobTitle: jobTitle || null,
    jobUrl: pnNormalizeText(jobUrl) || null,
    location: location || null,
    source: 'linkedin_jobs',
    seenAt: new Date().toISOString(),
    cardData: {
      metadataItems,
      detailsText: details || null,
      attributes: {
        dataJobId: wrapper?.getAttribute?.('data-job-id') || null,
        dataOccludableJobId: wrapper?.getAttribute?.('data-occludable-job-id') || null
      }
    }
  };
}

function buildJobDetailsPayload(wrapper) {
  const detailsPanel = getJobDetailsPanel();
  const cardPayload = buildJobCardPayload(wrapper) || {};
  const companyName = getFirstText(detailsPanel, [
    '.job-details-jobs-unified-top-card__company-name',
    '[class*="job-details-jobs-unified-top-card__company-name"]',
    '.jobs-unified-top-card__company-name',
    '[class*="jobs-unified-top-card__company-name"]',
    'a[href*="/company/"]'
  ]) || cardPayload.companyName;
  const descriptionEl = detailsPanel
    ? JOB_DESCRIPTION_SELECTORS.map((selector) => detailsPanel.querySelector(selector)).find(Boolean)
    : null;
  const descriptionText = pnNormalizeText(descriptionEl?.innerText || descriptionEl?.textContent || '');
  if (!companyName || !descriptionText) return null;

  const detailJobTitle = getFirstText(detailsPanel, [
    '.job-details-jobs-unified-top-card__job-title',
    '[class*="job-details-jobs-unified-top-card__job-title"]',
    '.jobs-unified-top-card__job-title',
    '[class*="jobs-unified-top-card__job-title"]',
    'h1'
  ]);
  const detailJobUrl = detailsPanel?.querySelector?.('a[href*="/jobs/view/"]')?.href || '';
  const jobTitle = detailJobTitle || cardPayload.jobTitle || '';
  const jobUrl = pnNormalizeText(detailJobUrl || cardPayload.jobUrl || '');
  const linkedinJobId = getJobIdFromWrapper(wrapper, jobUrl);
  const metadataItems = getAllTexts(detailsPanel, JOB_METADATA_ITEM_SELECTORS);
  const { location, details } = splitJobMetadata(metadataItems);
  const companyType = wrapper?.getAttribute?.(DATA_TYPE) || null;
  const descriptionHtml = descriptionEl?.innerHTML ? String(descriptionEl.innerHTML).trim() : '';

  if (!jobTitle && !linkedinJobId && !jobUrl) return null;

  return {
    stage: 'details',
    linkedinJobId: linkedinJobId || null,
    companyName,
    companyType,
    jobTitle: jobTitle || null,
    jobUrl: jobUrl || null,
    location: location || null,
    descriptionText,
    detailsScrapedAt: new Date().toISOString(),
    source: 'linkedin_jobs',
    linkedinData: {
      card: cardPayload.cardData || null,
      details: {
        metadataItems,
        detailsText: details || null,
        descriptionHtml: descriptionHtml || null
      }
    }
  };
}

function isElementVisible(el) {
  if (!el) return false;
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return true;
    return style.display !== 'none' && style.visibility !== 'hidden';
  } catch (_) {
    return true;
  }
}

function getJobDeskReadyState(payload) {
  const detailsPanel = getJobDetailsPanel();
  const metadataCount = Array.isArray(payload?.linkedinData?.details?.metadataItems)
    ? payload.linkedinData.details.metadataItems.length
    : 0;
  const descriptionLength = String(payload?.descriptionText || '').trim().length;
  const hasTitle = String(payload?.jobTitle || '').trim().length > 0;
  const hasCompany = String(payload?.companyName || '').trim().length > 0;
  return {
    isReady:
      !!payload &&
      isElementVisible(detailsPanel) &&
      hasCompany &&
      hasTitle &&
      descriptionLength > 0 &&
      metadataCount >= 1,
    signature: JSON.stringify([
      payload?.linkedinJobId || '',
      payload?.jobUrl || '',
      payload?.jobTitle || '',
      payload?.companyName || '',
      payload?.location || '',
      metadataCount,
      descriptionLength
    ])
  };
}

function pnSaveJobOfferToBackground(jobOffer, wrapper) {
  const fingerprint = JSON.stringify([
    jobOffer.stage || '',
    jobOffer.linkedinJobId || '',
    jobOffer.jobUrl || '',
    jobOffer.companyName || '',
    jobOffer.jobTitle || '',
    jobOffer.location || '',
    jobOffer.descriptionText || ''
  ]);
  if (fingerprint === lastSavedJobFingerprint) return;
  lastSavedJobFingerprint = fingerprint;
  const dedupKey =
    wrapper && typeof dedupeKeyForCard === 'function' ? dedupeKeyForCard(wrapper) : '';
  sendRuntimeMessageSafe({ action: 'saveJobOffer', jobOffer, dedupKey }, () => {});
}

/**
 * Enchaîne après ouverture du panneau détail : `buildJobDetailsPayload` lit le DOM Jobdesk.
 * @param {HTMLElement|null} wrapper
 * @param {{ o?: 'a' | 'u' }} [opts] o=a auto-open, o=u clic utilisateur
 */
function scheduleJobOfferScrape(wrapper, opts) {
  const origin = opts && opts.o === 'u' ? 'u' : 'a';
  const card0 = buildJobCardPayload(wrapper);
  const jid0 = String(card0?.linkedinJobId || '');
  const started = Date.now();
  jdScLog({ jid: jid0, st: 'b', o: origin });

  let finished = false;
  let bestPayload = null;
  let lastReadySignature = '';
  let stableReadyCount = 0;

  const attempt = () => {
    if (finished) return;
    if (wrapper && !wrapper.isConnected) {
      finished = true;
      jdScLog({ jid: jid0, st: 'x', o: origin, ms: Date.now() - started });
      return;
    }
    const payload = buildJobDetailsPayload(wrapper);
    if (payload) bestPayload = payload;

    const { isReady, signature } = getJobDeskReadyState(payload);
    if (isReady) {
      stableReadyCount = signature === lastReadySignature ? stableReadyCount + 1 : 1;
      lastReadySignature = signature;
    } else {
      stableReadyCount = 0;
      lastReadySignature = '';
    }

    if (stableReadyCount >= 2 && payload) {
      finished = true;
      pnSaveJobOfferToBackground(payload, wrapper);
      jdScLog({
        jid: String(payload.linkedinJobId || jid0),
        st: 'ok',
        o: origin,
        ms: Date.now() - started,
        dl: String(payload.descriptionText || '').length
      });
      return;
    }
    if (Date.now() - started >= JOB_SCRAPE_AFTER_OPEN_MAX_MS) {
      finished = true;
      if (bestPayload) pnSaveJobOfferToBackground(bestPayload, wrapper);
      jdScLog({
        jid: String((bestPayload && bestPayload.linkedinJobId) || jid0),
        st: bestPayload ? 't' : 'e',
        o: origin,
        ms: Date.now() - started,
        dl: bestPayload ? String(bestPayload.descriptionText || '').length : 0
      });
      return;
    }
    window.setTimeout(attempt, JOB_SCRAPE_AFTER_OPEN_STEP_MS);
  };

  window.setTimeout(attempt, JOB_SCRAPE_AFTER_OPEN_FIRST_DELAY_MS);
}

function saveJobCardSnapshot(wrapper) {
  if (!wrapper || wrapper.hasAttribute(DATA_JOB_CARD_SAVED)) return;
  const payload = buildJobCardPayload(wrapper);
  if (!payload) return;
  wrapper.setAttribute(DATA_JOB_CARD_SAVED, 'true');
  pnSaveJobOfferToBackground(payload);
}

function getJobCardWrapperFromEventTarget(target) {
  if (!target?.closest) return null;
  const processed = target.closest(`[${DATA_PROCESSED}]`);
  if (processed && typeof isJobCardInListColumn === 'function' && isJobCardInListColumn(processed)) {
    return processed;
  }
  const link = target.closest(JOB_VIEW_LINK_SELECTOR);
  if (link && typeof inferCardWrapperFromJobLink === 'function') {
    return inferCardWrapperFromJobLink(link);
  }
  return target.closest(
    'div[componentkey^="job-card-component-ref-"], li[data-occludable-job-id], li[data-job-id], div[data-job-id]'
  );
}

function attachUserClickJobdeskScrape() {
  if (window.__pnJobdeskUserClickScrape) return;
  window.__pnJobdeskUserClickScrape = true;
  document.body.addEventListener(
    'click',
    (event) => {
      const wrapper = getJobCardWrapperFromEventTarget(event.target);
      if (!wrapper) return;
      scheduleJobOfferScrape(wrapper, { o: 'u' });
    },
    true
  );
}
