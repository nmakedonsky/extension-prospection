/**
 * LinkedIn Jobs — badges SS2I / Client (search-results & collections).
 * Télémétrie : heartbeat vers Supabase uniquement (pas d’UI sur la page).
 *
 * Collections (/jobs/collections/*) : stratégie dédiée — pas de sélecteurs « carte » fragiles.
 * On part des liens d’offre (href view / currentJobId), on filtre par position (colonne gauche
 * vs panneau détail), puis on remonte à un conteneur carte. Repli : cartes componentkey visibles à gauche.
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

function isNodeInJobDetailsComposed(el) {
  if (!el) return false;
  let n = el;
  while (n) {
    if (n.nodeType === 1) {
      const ck = n.getAttribute?.('componentkey') || '';
      if (/JobDetails/i.test(ck)) return true;
      let cls = '';
      if (typeof n.className === 'string') cls = n.className;
      else if (n.className && typeof n.className.baseVal === 'string') cls = n.className.baseVal;
      if (
        cls.includes('scaffold-layout__detail') ||
        cls.includes('jobs-search__job-details') ||
        cls.includes('jobs-search-two-pane__details') ||
        cls.includes('jobs-unified-top-card') ||
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

/** Centre horizontal de l’élément (viewport), pour séparer liste gauche / fiche droite. */
function elementCenterX(el) {
  const r = el?.getBoundingClientRect?.();
  if (!r) return null;
  return r.left + r.width / 2;
}

function isLikelyLeftColumnJobCard(el) {
  const vw = window.innerWidth || 1200;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 8 || r.height < 8) return false;
  const cx = r.left + r.width / 2;
  if (cx > vw * 0.72) return false;
  return true;
}

function isJobsCollectionsPath() {
  try {
    return String(location.pathname || '').includes('/jobs/collections');
  } catch (_) {
    return false;
  }
}

/**
 * Sur Collections, le panneau détail est à droite : les cartes liste ont le centre du nœud
 * nettement dans la portion gauche de la fenêtre (seuil un peu plus large que search-results).
 */
function isInLeftJobsColumn(el, maxCenterRatio) {
  const vw = window.innerWidth || 1200;
  const cx = elementCenterX(el);
  if (cx == null) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 && r.height < 4) return false;
  return cx < vw * maxCenterRatio;
}

/**
 * Remonte depuis un lien « offre » vers un nœud qui ressemble à une ligne de liste.
 */
function inferCardWrapperFromJobLink(anchor) {
  if (!anchor) return null;
  let n = anchor;
  for (let depth = 0; depth < 16 && n; depth++) {
    if (n.nodeType !== 1) {
      n = n.parentElement;
      continue;
    }
    if (n.tagName === 'LI') return n;
    const ck = n.getAttribute?.('componentkey') || '';
    if (/^job-card-component-ref-\d+$/i.test(ck)) return n;
    if (n.hasAttribute?.('data-job-id') || n.hasAttribute?.('data-occludable-job-id')) return n;
    const cls = typeof n.className === 'string' ? n.className : '';
    if (/\bjob-card|entity-result|semantic-search|base-card\b/i.test(cls) && n.tagName === 'DIV') {
      return n;
    }
    n = n.parentElement;
  }
  return anchor.parentElement?.parentElement || anchor.parentElement || null;
}

/**
 * Collections : cartes = ancres vers offres dans la moitié gauche + inférence de conteneur.
 * Repli : div[componentkey^=job-card-component-ref] à gauche (certains builds peuvent peupler sans <a> listé).
 */
function collectJobCardsCollections() {
  const LEFT_MAX = 0.74;
  const seen = new Set();
  const out = [];

  const anchorSelector = 'a[href*="/jobs/view/"], a[href*="currentJobId="]';
  const anchors = querySelectorAllDeep(document.documentElement, anchorSelector);

  for (const a of anchors) {
    let href = '';
    try {
      href = (a.getAttribute('href') || '').toLowerCase();
    } catch (_) {
      continue;
    }
    if (!href.includes('/jobs/view') && !href.includes('currentjobid')) continue;

    if (!isInLeftJobsColumn(a, LEFT_MAX)) continue;
    if (isNodeInJobDetailsComposed(a)) continue;

    const card = inferCardWrapperFromJobLink(a);
    if (!card || seen.has(card)) continue;
    if (isNodeInJobDetailsComposed(card)) continue;
    if (!isInLeftJobsColumn(card, LEFT_MAX)) continue;

    seen.add(card);
    out.push(card);
  }

  const ckSelector = 'div[role="button"][componentkey^="job-card-component-ref-"], div[componentkey^="job-card-component-ref-"]';
  for (const el of querySelectorAllDeep(document.documentElement, ckSelector)) {
    if (seen.has(el)) continue;
    if (isNodeInJobDetailsComposed(el)) continue;
    if (!isInLeftJobsColumn(el, LEFT_MAX)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) continue;
    seen.add(el);
    out.push(el);
  }

  return out;
}

function collectJobCardsSearchResults() {
  const roots = [];
  const main = document.querySelector('main');
  const app = document.querySelector('#root');
  if (main) roots.push(main);
  if (app && app !== main) roots.push(app);
  if (!roots.length) roots.push(document.body);

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

function findCompanyElementInCard(card) {
  if (!card?.querySelector) return null;
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

function collectJobCards() {
  if (isJobsCollectionsPath()) {
    return collectJobCardsCollections();
  }
  return collectJobCardsSearchResults();
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
    sampleCompanies: companies.slice(0, 8)
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
