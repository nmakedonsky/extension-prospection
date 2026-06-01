/**
 * Contexte de matching unique : collecte DOM + logo en image (base64) + tentatives si incomplet.
 * Doit être chargé après company-dock.js (utilise getJobInfoFromWrapper).
 */

const MATCH_CONTEXT_VERSION = 4;
const MATCH_ENSURE_MAX_ATTEMPTS = 6;
const MATCH_RETRY_DELAY_MS = 380;
const LOGO_FETCH_MAX_ATTEMPTS = 3;
const LOGO_MAX_BYTES = 450000;

function pnTrim(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pnIsValidLinkedinCompanyUrl(u) {
  const s = pnTrim(u);
  if (!s) return false;
  try {
    const p = new URL(s, 'https://www.linkedin.com');
    const h = p.hostname.toLowerCase();
    if (!h.endsWith('linkedin.com')) return false;
    return /\/company\//i.test(p.pathname);
  } catch {
    return false;
  }
}

/**
 * Normalise l’URL absolue d’un lien société (href relatif ou query de tracking).
 */
function pnNormalizeCompanyHref(href) {
  const raw = pnTrim(href);
  if (!raw) return null;
  try {
    const u = new URL(raw, 'https://www.linkedin.com');
    if (!u.hostname.toLowerCase().endsWith('linkedin.com')) return null;
    if (!/\/company\//i.test(u.pathname)) return null;
    u.hash = '';
    u.search = '';
    let path = u.pathname.replace(/\/life\/?$/i, '');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    u.pathname = path || u.pathname;
    return u.toString();
  } catch {
    return null;
  }
}

/** Slug LinkedIn depuis /company/{slug}/… */
function pnCompanySlugFromUrl(url) {
  try {
    const path = new URL(url, 'https://www.linkedin.com').pathname;
    const m = path.match(/\/company\/([^/?#]+)/i);
    if (!m) return '';
    return decodeURIComponent(m[1]).replace(/-/g, ' ').toLowerCase();
  } catch {
    return '';
  }
}

function pnNormalizeNameForMatch(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pnNameTokens(name) {
  const stop = new Set(['sa', 'sas', 'sarl', 'gmbh', 'inc', 'ltd', 'llc', 'group', 'groupe', 'the', 'and', 'de', 'la', 'le', 'les']);
  return pnNormalizeNameForMatch(name)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stop.has(t));
}

/**
 * L’URL /company/{slug} correspond-elle au nom affiché sur la carte ?
 */
function pnUrlMatchesCompanyName(url, companyName) {
  if (!pnIsValidLinkedinCompanyUrl(url) || !pnTrim(companyName)) return false;
  const slug = pnCompanySlugFromUrl(url);
  const nameNorm = pnNormalizeNameForMatch(companyName);
  const slugNorm = pnNormalizeNameForMatch(slug);
  if (!slugNorm || !nameNorm) return false;
  if (slugNorm.includes(nameNorm) || nameNorm.includes(slugNorm)) return true;
  const nameTokens = pnNameTokens(companyName);
  const slugTokens = pnNameTokens(slug);
  if (!nameTokens.length || !slugTokens.length) return false;
  const overlap = nameTokens.filter((t) =>
    slugTokens.some((st) => st === t || st.startsWith(t) || t.startsWith(st))
  );
  if (overlap.length >= 1 && nameTokens.length <= 2) return true;
  if (overlap.length >= 1 && nameTokens[0].length >= 4) {
    if (slugTokens.some((st) => st.startsWith(nameTokens[0]) || nameTokens[0].startsWith(st))) {
      return true;
    }
  }
  return overlap.length >= Math.max(1, Math.ceil(nameTokens.length * 0.5));
}

/** Premier lien /company/ dans un sous-arbre (sans validation slug). */
function findFirstCompanyUrlInRoot(root) {
  if (!root?.querySelectorAll) return null;
  for (const a of root.querySelectorAll('a[href*="/company/"]')) {
    const u = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
    if (u) return u;
  }
  return null;
}

/**
 * Panneau détail : premier lien société si l’offre correspond (repli sans validation slug).
 */
function findCompanyUrlFromJobDetailsPaneFallback(wrapper, jobUrl) {
  const detailSelectors = [
    '[componentkey*="JobDetails"]',
    '.jobs-search-two-pane__details',
    '.scaffold-layout__detail',
    '.jobs-details',
    '[class*="jobs-search__job-details"]',
    '.jobs-unified-top-card'
  ];
  for (const sel of detailSelectors) {
    try {
      for (const root of document.querySelectorAll(sel)) {
        if (!pnJobDetailsPaneMatchesJob(root, jobUrl)) continue;
        const u = findFirstCompanyUrlInRoot(root);
        if (u) return u;
      }
    } catch (_) {}
  }
  return null;
}

function pnFindCompanyElementInWrapper(wrapper) {
  if (typeof findCompanyElementInCard === 'function') {
    const el = findCompanyElementInCard(wrapper);
    if (el) return el;
  }
  if (typeof findCompanyElementInCardDock === 'function') {
    return findCompanyElementInCardDock(wrapper);
  }
  return null;
}

/** URL société depuis le même élément DOM que le nom (lien /company/ de la carte). */
function findCompanyUrlFromCompanyElement(wrapper, companyName) {
  const el = pnFindCompanyElementInWrapper(wrapper);
  if (!el) return null;
  const candidates = [];
  if (el.tagName === 'A') candidates.push(el);
  const parentA = el.closest?.('a[href*="/company/"]');
  if (parentA) candidates.push(parentA);
  el.querySelectorAll?.('a[href*="/company/"]').forEach((a) => candidates.push(a));
  for (const a of candidates) {
    const u = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
    if (u && pnUrlMatchesCompanyName(u, companyName)) return u;
  }
  return null;
}

/**
 * Liens /company/ dans un sous-arbre dont le slug correspond au nom (pas le premier lien trouvé).
 */
function findCompanyUrlInRootMatching(root, companyName) {
  if (!root?.querySelectorAll || !companyName) return null;
  let best = null;
  let bestScore = 0;
  for (const a of root.querySelectorAll('a[href*="/company/"]')) {
    const u = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
    if (!u || !pnUrlMatchesCompanyName(u, companyName)) continue;
    const textNorm = pnNormalizeNameForMatch(a.textContent);
    const nameNorm = pnNormalizeNameForMatch(companyName);
    let score = 2;
    if (textNorm && (textNorm.includes(nameNorm) || nameNorm.includes(textNorm))) score = 5;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/** URL offre courante (carte ou `currentJobId` dans la barre d’adresse). */
function pnResolveJobUrlFromWrapper(wrapper) {
  const jobInfo =
    wrapper && typeof getJobInfoFromWrapper === 'function'
      ? getJobInfoFromWrapper(wrapper)
      : { jobUrl: '' };
  let jobUrl = pnTrim(jobInfo.jobUrl);
  if (jobUrl) return jobUrl;
  try {
    const u = new URL(location.href);
    const id = u.searchParams.get('currentJobId');
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
  } catch (_) {}
  return '';
}

/** Panneau détail job ouvert (après clic liste) — source la plus fiable pour l’URL société. */
function pnGetOpenJobDetailsPanel() {
  const selectors = [
    '.jobs-search__job-details--container',
    '[class*="jobs-search__job-details"]',
    '[class*="job-details-jobs-unified-top-card"]',
    '[class*="scaffold-layout__detail"]',
    '.jobs-unified-top-card',
    '[componentkey*="JobDetails"]'
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

/**
 * Lien /company/ en tête du descriptif (ou encart entreprise en bas) — ex. DGSE → /company/dgse/life?lipi=…
 * Normalisé en https://www.linkedin.com/company/dgse (sans tracking).
 */
function findCompanyUrlFromOpenJobDetailsPanel(jobUrl) {
  const panel = pnGetOpenJobDetailsPanel();
  if (!panel) return null;
  if (jobUrl && !pnJobDetailsPaneMatchesJob(panel, jobUrl)) return null;

  const topSelectors = [
    '.job-details-jobs-unified-top-card__company-name a[href*="/company/"]',
    '[class*="job-details-jobs-unified-top-card__company-name"] a[href*="/company/"]',
    '.jobs-unified-top-card__company-name a[href*="/company/"]',
    '[class*="jobs-unified-top-card__company-name"] a[href*="/company/"]',
    '.job-details-jobs-unified-top-card__company-name',
    '[class*="job-details-jobs-unified-top-card__company-name"]',
    '.jobs-unified-top-card__company-name',
    '[class*="jobs-unified-top-card__company-name"]'
  ];
  for (const sel of topSelectors) {
    const el = panel.querySelector(sel);
    if (!el) continue;
    const anchor =
      el.tagName === 'A' ? el : el.querySelector?.('a[href*="/company/"]') || el.closest?.('a[href*="/company/"]');
    const u = pnNormalizeCompanyHref(anchor?.getAttribute?.('href') || anchor?.href || '');
    if (u) return u;
  }

  for (const a of panel.querySelectorAll(
    '[class*="job-insight"] a[href*="/company/"], [class*="company-module"] a[href*="/company/"], a[href*="/company/"]'
  )) {
    const u = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
    if (u) return u;
  }
  return null;
}

function findLogoFromOpenJobDetailsPanel(jobUrl) {
  const panel = pnGetOpenJobDetailsPanel();
  if (!panel) return { url: null, img: null };
  if (jobUrl && !pnJobDetailsPaneMatchesJob(panel, jobUrl)) return { url: null, img: null };
  return findLogoInRoot(panel);
}

function pnIsLikelyTopJobHeaderBlock(el) {
  if (!el) return false;
  if (el.matches?.('.jobs-unified-top-card, [class*="jobs-unified-top-card"], [class*="job-details-jobs-unified-top-card"]')) {
    if (el.querySelector('h1, [class*="job-title"]')) return true;
  }
  if (el.querySelector('h1[class*="job-title"], [class*="job-details-jobs-unified-top-card__job-title"]')) return true;
  return false;
}

/** Boutons d’action LinkedIn (Partager, options…) — pas la description entreprise. */
const PN_LINKEDIN_UI_NOISE =
  /\b(partager|share|voir plus d.?options|see more options|signaler|report|enregistrer|save job|copier le lien|copy link)\b/i;

function pnStripLinkedInUiChrome(text) {
  return pnTrim(
    String(text || '')
      .replace(PN_LINKEDIN_UI_NOISE, ' ')
      .replace(/\s+/g, ' ')
  );
}

function pnElementFollowsDescription(descEl, el) {
  if (!descEl || !el) return true;
  return !!(descEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function pnGetJobDescriptionElement(panel) {
  if (!panel?.querySelector) return null;
  const selectors = [
    '.jobs-description-content__text',
    '[class*="jobs-description-content__text"]',
    '[class*="jobs-box__html-content"]',
    '[class*="jobs-description-content"]',
    '.jobs-description',
    '[class*="jobs-description"]'
  ];
  for (const sel of selectors) {
    const el = panel.querySelector(sel);
    if (el && pnTrim(el.innerText).length > 80) return el;
  }
  return null;
}

function pnIsLikelyShareOrActionBar(el) {
  if (!el) return false;
  const t = pnTrim(el.innerText);
  if (!PN_LINKEDIN_UI_NOISE.test(t)) return false;
  const cleaned = pnStripLinkedInUiChrome(t);
  // Barre d’actions : nom + Partager/Voir plus, sans vraie description.
  return cleaned.length < 120 || cleaned.split(' ').length < 12;
}

function pnIsCompanyAboutSectionHeading(el) {
  const t = pnTrim(el?.textContent || '');
  return /^(à propos de l.?entreprise|about the company|about us|connaître l.?entreprise|who we are)$/i.test(t);
}

function pnFindCompanyAboutSectionRoot(panel, descEl) {
  if (!panel?.querySelectorAll) return null;
  for (const h of panel.querySelectorAll('h2, h3, h4, [class*="title"], [class*="subtitle"]')) {
    if (!pnIsCompanyAboutSectionHeading(h)) continue;
    if (!pnElementFollowsDescription(descEl, h)) continue;
    const root =
      h.closest?.(
        'section, article, [class*="jobs-company"], [class*="company-module"], [class*="artdeco-card"], [class*="core-section-container"]'
      ) || h.parentElement?.parentElement;
    if (root && !pnIsLikelyTopJobHeaderBlock(root)) return root;
  }
  return null;
}

function pnHasCompanyLogoInRoot(root) {
  if (!root?.querySelector) return false;
  for (const img of root.querySelectorAll('img')) {
    const url = resolveLogoUrlFromImg(img);
    if (url && pnIsProbableCompanyLogoCdnUrl(url)) return true;
  }
  return false;
}

function pnClimbToInsightCardFromAnchor(anchor, descEl) {
  if (!anchor) return null;
  let el = anchor;
  for (let depth = 0; depth < 10 && el; depth++) {
    if (pnIsLikelyTopJobHeaderBlock(el)) return null;
    if (descEl && !pnElementFollowsDescription(descEl, el)) return null;
    const hasLogo = pnHasCompanyLogoInRoot(el);
    const t = pnTrim(el.innerText);
    if (hasLogo && t.length >= 40 && t.length <= 4000 && !pnIsLikelyShareOrActionBar(el)) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function pnCollectCompanyInsightCardCandidates(panel, descEl) {
  const seen = new Set();
  const out = [];

  const push = (el, source) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    out.push({ el, source });
  };

  push(pnFindCompanyAboutSectionRoot(panel, descEl), 'about_heading');

  const classSelectors = [
    '[class*="jobs-company"]',
    '[class*="company-module"]',
    '[class*="org-jobs-company"]',
    '[class*="company-insights"]',
    '[class*="about-the-company"]',
    '[class*="about-us"]'
  ];
  for (const sel of classSelectors) {
    try {
      panel.querySelectorAll(sel).forEach((el) => {
        if (pnIsLikelyTopJobHeaderBlock(el)) return;
        if (descEl && !pnElementFollowsDescription(descEl, el)) return;
        push(el, sel);
      });
    } catch (_) {}
  }

  for (const anchor of panel.querySelectorAll('a[href*="/company/"]')) {
    if (pnIsLikelyTopJobHeaderBlock(anchor.closest?.('div, section, article') || anchor)) continue;
    if (descEl && !pnElementFollowsDescription(descEl, anchor)) continue;
    const card = pnClimbToInsightCardFromAnchor(anchor, descEl);
    if (card) push(card, 'anchor_climb');
  }

  return out;
}

function pnScoreCompanyInsightCard(el, descEl, source) {
  if (!el || pnIsLikelyTopJobHeaderBlock(el) || pnIsLikelyShareOrActionBar(el)) return -1;

  const raw = pnTrim(el.innerText);
  const cleaned = pnStripLinkedInUiChrome(raw);
  if (cleaned.length < 30) return -1;

  let score = Math.min(cleaned.length, 600);
  if (source === 'about_heading') score += 800;
  if (descEl && pnElementFollowsDescription(descEl, el)) score += 500;
  if (pnHasCompanyLogoInRoot(el)) score += 200;
  if (/employés|employees|salariés|collaborateurs|followers|abonnés|on LinkedIn/i.test(raw)) score += 220;
  if (el.querySelector('[class*="inline-show-more-text"], [class*="show-more-less"]')) score += 180;

  const sentences = cleaned.split(/[.!?…]\s+/).filter((s) => s.length > 20);
  if (sentences.length >= 1) score += 80 + Math.min(sentences.length, 4) * 30;

  if (PN_LINKEDIN_UI_NOISE.test(raw)) score -= 350;
  if (cleaned.length < 80) score -= 120;
  if (el.querySelector('button[aria-label*="Partager"], button[aria-label*="Share"]')) score -= 200;

  return score;
}

function pnExtractEmployeesHintFromText(text) {
  const raw = pnTrim(text);
  const patterns = [
    /([\d][\d\s.,]*\s*[-–]\s*[\d][\d\s.,]*)\s*(employés|employees|salariés|collaborateurs)/i,
    /([\d][\d\s.,+kK]+)\s*(employés|employees|salariés|collaborateurs)/i,
    /([\d][\d\s.,]*\s*[-–]\s*[\d][\d\s.,]*)\s*(followers|abonnés)/i
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return pnTrim(m[0]);
  }
  return null;
}

function pnExtractAboutFromInsightCard(card, insightName, employeesHint) {
  if (!card?.querySelectorAll) return null;

  const skip = new Set();
  if (insightName) skip.add(pnTrim(insightName).toLowerCase());

  const textSelectors = [
    '[class*="inline-show-more-text"]',
    '[class*="show-more-less-html"]',
    '[class*="company-description"]',
    '[class*="about-us"]',
    '[class*="jobs-company"] p',
    'p'
  ];

  for (const sel of textSelectors) {
    for (const el of card.querySelectorAll(sel)) {
      if (el.closest?.('button, [role="button"]')) continue;
      let t = pnStripLinkedInUiChrome(el.innerText);
      if (t.length < 25) continue;
      if (skip.has(t.toLowerCase())) continue;
      if (employeesHint && t.includes(employeesHint)) continue;
      if (/^à propos de l.?entreprise$/i.test(t)) continue;
      if (PN_LINKEDIN_UI_NOISE.test(t) && t.length < 100) continue;
      if (t.split(' ').length >= 5) return t.slice(0, 900);
    }
  }

  let about = pnStripLinkedInUiChrome(card.innerText);
  if (insightName) about = about.replace(insightName, ' ').trim();
  if (employeesHint) about = about.replace(employeesHint, ' ').trim();
  about = about.replace(/^(à propos de l.?entreprise|about the company)[:\s]*/i, '').trim();
  if (about.length >= 25 && !pnIsLikelyShareOrActionBar(card)) return about.slice(0, 900);
  return null;
}

/**
 * Encart « À propos de l'entreprise » en bas du descriptif (logo, nom, effectifs, ~2 lignes de description).
 * Source prioritaire pour le matching financier Gemini.
 */
function extractJobDetailsCompanyInsightCard(jobUrl) {
  const panel = pnGetOpenJobDetailsPanel();
  if (!panel) return null;
  if (jobUrl && !pnJobDetailsPaneMatchesJob(panel, jobUrl)) return null;

  const descEl = pnGetJobDescriptionElement(panel);
  const candidates = pnCollectCompanyInsightCardCandidates(panel, descEl);

  let best = null;
  let bestScore = 0;
  let bestSource = '';
  for (const { el, source } of candidates) {
    const score = pnScoreCompanyInsightCard(el, descEl, source);
    if (score > bestScore) {
      bestScore = score;
      best = el;
      bestSource = source;
    }
  }
  if (!best || bestScore < 80) return null;

  const companyAnchor =
    best.querySelector('a[href*="/company/"]') || best.closest?.('a[href*="/company/"]');
  const companyLinkedinUrl = pnNormalizeCompanyHref(
    companyAnchor?.getAttribute?.('href') || companyAnchor?.href || ''
  );

  let insightName = pnTrim(companyAnchor?.textContent || '');
  if (!insightName || insightName.length < 2) {
    const h = best.querySelector(
      'h2, h3, h4, [class*="company-name"], [class*="entity-lockup__title"]'
    );
    insightName = pnTrim(h?.textContent || '');
  }
  insightName = pnStripLinkedInUiChrome(insightName);

  let logoUrl = null;
  let logoAlt = null;
  const logoHit = findLogoInRoot(best);
  if (logoHit.url) {
    logoUrl = logoHit.url;
    logoAlt = pnTrim(logoHit.img?.alt || '');
  }

  const fullText = pnTrim(best.innerText);
  const employeesHint = pnExtractEmployeesHintFromText(fullText);
  const aboutSnippet = pnExtractAboutFromInsightCard(best, insightName, employeesHint);

  if (!aboutSnippet && !employeesHint && !companyLinkedinUrl) return null;

  return {
    companyLinkedinUrl: companyLinkedinUrl || null,
    companyName: insightName || null,
    logoUrl: logoUrl || null,
    logoAlt: logoAlt || null,
    employeesHint: employeesHint || null,
    aboutSnippet: aboutSnippet || null,
    insightSource: bestSource || null,
    rawText: pnStripLinkedInUiChrome(fullText).slice(0, 1200)
  };
}

/** Le panneau détail affiche-t-il la même offre (currentJobId) ? */
function pnJobDetailsPaneMatchesJob(root, jobUrl) {
  const jobId =
    typeof getJobIdFromUrl === 'function' ? getJobIdFromUrl(jobUrl) : null;
  if (!jobId || !root?.querySelectorAll) return true;
  for (const a of root.querySelectorAll('a[href*="/jobs/"]')) {
    const id = getJobIdFromUrl(a.getAttribute('href') || a.href);
    if (id && id === jobId) return true;
  }
  return false;
}

/**
 * Panneau détail uniquement si l’offre correspond — jamais de scan « moitié droite de l’écran ».
 */
function findCompanyUrlFromJobDetailsPane(wrapper, companyName, jobUrl) {
  const detailSelectors = [
    '[componentkey*="JobDetails"]',
    '.jobs-search-two-pane__details',
    '.scaffold-layout__detail',
    '.jobs-details',
    '[class*="jobs-search__job-details"]',
    '.jobs-unified-top-card'
  ];
  for (const sel of detailSelectors) {
    try {
      for (const root of document.querySelectorAll(sel)) {
        if (!pnJobDetailsPaneMatchesJob(root, jobUrl)) continue;
        const u = findCompanyUrlInRootMatching(root, companyName);
        if (u) return u;
      }
    } catch (_) {}
  }
  return null;
}

/** @deprecated — ne plus utiliser sans validation nom/slug */
function findCompanyUrlInRoot(root) {
  return findCompanyUrlInRootMatching(root, '');
}

/** Rejette GIF 1×1 / fantômes LinkedIn (pas le vrai logo entreprise). */
function pnIsGhostOrSpacerImgUrl(u) {
  const s = pnTrim(u).toLowerCase();
  if (!s) return true;
  if (s.includes('ghost') && s.includes('licdn')) return true;
  if (/pixel\.gif|spacer|blank\.(gif|png)/i.test(s)) return true;
  return false;
}

/**
 * URL affichée / lazy-load : souvent data-delayed-url avant que src soit le CDN réel.
 * Ex. media.licdn.com/.../company-logo_100_100/.../illicado_logo
 */
function resolveLogoUrlFromImg(img) {
  if (!img || img.nodeName !== 'IMG') return null;
  const attrs = [
    img.getAttribute('data-delayed-url'),
    img.getAttribute('data-delayed-url-shimmer'),
    img.getAttribute('data-src'),
    img.getAttribute('src'),
    typeof img.src === 'string' ? img.src : ''
  ];
  for (const c of attrs) {
    const u = pnTrim(c);
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (pnIsGhostOrSpacerImgUrl(u)) continue;
    return u;
  }
  const srcset = img.getAttribute('srcset');
  if (srcset) {
    const first = srcset
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .find((x) => x && /^https?:\/\//i.test(x));
    if (first && !pnIsGhostOrSpacerImgUrl(first)) return first;
  }
  return null;
}

function pnIsProbableCompanyLogoCdnUrl(u) {
  const s = pnTrim(u);
  if (!/^https?:\/\//i.test(s)) return false;
  if (/media\.licdn\.com/i.test(s) && /(dms\/image|company-logo)/i.test(s)) return true;
  return false;
}

/**
 * @returns {{ url: string|null, img: HTMLImageElement|null }}
 */
function findLogoInRoot(root) {
  if (!root?.querySelectorAll) return { url: null, img: null };
  const selectors = [
    'a[href*="/company/"] img',
    'img[data-delayed-url*="media.licdn.com"]',
    'img[src*="media.licdn.com"]',
    'img[class*="EntityPhoto"]',
    'img[alt*="Logo"]',
    'img[alt*="logo"]',
    '[class*="entity-lockup"] img',
    '[class*="EntityLockup"] img',
    '[class*="jobs-company"] img'
  ];
  const seen = new Set();
  for (const sel of selectors) {
    try {
      for (const img of root.querySelectorAll(sel)) {
        if (seen.has(img)) continue;
        seen.add(img);
        const url = resolveLogoUrlFromImg(img);
        if (url && pnIsProbableCompanyLogoCdnUrl(url)) return { url, img };
      }
    } catch (_) {}
  }
  for (const img of root.querySelectorAll('img')) {
    if (seen.has(img)) continue;
    const url = resolveLogoUrlFromImg(img);
    if (url && pnIsProbableCompanyLogoCdnUrl(url)) return { url, img };
  }
  return { url: null, img: null };
}

/**
 * Logo depuis l’ancre société de la carte (même source que le nom).
 */
function findLogoFromCompanyElement(wrapper) {
  const el = pnFindCompanyElementInWrapper(wrapper);
  if (!el) return { url: null, img: null };
  const anchor = el.tagName === 'A' ? el : el.closest?.('a[href*="/company/"]');
  if (anchor) {
    const hit = findLogoInRoot(anchor);
    if (hit.url) return hit;
  }
  return findLogoInRoot(el);
}

/**
 * Panneau détail : uniquement si l’offre correspond (pas de scan écran droit).
 */
function findLogoFromJobDetailsPane(wrapper, companyName, jobUrl) {
  const detailSelectors = [
    '[componentkey*="JobDetails"]',
    '.jobs-search-two-pane__details',
    '.scaffold-layout__detail',
    '.jobs-details',
    '[class*="jobs-search__job-details"]',
    '.jobs-unified-top-card'
  ];
  for (const sel of detailSelectors) {
    try {
      for (const root of document.querySelectorAll(sel)) {
        if (!pnJobDetailsPaneMatchesJob(root, jobUrl)) continue;
        const companyUrl = findCompanyUrlInRootMatching(root, companyName);
        if (!companyUrl) continue;
        for (const a of root.querySelectorAll('a[href*="/company/"]')) {
          const u = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
          if (u !== companyUrl) continue;
          const hit = findLogoInRoot(a);
          if (hit.url) return hit;
        }
      }
    } catch (_) {}
  }
  return { url: null, img: null };
}

/** Heuristique lieu / métadonnées sur la carte. */
function extractJobLocationHint(wrapper) {
  if (!wrapper?.querySelector) return '';
  const candidates = [
    ...wrapper.querySelectorAll(
      '[class*="job-card-container__metadata"], [class*="job-card-list__metadata"], [class*="entity-lockup__subtitle"] span, [class*="artdeco-entity-lockup__caption"]'
    ),
    ...wrapper.querySelectorAll('.job-card-container__footer-item, li.job-card-container__metadata-item')
  ];
  for (const el of candidates) {
    const t = pnTrim(el.textContent);
    if (t.length >= 3 && t.length < 120 && /,|\(|\)|région|France|Paris|Lyon|remote|télé/i.test(t)) {
      return t.slice(0, 200);
    }
  }
  return '';
}

/**
 * @returns {{ context: object, missing: string[] }}
 */
function buildCompanyMatchContextSync(wrapper, companyName) {
  const name = pnTrim(companyName);
  const jobUrl = pnResolveJobUrlFromWrapper(wrapper);
  const jobInfo =
    wrapper && typeof getJobInfoFromWrapper === 'function'
      ? getJobInfoFromWrapper(wrapper)
      : { jobTitle: '', jobUrl: '' };

  // 1) Encart entreprise en bas du descriptif (logo, nom, effectifs, description) — priorité matching financier.
  const insight = extractJobDetailsCompanyInsightCard(jobUrl);

  let companyLinkedinUrl = insight?.companyLinkedinUrl || null;
  let linkedinUrlValidated =
    !!companyLinkedinUrl && pnUrlMatchesCompanyName(companyLinkedinUrl, name);
  let urlSource = linkedinUrlValidated ? 'insight_card' : '';
  if (companyLinkedinUrl && !linkedinUrlValidated) {
    companyLinkedinUrl = null;
  }

  // 2) Lien en-tête du panneau détail si l’encart n’a pas d’URL (slug validé).
  if (!companyLinkedinUrl) {
    const detailUrl = findCompanyUrlFromOpenJobDetailsPanel(jobUrl);
    if (detailUrl && pnUrlMatchesCompanyName(detailUrl, name)) {
      companyLinkedinUrl = detailUrl;
      linkedinUrlValidated = true;
      urlSource = 'detail_open';
    }
  }

  if (!companyLinkedinUrl) {
    companyLinkedinUrl =
      findCompanyUrlFromCompanyElement(wrapper, name) ||
      findCompanyUrlInRootMatching(wrapper, name) ||
      null;
    if (!companyLinkedinUrl) {
      companyLinkedinUrl = findCompanyUrlFromJobDetailsPane(wrapper, name, jobUrl);
    }
    linkedinUrlValidated = !!companyLinkedinUrl && pnUrlMatchesCompanyName(companyLinkedinUrl, name);
    if (companyLinkedinUrl) urlSource = linkedinUrlValidated ? 'list_validated' : 'list_unvalidated';
  }

  let companyLinkedinUrlCandidate = companyLinkedinUrl;
  if (!companyLinkedinUrlCandidate) {
    companyLinkedinUrlCandidate =
      findFirstCompanyUrlInRoot(wrapper) ||
      findCompanyUrlFromJobDetailsPaneFallback(wrapper, jobUrl);
  }

  let logoHit = insight?.logoUrl ? { url: insight.logoUrl, img: null } : { url: null, img: null };
  if (!logoHit.url) {
    logoHit = findLogoFromOpenJobDetailsPanel(jobUrl);
  }
  if (!logoHit.url) {
    logoHit = findLogoFromCompanyElement(wrapper);
  }
  if (!logoHit.url) {
    logoHit = findLogoInRoot(wrapper);
  }
  if (!logoHit.url) {
    logoHit = findLogoFromJobDetailsPane(wrapper, name, jobUrl);
  }

  const ctx = {
    matchContextVersion: MATCH_CONTEXT_VERSION,
    companyName: name,
    logoUrl: logoHit.url ? String(logoHit.url).trim() : null,
    logoAlt: insight?.logoAlt
      ? String(insight.logoAlt).trim()
      : logoHit.img?.alt
        ? String(logoHit.img.alt).trim()
        : name
          ? `Logo de ${name}`
          : null,
    companyInsightName: insight?.companyName || null,
    companyInsightAbout: insight?.aboutSnippet || null,
    companyInsightEmployees: insight?.employeesHint || null,
    companyInsightSource: insight?.insightSource || (insight ? 'detail_bottom_card' : null),
    companyLinkedinUrl: linkedinUrlValidated ? companyLinkedinUrl : null,
    companyLinkedinUrlCandidate: companyLinkedinUrlCandidate || null,
    companyLinkedinSlug: companyLinkedinUrl ? pnCompanySlugFromUrl(companyLinkedinUrl) : null,
    linkedinUrlValidated,
    companyUrlSource: urlSource || null,
    jobUrl,
    jobLocation: extractJobLocationHint(wrapper) || null,
    logoInlineData: null,
    logoInlineSkipped: false
  };

  const missing = [];
  if (!ctx.logoUrl || !/^https?:\/\//i.test(ctx.logoUrl)) missing.push('logoUrl');
  if (!ctx.companyName || ctx.companyName.length < 2) missing.push('companyName');

  return { context: ctx, missing };
}

/**
 * @returns {Promise<{ mimeType: string, dataBase64: string } | null>}
 */
async function fetchLogoInlineDataFromUrl(logoUrl) {
  const u = pnTrim(logoUrl);
  if (!u || !/^https?:\/\//i.test(u)) return null;
  for (let attempt = 0; attempt < LOGO_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(u, { credentials: 'omit', mode: 'cors', cache: 'force-cache' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob || blob.size < 32 || blob.size > LOGO_MAX_BYTES) continue;
      const mimeType = blob.type && /^image\//i.test(blob.type) ? blob.type : 'image/jpeg';
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result);
        r.onerror = () => reject(new Error('read'));
        r.readAsDataURL(blob);
      });
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl));
      if (!m) continue;
      return { mimeType: m[1].split(';')[0], dataBase64: m[2] };
    } catch (_) {
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * @returns {Promise<object>}
 */
async function enrichCompanyMatchContextWithLogo(ctx) {
  const next = { ...ctx };
  if (!next.logoUrl) {
    next.logoInlineSkipped = true;
    return next;
  }
  const inline = await fetchLogoInlineDataFromUrl(next.logoUrl);
  if (inline) {
    next.logoInlineData = { mimeType: inline.mimeType, dataBase64: inline.dataBase64 };
  } else {
    next.logoInlineSkipped = true;
  }
  return next;
}

/**
 * @returns {Promise<{ ok: boolean, context: object, missing: string[], attempts: number }>}
 */
async function ensureCompanyMatchContext(wrapper, companyName) {
  let attempts = 0;
  let lastMissing = [];

  while (attempts < MATCH_ENSURE_MAX_ATTEMPTS) {
    attempts++;
    const { context: base, missing } = buildCompanyMatchContextSync(wrapper, companyName);
    lastMissing = missing;

    if (missing.length === 0) {
      const enriched = await enrichCompanyMatchContextWithLogo(base);
      return { ok: true, context: enriched, missing: [], attempts };
    }

    await new Promise((r) => setTimeout(r, MATCH_RETRY_DELAY_MS));
  }

  const { context: finalCtx } = buildCompanyMatchContextSync(wrapper, companyName);
  const enriched = await enrichCompanyMatchContextWithLogo(finalCtx);
  return { ok: false, context: enriched, missing: lastMissing, attempts };
}

/** @deprecated Utiliser ensureCompanyMatchContext — conservé pour compat. */
function buildCompanyContextForWrapper(wrapper, companyName) {
  return buildCompanyMatchContextSync(wrapper, companyName).context;
}
