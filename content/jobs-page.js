/**
 * LinkedIn Jobs — détection des cartes dans la colonne liste (gauche) et affichage d’une barre d’état.
 * Logique métier (classification, scrape détail) : étapes ultérieures.
 */

const EXT_ID = 'prospection-next';

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

function isLikelyLeftColumnJobCard(el) {
  const vw = window.innerWidth || 1200;
  const r = el.getBoundingClientRect?.();
  if (!r || r.width < 8 || r.height < 8) return false;
  const cx = r.left + r.width / 2;
  if (cx > vw * 0.72) return false;
  return true;
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
  clone.querySelectorAll?.('[data-prospection-badge]').forEach((n) => n.remove());
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

let bannerEl = null;
let lastLogAt = 0;
const LOG_INTERVAL_MS = 45000;

function ensureBanner() {
  if (bannerEl?.isConnected) return bannerEl;
  bannerEl = document.createElement('div');
  bannerEl.id = 'prospection-next-banner';
  bannerEl.setAttribute('data-extension', EXT_ID);
  document.documentElement.appendChild(bannerEl);
  return bannerEl;
}

function renderBanner(payload) {
  const el = ensureBanner();
  const samples =
    payload.sampleCompanies && payload.sampleCompanies.length
      ? payload.sampleCompanies.join(' · ')
      : '—';
  el.innerHTML = `
    <div class="pn-title">Prospection</div>
    <div class="pn-stats">${payload.cardCount} carte(s) détectée(s) · ${payload.companyCount} entreprise(s)</div>
    <div class="pn-samples">${samples}</div>
  `;
}

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
  const payload = buildScanPayload();
  renderBanner(payload);
  sendHeartbeat(payload, false);
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

scheduleTick();
sendHeartbeat(buildScanPayload(), true);
