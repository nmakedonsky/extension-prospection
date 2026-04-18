/**
 * LinkedIn Jobs — badges SS2I / Client (search-results & collections).
 * Télémétrie : heartbeat vers Supabase uniquement (pas d’UI sur la page).
 *
 * Critères de succès (QA) :
 * - Collections : collectJobCards().length > 0 après scroll modéré ; badges sur le nom société de la liste, pas le panneau détail.
 * - Search-results : comportement inchangé (branche dédiée collectJobCardsSearchResults).
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

function querySelectorAllDeep(root, selector) {
  if (!root?.querySelectorAll) return [];
  const out = [];
  function searchInRoot(r) {
    try {
      r.querySelectorAll(selector).forEach((el) => out.push(el));
    } catch (_) {}
    let hosts;
    try {
      hosts = r.querySelectorAll('*');
    } catch (_) {
      return;
    }
    hosts.forEach((host) => {
      if (host.shadowRoot) searchInRoot(host.shadowRoot);
    });
  }
  searchInRoot(root);
  return out;
}

function getScanRoots() {
  const roots = [];
  const main = document.querySelector('main');
  const app = document.querySelector('#root');
  if (main) roots.push(main);
  if (app && app !== main) roots.push(app);
  if (!roots.length) roots.push(document.body);
  return roots;
}

/** Colonne liste (two-pane) : bord droit dans la moitié gauche — utilisé pour éviter les faux positifs « détail » sur /jobs/collections/. */
function isInLeftJobListColumn(el) {
  const vw = window.innerWidth || 1200;
  const r = el?.getBoundingClientRect?.();
  if (!r || r.width < 4 || r.height < 4) return false;
  return r.right < vw * 0.58;
}

/**
 * Vrai panneau détail (offre ouverte à droite). Sur Collections, des wrappers englobent parfois
 * toute la page avec des classes type scaffold/two-pane — on n’applique ces signaux « faibles »
 * que si le nœud n’est pas dans la colonne liste.
 */
function isNodeInJobDetailsComposed(el) {
  if (!el) return false;
  const relaxWeakDetailSignals = isJobsCollectionsPath() && isInLeftJobListColumn(el);
  let n = el;
  while (n) {
    if (n.nodeType === 1) {
      const ck = n.getAttribute?.('componentkey') || '';
      if (/JobDetails/i.test(ck)) return true;
      let cls = '';
      if (typeof n.className === 'string') cls = n.className;
      else if (n.className && typeof n.className.baseVal === 'string') cls = n.className.baseVal;
      if (cls.includes('jobs-unified-top-card') || cls.includes('jobs-search__job-details')) {
        return true;
      }
      if (relaxWeakDetailSignals) {
        const root = n.getRootNode?.({ composed: false });
        if (root instanceof ShadowRoot) n = root.host;
        else n = n.parentElement;
        continue;
      }
      if (
        cls.includes('scaffold-layout__detail') ||
        cls.includes('jobs-search-two-pane__details') ||
        (cls.includes('two-pane') && cls.includes('detail'))
      ) {
        return true;
      }
    }
    const root = n.getRootNode?.({ composed: false });
    if (root instanceof ShadowRoot) n = root.host;
    else n = n.parentElement;
  }
  return false;
}

function isLikelyLeftColumnJobCard(el) {
  const vw = window.innerWidth || 1200;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 8 || r.height < 8) return false;
  const cx = r.left + r.width / 2;
  if (cx > vw * 0.72) return false;
  return true;
}

/** Liste Collections : bord droit dans la colonne gauche (~two-pane) ou centre comme search-results. */
function isLikelyCollectionsListCard(el) {
  const vw = window.innerWidth || 1200;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 8 || r.height < 8) return false;
  if (r.right < vw * 0.58) return true;
  const cx = r.left + r.width / 2;
  return cx <= vw * 0.72;
}

function inferCardWrapperFromJobLink(anchor) {
  let n = anchor;
  let depth = 0;
  while (n && depth < 18) {
    if (n.nodeType === 1) {
      const tag = n.tagName?.toLowerCase() || '';
      const dj = n.getAttribute?.('data-job-id') || n.getAttribute?.('data-occludable-job-id') || '';
      const ck = String(n.getAttribute?.('componentkey') || '');
      if (dj || /job-card/i.test(ck)) return n;
      if (tag === 'li' && n.querySelector?.(JOB_VIEW_LINK_SELECTOR)) return n;
      if (tag === 'article') return n;
    }
    n = n.parentElement;
    depth++;
  }
  return anchor?.parentElement || anchor;
}

