/**
 * LinkedIn Jobs — badges SS2I / Client (search-results & collections).
 * Constantes DOM partagées par les modules jobs.
 */

const DATA_PROCESSED = 'data-pn-processed';
const DATA_LOADING = 'data-pn-loading';
const DATA_FAILED = 'data-pn-failed';
const DATA_TYPE = 'data-pn-type';

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
  'a[href*="/jobs/view/"], a[href*="/jobs/search/"], a[href*="/jobs/search-results"], a[href*="/jobs/collections"], a[href*="currentJobId="]';

const JOB_VIEW_LINK_SELECTOR = 'a[href*="/jobs/view/"]';
