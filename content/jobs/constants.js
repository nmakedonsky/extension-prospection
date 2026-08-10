/**
 * LinkedIn Jobs — badges SS2I / Client (search-results & collections).
 * Constantes DOM partagées par les modules jobs.
 */

const DATA_PROCESSED = 'data-pn-processed';
const DATA_LOADING = 'data-pn-loading';
const DATA_LOADING_AT = 'data-pn-loading-at';
const DATA_FAILED = 'data-pn-failed';
const DATA_TYPE = 'data-pn-type';
/** Carte : snapshot carte déjà envoyé (évite doublons saveJobOffer stage=card). */
const DATA_JOB_CARD_SAVED = 'data-pn-job-card-saved';

/**
 * Employeurs aspirés (auto-open Jobdesk → saved_jobs).
 * Client + SS2I : marché freelance majoritairement ESN / SS2I.
 */
function pnIsAspirableEmployerType(type) {
  return type === 'Client' || type === 'SS2I';
}

/** Sélecteur cartes liste déjà classifiées et aspirables. */
function pnAspirableJobCardsSelector() {
  return `[${DATA_PROCESSED}][${DATA_TYPE}="Client"], [${DATA_PROCESSED}][${DATA_TYPE}="SS2I"]`;
}
const JOB_CARD_SELECTORS = [
  'div[componentkey^="job-card-component-ref-"]',
  'div[role="button"][componentkey^="job-card-component-ref-"]',
  'li[data-occludable-job-id]',
  'li[data-job-id]',
  'div[data-job-id][class*="job-card"]',
  'div.job-card-container[data-job-id]',
  'div[class*="jobs-search-results__job-card"][data-job-id]',
  'li[class*="jobs-search-results__list-item"]',
  'li[class*="job-card-list__entity-result"]',
  'div[class*="job-card-container"]'
];

const JOB_LINK_SELECTOR =
  'a[href*="/jobs/view/"], a[href*="/jobs/search/"], a[href*="/jobs/search-results"], a[href*="/jobs/collections"], a[href*="-emplois"], a[href*="currentJobId="]';

const JOB_VIEW_LINK_SELECTOR = 'a[href*="/jobs/view/"]';