function isNoiseCompanyText(t) {
  const s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2) return true;
  if (/Sponsorisé|Consulté|Enregistré/i.test(s)) return true;
  if (/Publiée le|il y a \d|weeks? ago|days? ago|mois|semaines?|jour/i.test(s)) return true;
  if (/€\s*K\/yr|€\/yr|\$\s*K/i.test(s)) return true;
  return false;
}

function isJobsCollectionsPath() {
  return String(location.pathname || '').includes('/jobs/collections');
}

function findCompanyElementInCard(card) {
  if (!card?.querySelector) return null;
  const custom = pageConfig.linkedinCollectionsCompanyCss;
  if (custom && isJobsCollectionsPath()) {
    try {
      const hit = card.querySelector(custom);
      if (hit) return hit;
    } catch (_) {}
  }
  const linked =
    card.querySelector(':scope a[href*="/company/"]') ||
    card.querySelector('a[href*="/company/"]');
  if (linked) return linked;
  const classic = card.querySelector(
    '[class*="artdeco-entity-lockup__subtitle"], [class*="company-name"], [class*="job-card-container__company-name"], [class*="job-card-container__primary-description"], [class*="job-card-list__subtitle"]'
  );
  if (classic) return classic;
  const ps = Array.from(card.querySelectorAll(':scope p')).filter(
    (p) => !isNoiseCompanyText(p.textContent)
  );
  if (ps.length >= 2) return ps[1];
  if (ps.length === 1) return ps[0];
  return null;
}

function extractCompanyName(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll?.('.pn-badge').forEach((n) => n.remove());
  const text = clone.textContent?.trim() || '';
  return text.replace(/\s+/g, ' ').trim();
}

function dedupeKeyForCard(card) {
  const dj =
    card.getAttribute?.('data-job-id') ||
    card.getAttribute?.('data-occludable-job-id') ||
    '';
  if (dj) return `id:${dj}`;
  const ck = card.getAttribute?.('componentkey') || '';
  const m = ck.match(/^job-card-component-ref-(\d+)$/);
  if (m) return `ck:${m[1]}`;
  const a = card.querySelector?.(JOB_LINK_SELECTOR);
  if (a) {
    try {
      const u = new URL(a.href, location.href);
      const id = u.searchParams.get('currentJobId') || u.pathname.match(/\/jobs\/view\/(\d+)/)?.[1];
      if (id) return `url:${id}`;
      return `href:${u.pathname}`;
    } catch (_) {}
  }
  return `pos:${card.getBoundingClientRect().top | 0}`;
}

function collectJobCardsSearchResults() {
  const roots = getScanRoots();
  const seen = new Set();
  const cards = [];
  for (const root of roots) {
    for (const sel of JOB_CARD_SELECTORS) {
      for (const el of querySelectorAllDeep(root, sel)) {
        if (seen.has(el)) continue;
        if (isNodeInJobDetailsComposed(el)) continue;
        if (!isLikelyLeftColumnJobCard(el)) continue;
        seen.add(el);
        cards.push(el);
      }
    }
  }
  return cards;
}

function collectJobCardsCollections() {
  const roots = getScanRoots();
  const seen = new Set();
  const cards = [];

  function pushCard(el) {
    if (!el || seen.has(el)) return;
    if (isNodeInJobDetailsComposed(el)) return;
    if (!isLikelyCollectionsListCard(el)) return;
    seen.add(el);
    cards.push(el);
  }

  const custom = pageConfig.linkedinCollectionsCardCss;
  if (custom) {
    for (const root of roots) {
      try {
        querySelectorAllDeep(root, custom).forEach(pushCard);
      } catch (_) {}
    }
    if (cards.length) return cards;
  }

  for (const root of roots) {
    for (const sel of JOB_CARD_SELECTORS) {
      try {
        for (const el of querySelectorAllDeep(root, sel)) {
          pushCard(el);
        }
      } catch (_) {}
    }
  }

  const vw = window.innerWidth || 1200;
  for (const root of roots) {
    for (const a of querySelectorAllDeep(root, JOB_VIEW_LINK_SELECTOR)) {
      if (isNodeInJobDetailsComposed(a)) continue;
      const r = a.getBoundingClientRect?.();
      if (!r) continue;
      const inList =
        r.right < vw * 0.58 || r.left + r.width / 2 <= vw * 0.72;
      if (!inList) continue;
      const card = inferCardWrapperFromJobLink(a);
      pushCard(card);
    }
  }

  return cards;
}

function collectJobCards() {
  return isJobsCollectionsPath() ? collectJobCardsCollections() : collectJobCardsSearchResults();
}

function truncateRect(rect) {
  if (!rect) return null;
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    right: Math.round(rect.right),
    bottom: Math.round(rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function outerHtmlSnippet(el, maxLen) {
  if (!el?.outerHTML) return '';
  const s = el.outerHTML.replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/**
 * Rapport diagnostic : compteurs par sélecteur (raw → détail → géométrie search),
 * tailles des branches search/collections, stratégie liens.
 */
function buildDomDiagnosticReport() {
  const vw = window.innerWidth || 1200;
  const roots = getScanRoots();
  const perSelector = [];

  for (const sel of JOB_CARD_SELECTORS) {
    let raw = 0;
    let afterDetail = 0;
    let afterGeoSearch = 0;
    let afterGeoCollections = 0;
    const samples = [];
    for (const root of roots) {
      for (const el of querySelectorAllDeep(root, sel)) {
        raw++;
        if (isNodeInJobDetailsComposed(el)) continue;
        afterDetail++;
        if (isLikelyLeftColumnJobCard(el)) afterGeoSearch++;
        if (isLikelyCollectionsListCard(el)) afterGeoCollections++;
        if (samples.length < 2) {
          samples.push({
            tag: el.tagName,
            class: String(typeof el.className === 'string' ? el.className : '').slice(0, 100),
            rect: truncateRect(el.getBoundingClientRect()),
            snippet: outerHtmlSnippet(el, 220)
          });
        }
      }
    }
    perSelector.push({
      selector: sel,
      raw,
      afterExcludingDetailPanel: afterDetail,
      afterGeometrySearchResults: afterGeoSearch,
      afterGeometryCollections: afterGeoCollections,
      samples
    });
  }

  let anchorTotal = 0;
  let anchorInListColumn = 0;
  let anchorAfterDetail = 0;
  for (const root of roots) {
    for (const a of querySelectorAllDeep(root, JOB_VIEW_LINK_SELECTOR)) {
      anchorTotal++;
      if (isNodeInJobDetailsComposed(a)) continue;
      anchorAfterDetail++;
      const r = a.getBoundingClientRect?.();
      if (!r) continue;
      if (r.right < vw * 0.58 || r.left + r.width / 2 <= vw * 0.72) anchorInListColumn++;
    }
  }

  const searchCards = collectJobCardsSearchResults();
  const collectionsCards = collectJobCardsCollections();
  const active = collectJobCards();

  return {
    pathname: String(location.pathname || ''),
    href: String(location.href || '').slice(0, 500),
    viewportWidth: vw,
    dispatch: isJobsCollectionsPath() ? 'collections' : 'search-results',
    counts: {
      collectJobCardsSearchResults: searchCards.length,
      collectJobCardsCollections: collectionsCards.length,
      collectJobCardsActive: active.length
    },
    perSelector,
    linkStrategy: {
      anchorsTotalDeep: anchorTotal,
      anchorsExcludingDetail: anchorAfterDetail,
      anchorsInListColumnHeuristic: anchorInListColumn
    },
    config: {
      linkedinCollectionsCardCss: pageConfig.linkedinCollectionsCardCss || '',
      linkedinCollectionsCompanyCss: pageConfig.linkedinCollectionsCompanyCss || ''
    }
  };
}

function buildScanPayload() {
  const cards = collectJobCards();
  const companies = [];
  const seenNames = new Set();
  for (const card of cards) {
    const cel = findCompanyElementInCard(card);
    const name = extractCompanyName(cel);
    if (!name || name.length < 2 || seenNames.has(name)) continue;
    seenNames.add(name);
    companies.push(name);
  }
  return {
    cardCount: cards.length,
    companyCount: companies.length,
    sampleCompanies: companies.slice(0, 8),
    pageKind: isJobsCollectionsPath() ? 'collections' : 'search-results'
  };
}

function applyPathMarkerClass() {
  try {
    const html = document.documentElement;
    const p = String(location.pathname || '');
    html.classList.remove('pn-path-jobs-search-results', 'pn-path-jobs-collections');
    if (p.includes('/jobs/search-results')) html.classList.add('pn-path-jobs-search-results');
    else if (p.includes('/jobs/collections')) html.classList.add('pn-path-jobs-collections');
  } catch (_) {}
}

function isClassificationTargetPage() {
  const p = String(location.pathname || '');
  return p.includes('/jobs/search-results') || p.includes('/jobs/collections');
}

function createBadge(kind) {
  const span = document.createElement('span');
  span.className =
    'pn-badge ' +
    (kind === 'loading'
      ? 'pn-badge--loading'
      : kind === 'Client'
        ? 'pn-badge--client'
        : 'pn-badge--ss2i');
  span.textContent = kind === 'loading' ? '…' : kind === 'Client' ? 'Client' : 'SS2I';
  span.setAttribute('data-prospection-badge', '1');
  return span;
}

function sendClassify(companyName) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'CLASSIFY_COMPANY', companyName }, (res) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(res === 'Client' || res === 'SS2I' ? res : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function processCard(card) {
  if (!isClassificationTargetPage()) return;
  const cel = findCompanyElementInCard(card);
  const companyName = extractCompanyName(cel);
  if (!companyName || companyName.length < 2) return;
  if (card.hasAttribute(DATA_PROCESSED)) return;
  if (card.hasAttribute(DATA_LOADING)) return;
  const failedAt = Number(card.getAttribute(DATA_FAILED) || '0');
  if (failedAt && Date.now() - failedAt < 15000) return;

  const hostEl = cel;
  if (!hostEl || isNodeInJobDetailsComposed(card)) return;

  card.setAttribute(DATA_LOADING, 'true');
  hostEl.querySelectorAll('.pn-badge').forEach((b) => b.remove());
  const placeholder = createBadge('loading');
  hostEl.appendChild(placeholder);

  try {
    const type = await sendClassify(companyName);
    if (placeholder.isConnected) placeholder.remove();
    card.removeAttribute(DATA_LOADING);
    if (!type) {
      card.setAttribute(DATA_FAILED, String(Date.now()));
      return;
    }
    card.setAttribute(DATA_PROCESSED, 'true');
    card.setAttribute(DATA_TYPE, type);
    card.removeAttribute(DATA_FAILED);
    const el = findCompanyElementInCard(card);
    if (el && !isNodeInJobDetailsComposed(el)) {
      el.querySelectorAll('.pn-badge').forEach((b) => b.remove());
      el.appendChild(createBadge(type));
    }
  } catch (_) {
    if (placeholder.isConnected) placeholder.remove();
    card.removeAttribute(DATA_LOADING);
    card.setAttribute(DATA_FAILED, String(Date.now()));
  }
}

let classifyDebounce = null;
let lastPath = '';

async function runClassificationPass() {
  if (!isClassificationTargetPage()) return;

  const cards = collectJobCards();
  const todo = [];
  for (const card of cards) {
    if (card.hasAttribute(DATA_PROCESSED)) continue;
    if (card.hasAttribute(DATA_LOADING)) continue;
    const failedAt = Number(card.getAttribute(DATA_FAILED) || '0');
    if (failedAt && Date.now() - failedAt < 15000) continue;
    const cel = findCompanyElementInCard(card);
    const name = extractCompanyName(cel);
    if (!name || name.length < 2) continue;
    todo.push(card);
  }

  const concurrency = 3;
  let wi = 0;
  async function worker() {
    while (true) {
      const idx = wi++;
      if (idx >= todo.length) return;
      const card = todo[idx];
      if (card?.isConnected) await processCard(card);
    }
  }
  const n = Math.min(concurrency, Math.max(1, todo.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

function scheduleClassification() {
  if (!isClassificationTargetPage()) return;
  if (classifyDebounce) clearTimeout(classifyDebounce);
  classifyDebounce = setTimeout(() => {
    classifyDebounce = null;
    void runClassificationPass();
  }, 140);
}

let lastLogAt = 0;
const LOG_INTERVAL_MS = 45000;

function sendHeartbeat(payload, forceLog) {
  const now = Date.now();
  const shouldLog = forceLog || now - lastLogAt >= LOG_INTERVAL_MS;
  if (shouldLog) lastLogAt = now;
  try {
    chrome.runtime.sendMessage({
      type: 'JOBS_PAGE_HEARTBEAT',
      payload: {
        ...payload,
        pageUrl: String(location.href || '').slice(0, 800),
        logToSupabase: shouldLog
      }
    });
  } catch (_) {}
}

function tick() {
  applyPathMarkerClass();
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
  }
  const payload = buildScanPayload();
  sendHeartbeat(payload, false);
  scheduleClassification();
}

let scheduled = false;
function scheduleTick() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    tick();
  });
}

const mo = new MutationObserver(() => scheduleTick());
mo.observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleTick();
});

lastPath = location.pathname;
applyPathMarkerClass();
scheduleTick();
sendHeartbeat(buildScanPayload(), true);

setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    applyPathMarkerClass();
    scheduleTick();
  }
}, 800);

try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'PROSPECTION_DOM_DIAGNOSTIC') return false;
    try {
      const report = buildDomDiagnosticReport();
      sendResponse({ ok: true, report });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return true;
  });
} catch (_) {}
