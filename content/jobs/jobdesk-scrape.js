/**
 * Lecture panneau Jobdesk (droite) + envoi saveJobOffer au background.
 * Reprise logique « repoll » jusqu’à description exploitable ou délai max.
 */

const JOB_SCRAPE_AFTER_OPEN_FIRST_DELAY_MS = 700;
const JOB_SCRAPE_AFTER_OPEN_STEP_MS = 420;
const JOB_SCRAPE_AFTER_OPEN_MAX_MS = 22000;
/** Si description OK mais pas d’encart « Infos sur l’entreprise », sauver sans attendre le max. */
const JOB_SCRAPE_SOFT_NO_INSIGHT_MS = 7000;
/** Sans description Jobdesk après ce délai → abandonner et passer à l’offre suivante. */
const JOB_SCRAPE_NO_DESC_GIVE_UP_MS = 11000;
const JOB_SCRAPE_MIN_DESCRIPTION_LEN = 80;
/** Si un « Voir plus » est encore visible, exiger au moins cette longueur avant d’accepter. */
const JOB_SCRAPE_FULL_DESCRIPTION_TARGET = 900;
const JOB_SCRAPE_INSIGHT_MIN_ABOUT_LEN = 80;
/** Deux polls stables consécutifs avec le même encart entreprise (évite texte partiel). */
const JOB_SCRAPE_INSIGHT_STABLE_POLLS = 2;

/** Libellé d’expansion de description (pas « Plus d’options » / aide / intérêt entreprise). */
function jdIsDescExpandLabel(raw) {
  const t = pnNormalizeText(raw || '').toLowerCase();
  if (!t || t.length > 56) return false;
  if (
    /plus d['’]options|more options|voir le profil|see profile|show less|voir moins|afficher moins|en savoir plus|learn more|interested|ça m['’]intéresse|je suis intéress|signal(er)? (mon )?intérêt|help|aide linkedin/i.test(
      t
    )
  ) {
    return false;
  }
  return /voir plus|show more|see more|afficher plus|afficher la suite|lire la suite|voir la suite|see full|show full|read more|\+\s*de|…\s*plus|\.\.\.\s*plus|^plus$/i.test(
    t
  );
}

/** Bouton d’expansion sûr : jamais un lien navigable (help / company / life…). */
function jdIsSafeDescExpandControl(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.closest?.('.lph-financial-dock')) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'A') return false;
  if (el.getAttribute?.('role') === 'link') return false;
  const href = el.getAttribute?.('href') || el.closest?.('a')?.getAttribute?.('href') || '';
  if (href) {
    const h = String(href).toLowerCase();
    if (
      h.startsWith('http') ||
      h.includes('/help/') ||
      h.includes('/company/') ||
      h.includes('/life') ||
      h.includes('interested') ||
      h.includes('/preload')
    ) {
      return false;
    }
  }
  const label = pnNormalizeText(
    el.getAttribute?.('aria-label') || el.innerText || el.textContent || ''
  );
  if (!jdIsDescExpandLabel(label)) return false;
  return true;
}

function jdPanelHasDescriptionExpandControl(panel) {
  if (!panel) return false;
  try {
    const nodes = panel.querySelectorAll('button, [role="button"]');
    for (const btn of nodes) {
      if (!jdIsSafeDescExpandControl(btn)) continue;
      // Priorité : contrôle dans / près de la zone description
      if (
        btn.closest?.(
          '[class*="description"], [class*="jobs-box"], [class*="job-details"], #job-details, [class*="about-job"], [id*="AboutTheJob"], [id^="JobDetails_AboutTheJob"]'
        )
      ) {
        return true;
      }
      const label = btn.getAttribute?.('aria-label') || btn.innerText || btn.textContent || '';
      // Fallback : libellé clairement « voir plus » même hors classe connue
      if (/voir plus|show more|see more|afficher plus|lire la suite|afficher la suite/i.test(label)) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

const JOB_DETAIL_PANEL_SELECTORS = [
  '.jobs-search__job-details--container',
  '[class*="jobs-search__job-details--container"]',
  '[class*="jobs-search__job-details"]',
  '[class*="job-details-jobs-unified-top-card"]',
  '[class*="scaffold-layout__detail"]',
  '.scaffold-layout__detail',
  '#job-details',
  '[id*="job-details"]',
  // Premium / search-results (classes hashées) : ids stables JobDetails_*
  '[id^="JobDetails_"]',
  '[id*="JobDetails_AboutTheJob"]',
  '[id*="AboutTheJob"]'
];

const JOB_DESCRIPTION_SELECTORS = [
  '.jobs-description-content__text',
  '.jobs-box__html-content',
  '.jobs-description__content',
  '.jobs-box--fadeable',
  '#job-details',
  '[id*="job-details"]',
  '[id*="JobDetails_AboutTheJob"]',
  '[id^="JobDetails_AboutTheJob"]',
  'article.jobs-description__container',
  '[class*="jobs-description-content__text"]',
  '[class*="jobs-box__html-content"]',
  '[class*="jobs-description__content"]',
  '[class*="jobs-description"]'
];

const JOB_METADATA_ITEM_SELECTORS = [
  '.job-details-jobs-unified-top-card__job-insight',
  '[class*="job-details-jobs-unified-top-card__job-insight"]',
  '.jobs-unified-top-card__job-insight',
  '[class*="jobs-unified-top-card__job-insight"]'
];

/** Ligne sous le titre (souvent « lieu · modalité » ou « entreprise · lieu ») — plus fiable que le 1er pill. */
const JOB_DETAIL_LOCATION_LINE_SELECTORS = [
  '.job-details-jobs-unified-top-card__primary-description-without-tagline',
  '[class*="job-details-jobs-unified-top-card__primary-description-without-tagline"]',
  '.jobs-unified-top-card__primary-description-without-tagline',
  '[class*="jobs-unified-top-card__primary-description-without-tagline"]',
  '.job-details-jobs-unified-top-card__primary-description-with-tagline',
  '[class*="job-details-jobs-unified-top-card__primary-description-with-tagline"]',
  '.jobs-unified-top-card__primary-description-with-tagline',
  '[class*="jobs-unified-top-card__primary-description-with-tagline"]',
  '.job-details-jobs-unified-top-card__tertiary-description',
  '[class*="job-details-jobs-unified-top-card__tertiary-description"]',
  '.jobs-unified-top-card__tertiary-description',
  '[class*="jobs-unified-top-card__tertiary-description"]'
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

/** Aligné sur `jobdesk-autoopen.js` (liste sans params volatils de clic). */
function jdListPageKeyForLog() {
  try {
    if (typeof jdListPageKey === 'function') return jdListPageKey();
    const u = new URL(location.href);
    const sp = new URLSearchParams(u.search);
    sp.delete('currentJobId');
    sp.delete('eBP');
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
  const vw = window.innerWidth || 1200;
  // Dock financier à gauche : la colonne détail commence plus à droite (~0.5 vw).
  const dockActive = document.documentElement.classList.contains('lph-financial-dock-active');
  const leftFloor = dockActive ? vw * 0.35 : vw * 0.28;

  function scorePanel(el) {
    if (!el || !(el instanceof Element)) return -1;
    if (el.closest?.('.lph-financial-dock')) return -1;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return -1;
    }
    // Hors viewport vertical OK (contenu scrollable) — largeur minimale requise.
    if (!r || r.width < 160) return -1;
    const visibleH = Math.min(r.bottom, window.innerHeight || 800) - Math.max(r.top, 0);
    const effH = Math.max(r.height, visibleH, 1);
    if (effH < 80 && r.height < 120) return -1;
    // Colonne droite / détail (search-results two-pane)
    const inRight = r.left >= leftFloor || r.right > vw * 0.55;
    if (!inRight && r.left < vw * 0.22) return -1;
    let score = r.width * Math.max(effH, 120);
    const html = String(el.className || '') + (el.id || '');
    if (/job-details|jobs-description|scaffold-layout__detail|JobDetails|AboutTheJob/i.test(html)) {
      score *= 1.5;
    }
    try {
      if (
        el.querySelector?.(
          '[class*="jobs-description"], [class*="job-details"], [id*="AboutTheJob"], [id^="JobDetails_"], h1, h2'
        )
      ) {
        score *= 1.3;
      }
      const t = String(el.innerText || '');
      if (/à propos de l.?offre|about the job|about this job/i.test(t)) score *= 1.6;
      if (/\/jobs\/view\//i.test(el.innerHTML || '')) score *= 1.2;
    } catch (_) {}
    return score;
  }

  /** Remonte vers un conteneur détail scrollable / substantiel. */
  function expandToDetailContainer(el) {
    if (!el) return null;
    let cur = el;
    let best = el;
    for (let i = 0; i < 10 && cur && cur !== document.body; i++) {
      try {
        const r = cur.getBoundingClientRect();
        const textLen = String(cur.innerText || '').trim().length;
        if (r.width >= 280 && textLen >= 200 && r.left >= leftFloor * 0.85) {
          best = cur;
          const style = window.getComputedStyle(cur);
          const oy = String(style?.overflowY || '');
          if (
            (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
            cur.scrollHeight - cur.clientHeight > 40
          ) {
            return cur;
          }
        }
      } catch (_) {}
      cur = cur.parentElement;
    }
    return best;
  }

  let best = null;
  let bestScore = 0;

  const consider = (el) => {
    const panel = expandToDetailContainer(el) || el;
    const s = scorePanel(panel);
    if (s > bestScore) {
      best = panel;
      bestScore = s;
    }
  };

  for (const selector of JOB_DETAIL_PANEL_SELECTORS) {
    try {
      const panel = document.querySelector(selector);
      if (panel) consider(panel);
    } catch (_) {}
  }
  if (typeof querySelectorAllDeep === 'function') {
    for (const selector of [
      ...JOB_DETAIL_PANEL_SELECTORS,
      '[class*="jobs-details"]',
      '[class*="JobDetails"]',
      'div[componentkey*="JobDetails"]',
      '[id*="JobDetails"]'
    ]) {
      try {
        for (const panel of querySelectorAllDeep(document, selector)) {
          consider(panel);
        }
      } catch (_) {}
    }
  }

  // Layout Premium search-results : pas de classes classiques — ancre sur le titre « À propos ».
  if (bestScore < 50000) {
    try {
      const heads = document.querySelectorAll('h1, h2, h3');
      for (const h of heads) {
        const label = pnNormalizeText(h.innerText || h.textContent || '');
        if (!/à propos de l.?offre|about the job|about this job/i.test(label)) continue;
        consider(h);
        break;
      }
    } catch (_) {}
  }

  // Colonne droite scrollable qui porte le job courant.
  if (bestScore < 50000) {
    try {
      const jid = new URL(location.href).searchParams.get('currentJobId') || '';
      const nodes = document.querySelectorAll('div, section, aside, main');
      for (const el of nodes) {
        if (el.closest?.('.lph-financial-dock')) continue;
        let r;
        try {
          r = el.getBoundingClientRect();
        } catch (_) {
          continue;
        }
        if (!r || r.width < 280 || r.left < leftFloor * 0.9) continue;
        const style = window.getComputedStyle(el);
        const oy = String(style?.overflowY || '');
        if (!(oy === 'auto' || oy === 'scroll' || oy === 'overlay')) continue;
        if (el.scrollHeight - el.clientHeight < 40) continue;
        const text = String(el.innerText || '');
        if (text.length < 200) continue;
        if (jid && !text.includes(jid) && !(el.innerHTML || '').includes(jid)) {
          if (!/à propos de l.?offre|about the job/i.test(text)) continue;
        }
        consider(el);
      }
    } catch (_) {}
  }

  return best;
}

/** Sections du panneau à ignorer pour l’heuristique de secours (jamais la description). */
const JD_DESC_FALLBACK_EXCLUDE_RE =
  /similar-jobs|people-also-viewed|jobs-similar|company-insight|jobs-company|premium-upsell|jobs-poster|salary|top-card|unified-top-card|jobs-premium|how-you-match|skill-match|jobs-relevance|people-you-may-know/i;

let __jdDescFallbackCache = { at: 0, panel: null, result: null };

/**
 * Heuristique générique (indépendante des classes CSS LinkedIn, qui changent souvent) :
 * cherche, dans le panneau, le plus petit conteneur texte substantiel qui n’est pas
 * une section connue (top card, encart entreprise, offres similaires…).
 * Résultat mis en cache court (LinkedIn re-render fréquent + coût `innerText`).
 */
function jdFindDescriptionFallbackHeuristic(panel) {
  if (!panel) return { el: null, text: '' };
  const now = Date.now();
  if (__jdDescFallbackCache.panel === panel && now - __jdDescFallbackCache.at < 900) {
    return __jdDescFallbackCache.result;
  }
  let result = { el: null, text: '' };
  try {
    const nodes = panel.querySelectorAll('div, section, article');
    let bestLen = Infinity;
    for (const el of nodes) {
      const cls = String(el.className || '') + ' ' + (el.id || '');
      if (JD_DESC_FALLBACK_EXCLUDE_RE.test(cls)) continue;
      const text = pnNormalizeText(el.innerText || el.textContent || '');
      if (text.length < JOB_SCRAPE_MIN_DESCRIPTION_LEN) continue;
      // Préférer le conteneur le plus spécifique : si un enfant porte quasi tout le texte,
      // on le gardera à une itération suivante (plus petit `text.length`).
      let childMax = 0;
      for (const child of el.children) {
        const ct = pnNormalizeText(child.innerText || child.textContent || '');
        if (ct.length > childMax) childMax = ct.length;
      }
      if (childMax >= JOB_SCRAPE_MIN_DESCRIPTION_LEN && childMax > text.length * 0.9) continue;
      if (text.length < bestLen) {
        bestLen = text.length;
        result = { el, text };
      }
    }
  } catch (_) {}
  __jdDescFallbackCache = { at: now, panel, result };
  return result;
}

function jdFindDescriptionInPanel(panel) {
  if (!panel) return { el: null, text: '' };
  const search = (sel) => {
    try {
      if (typeof querySelectorAllDeep === 'function') return querySelectorAllDeep(panel, sel);
      return Array.from(panel.querySelectorAll(sel));
    } catch (_) {
      return [];
    }
  };
  let best = { el: null, text: '' };
  for (const selector of JOB_DESCRIPTION_SELECTORS) {
    for (const el of search(selector)) {
      const text = pnNormalizeText(el?.innerText || el?.textContent || '');
      if (text.length > best.text.length) best = { el, text };
      if (text.length >= JOB_SCRAPE_MIN_DESCRIPTION_LEN) return { el, text };
    }
  }
  // Premium search-results : bloc ancré par le H2 « À propos de l’offre ».
  if (best.text.length < JOB_SCRAPE_MIN_DESCRIPTION_LEN) {
    try {
      const heads = panel.querySelectorAll?.('h1, h2, h3') || [];
      for (const h of heads) {
        const label = pnNormalizeText(h.innerText || h.textContent || '');
        if (!/à propos de l.?offre|about the job|about this job/i.test(label)) continue;
        let block = h.parentElement;
        for (let i = 0; i < 5 && block && block !== panel; i++) {
          const text = pnNormalizeText(block.innerText || block.textContent || '');
          if (text.length >= JOB_SCRAPE_MIN_DESCRIPTION_LEN && text.length > best.text.length) {
            best = { el: block, text };
          }
          if (text.length >= 400) break;
          block = block.parentElement;
        }
        // Contenu frère / suivant du titre
        let sib = h.nextElementSibling;
        for (let i = 0; i < 4 && sib; i++) {
          const text = pnNormalizeText(sib.innerText || sib.textContent || '');
          if (text.length >= JOB_SCRAPE_MIN_DESCRIPTION_LEN && text.length > best.text.length) {
            best = { el: sib, text };
          }
          sib = sib.nextElementSibling;
        }
        break;
      }
    } catch (_) {}
  }

  // Sélecteurs spécifiques obsolètes (LinkedIn renomme régulièrement ses classes) → heuristique générique.
  if (best.text.length < JOB_SCRAPE_MIN_DESCRIPTION_LEN) {
    const fallback = jdFindDescriptionFallbackHeuristic(panel);
    if (fallback.text.length > best.text.length) return fallback;
  }
  return best;
}

/**
 * « Voir plus » description — léger uniquement (pas de parcours deep `*`, pas de scroll forcé).
 * Les clics agressifs / scrollIntoView bloquaient le chargement LinkedIn.
 * @returns {number} nombre de boutons cliqués
 */
function jdRevealJobDescription() {
  const panel = getJobDetailsPanel();
  if (!panel) return 0;
  let n = 0;
  try {
    // Jamais de <a href> : LinkedIn met « See more » / « En savoir plus » vers /help/ et /company/life.
    const buttons = Array.from(panel.querySelectorAll('button, [role="button"]'));
    const ranked = buttons
      .map((btn) => {
        if (!jdIsSafeDescExpandControl(btn)) return null;
        const label = btn.getAttribute?.('aria-label') || btn.innerText || btn.textContent || '';
        const inDesc = !!btn.closest?.(
          '[class*="description"], [class*="jobs-box"], [class*="job-details"], #job-details, [class*="about-job"], [id*="AboutTheJob"], [id^="JobDetails_AboutTheJob"]'
        );
        // Hors zone description : ne cliquer que si libellé très explicite (évite aide « I’m interested »).
        if (
          !inDesc &&
          !/voir plus|afficher la suite|lire la suite|see more about (the )?job|show more$/i.test(label)
        ) {
          return null;
        }
        return { btn, inDesc, label };
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.inDesc) - Number(a.inDesc));
    for (const item of ranked) {
      if (n >= 2) break;
      try {
        item.btn.click();
        n += 1;
      } catch (_) {}
    }
  } catch (_) {}
  return n;
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

/** Statuts / dates / badges LinkedIn — pas un lieu (FR + EN). */
function jdIsJobMetadataNoise(s) {
  const t = pnNormalizeText(s);
  if (!t || t.length > 220) return true;
  if (t.length < 2) return true;
  const low = t.toLowerCase();
  if (
    /^(consulté|enregistré|sponsorisé|promu|promue|republié|republiée|nouveau|nouvelle|archivé|archivée)$/i.test(
      t
    )
  )
    return true;
  if (/^(viewed|saved|sponsored|promoted|reposted|new|archived)$/i.test(t)) return true;
  if (/promu\(e\)|promu\s*\(e\)/i.test(t)) return true;
  if (/candidature\s+simplifiée|easy\s+apply/i.test(low)) return true;
  if (/il y a\s+\d+/i.test(t)) return true;
  if (/\b\d+\s*(jour|jours|heure|heures|semaine|semaines|mois|an|ans)\b/i.test(t)) return true;
  if (/\b\d+\s*(day|days|hour|hours|week|weeks|month|months|year|years)\s+ago\b/i.test(low)) return true;
  if (/\bactive\s+today\b/i.test(low)) return true;
  if (/publiée?\s+le|posted\s+on|posted\s+about/i.test(low)) return true;
  if (/^[\d\s,+–\-–]+(k|m|€|\$|£|%|\/yr|\/an|par\s+an)?$/i.test(t) && t.length < 35) return true;
  if (/\d+\s*[-–]\s*\d+\s*(employés|employees)/i.test(t)) return true;
  if (/^\d+\s*applications?$/i.test(t)) return true;
  if (/^voir\s+les\s+candidats/i.test(low)) return true;
  return false;
}

/** Indice géographique (ville, région, pays, remote, fuseau). */
function jdLooksLikeGeographicLocation(s) {
  const t = pnNormalizeText(s);
  if (!t || t.length < 2 || t.length > 200) return false;
  if (jdIsJobMetadataNoise(t)) return false;
  if (/[·|]/.test(t)) {
    const parts = t.split(/[·|]/).map((p) => pnNormalizeText(p)).filter(Boolean);
    return parts.some((p) => jdLooksLikeGeographicLocation(p));
  }
  const low = t.toLowerCase();
  if (
    /,|\(|\)|\b(région|metropolitan|county|area|remote|télétravail|hybrid|hybride|on-?site|sur\s+site|worldwide|europe|france|germany|uk|usa|canada|spain|italy|belgium|switzerland|india|china|japan|brazil|mexico|australia)\b/i.test(
      t
    )
  )
    return true;
  if (/\b(ile-de-france|île-de-france|idf|auvergne|normandie|bretagne|occitanie)\b/i.test(low)) return true;
  if (/\b[a-zà-öø-ÿ][a-zà-öø-ÿ'\-]+,\s*[a-zà-öø-ÿ][a-zà-öø-ÿ'\-]+/i.test(t)) return true;
  if (/^(remote|télétravail|hybrid|hybride|on-?site|sur\s+site)$/i.test(t)) return true;
  if (/^[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸ][a-zàâäéèêëîïôöùûüÿç\-]{2,30}$/.test(t) && t.length <= 34) {
    if (
      /^(Product|Finance|Marketing|Business|Technical|Creative|People|Culture|Growth|Platform|Software|Hardware|Data|Design|Research)$/i.test(
        t
      )
    )
      return false;
    if (t.length >= 5) return true;
    if (/^(Nice|Lyon|Gap|Caen|Rome|Oslo|York|Bari|Sion|Agen|Albi|Arles|Dax|Lens|Metz|Reims|Tours)$/i.test(t))
      return true;
    return false;
  }
  return false;
}

/**
 * Lieu depuis la ligne primaire / tertiaire du top card (souvent « … · Paris, France »).
 */
function jdExtractLocationFromTopCardLines(detailsPanel) {
  if (!detailsPanel?.querySelector) return '';
  for (const sel of JOB_DETAIL_LOCATION_LINE_SELECTORS) {
    let el;
    try {
      el = detailsPanel.querySelector(sel);
    } catch (_) {
      el = null;
    }
    const raw = pnNormalizeText(el?.innerText || el?.textContent || '');
    if (!raw) continue;
    const segments = raw
      .split(/[·|]/)
      .map((p) => pnNormalizeText(p))
      .filter(Boolean);
    for (const seg of segments) {
      if (jdLooksLikeGeographicLocation(seg)) return seg;
    }
    if (jdLooksLikeGeographicLocation(raw)) return raw;
  }
  return '';
}

function pickJobLocationFromInsightTexts(metadataItems) {
  const list = (metadataItems || []).map((x) => pnNormalizeText(x)).filter(Boolean);
  for (const t of list) {
    if (!jdIsJobMetadataNoise(t) && jdLooksLikeGeographicLocation(t)) return t;
  }
  for (const t of list) {
    if (!jdIsJobMetadataNoise(t)) return t;
  }
  return '';
}

function splitJobMetadata(metadataItems, preferredLocation) {
  const explicit = pnNormalizeText(preferredLocation || '');
  const fromPreferred = explicit && !jdIsJobMetadataNoise(explicit) ? explicit : '';
  const fromInsights = pickJobLocationFromInsightTexts(metadataItems);
  const location = fromPreferred || fromInsights || '';
  const locNorm = location ? pnNormalizeText(location) : '';
  const details = (metadataItems || [])
    .map((x) => pnNormalizeText(x))
    .filter((t) => t && (!locNorm || pnNormalizeText(t) !== locNorm))
    .join(' | ');
  return { location, details };
}

/**
 * Collecte les libellés courts du panneau détail (chips Premium : CDD, Hybride, candidats…).
 * Inclut aussi les metadataItems classiques + segments « · » de la top card.
 */
function jdCollectJobdeskSignalTexts(panel, metadataItems = []) {
  const out = [];
  const push = (raw) => {
    const t = pnNormalizeText(raw);
    if (!t || t.length > 64) return;
    out.push(t);
  };
  for (const m of metadataItems || []) push(m);
  if (!panel) return Array.from(new Set(out));

  try {
    for (const el of panel.querySelectorAll('a, span, button, li')) {
      // Préférer les nœuds « feuille » courts (évite de concaténer toute la carte).
      let own = '';
      try {
        own = pnNormalizeText(el.childNodes?.length === 1 ? el.textContent : el.innerText);
      } catch (_) {
        own = pnNormalizeText(el.textContent || '');
      }
      // innerText de <a> chip = souvent juste « CDD » / « À distance »
      const t = pnNormalizeText(el.innerText || el.textContent || '');
      if (t && t.length <= 48) push(t);
      else if (own && own.length <= 48) push(own);
    }
  } catch (_) {}

  try {
    for (const sel of JOB_DETAIL_LOCATION_LINE_SELECTORS) {
      const el = panel.querySelector?.(sel);
      const raw = pnNormalizeText(el?.innerText || el?.textContent || '');
      if (!raw) continue;
      push(raw);
      for (const seg of raw.split(/[·|•]/)) push(seg);
    }
  } catch (_) {}

  // Ligne tertiaire Premium sans classes classiques : spans à droite avec « il y a » / « candidats »
  try {
    const blob = pnNormalizeText(panel.innerText || '').slice(0, 2500);
    const rel = blob.match(
      /(?:publication\s+)?il y a\s+\d+\s*(?:heure|heures|jour|jours|semaine|semaines|mois|an|ans)\b/i
    );
    if (rel) push(rel[0]);
    const apps = blob.match(
      /\b\d+\s*candidats?\b|\bmoins de\s*\d+\s*candidats?\b|\b\d+\s*applicants?\b|\bbe among the first\b|\bsoyez l['’]un des premiers\b/i
    );
    if (apps) push(apps[0]);
  } catch (_) {}

  return Array.from(new Set(out));
}

/** CDI / CDD / freelance / stage… */
function jdParseEmploymentType(signals) {
  const list = (signals || []).map((s) => pnNormalizeText(s).toLowerCase());
  const joined = list.join(' | ');
  const hit = (re) => list.some((t) => re.test(t)) || re.test(joined);
  if (hit(/\b(cdi|permanent|undetermined|contrat à durée indéterminée)\b/i)) return 'cdi';
  if (hit(/\b(cdd|fixed[-\s]?term|contrat à durée déterminée)\b/i)) return 'cdd';
  if (hit(/\b(freelance|indépendant|independent|contractor|self[-\s]?employed)\b/i)) return 'freelance';
  if (hit(/\b(stage|internship|intern)\b/i)) return 'internship';
  if (hit(/\b(alternance|apprentissage|apprentice|apprenticeship)\b/i)) return 'apprenticeship';
  if (hit(/\b(travail temporaire|temporary|interim|intérim|contract)\b/i)) return 'temporary';
  if (hit(/\b(temps partiel|part[-\s]?time)\b/i)) return 'part_time';
  if (hit(/\b(temps plein|full[-\s]?time)\b/i)) return 'full_time';
  return null;
}

/** remote | hybrid | onsite */
function jdParseWorkplaceType(signals) {
  const list = (signals || []).map((s) => pnNormalizeText(s).toLowerCase());
  const hit = (re) => list.some((t) => re.test(t));
  if (hit(/^(à distance|remote|fully remote|100%\s*remote|télétravail)$/i) || hit(/\b(à distance|fully remote|100%\s*remote)\b/i)) {
    return 'remote';
  }
  if (hit(/^(hybride|hybrid)$/i) || hit(/\b(hybride|hybrid)\b/i)) return 'hybrid';
  if (hit(/^(sur site|on[-\s]?site|on site|présentiel)$/i) || hit(/\b(sur site|on[-\s]?site|présentiel)\b/i)) {
    return 'onsite';
  }
  // Titre / metadata « (Remote) »
  if (hit(/\(\s*remote\s*\)|\bremote opportunity\b|\bworking from home\b/i)) return 'remote';
  return null;
}

/** « il y a 5 jours » → ISO approximatif. */
function jdParsePostedAt(signals) {
  const list = signals || [];
  let postedText = '';
  let postedAt = null;
  const reFr =
    /(?:publication\s+)?il y a\s+(\d+)\s*(heure|heures|jour|jours|semaine|semaines|mois|an|ans)\b/i;
  const reEn =
    /(?:posted\s+)?(?:about\s+)?(\d+)\s*(hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/i;
  for (const raw of list) {
    const t = pnNormalizeText(raw);
    let m = t.match(reFr);
    let n = 0;
    let unit = '';
    if (m) {
      n = Number(m[1]);
      unit = m[2].toLowerCase();
      postedText = t.match(reFr)?.[0] || t;
    } else {
      m = t.match(reEn);
      if (!m) continue;
      n = Number(m[1]);
      unit = m[2].toLowerCase();
      postedText = t.match(reEn)?.[0] || t;
    }
    if (!n || n < 0) continue;
    const ms =
      /heure|hour/.test(unit)
        ? n * 3600e3
        : /jour|day/.test(unit)
          ? n * 86400e3
          : /semaine|week/.test(unit)
            ? n * 7 * 86400e3
            : /mois|month/.test(unit)
              ? n * 30 * 86400e3
              : n * 365 * 86400e3;
    postedAt = new Date(Date.now() - ms).toISOString();
    // Préférer le libellé le plus précis (heures > jours) : premier match dans l’ordre du panneau
    break;
  }
  return { postedText: postedText || null, postedAt };
}

/** Nb de candidats (entier). « Moins de 10 » → 9 ; premiers → 0. */
function jdParseApplicantsCount(signals) {
  for (const raw of signals || []) {
    const t = pnNormalizeText(raw).toLowerCase();
    if (/soyez l['’]un des premiers|be among the first|over \d+\s*applicants|plus de \d+\s*candidats/i.test(t)) {
      if (/soyez l['’]un des premiers|be among the first/i.test(t)) return 0;
      const over = t.match(/(?:plus de|over)\s*(\d+)/i);
      if (over) return Number(over[1]);
    }
    const less = t.match(/moins de\s*(\d+)\s*candidats?/i) || t.match(/fewer than\s*(\d+)\s*applicants?/i);
    if (less) {
      const n = Number(less[1]);
      return Number.isFinite(n) && n > 0 ? n - 1 : null;
    }
    const exact =
      t.match(/^(\d+)\s*candidats?$/) ||
      t.match(/^(\d+)\s*applicants?$/) ||
      t.match(/\b(\d+)\s*candidats?\b/) ||
      t.match(/\b(\d+)\s*applicants?\b/);
    if (exact) {
      const n = Number(exact[1]);
      if (Number.isFinite(n) && n >= 0 && n < 100000) return n;
    }
  }
  return null;
}

function jdExtractJobdeskFilterFields(panel, metadataItems = []) {
  const signals = jdCollectJobdeskSignalTexts(panel, metadataItems);
  const employmentType = jdParseEmploymentType(signals);
  const workplaceType = jdParseWorkplaceType(signals);
  const { postedText, postedAt } = jdParsePostedAt(signals);
  const applicantsCount = jdParseApplicantsCount(signals);
  return {
    employmentType,
    workplaceType,
    postedText,
    postedAt,
    applicantsCount,
    filterSignals: signals.slice(0, 40)
  };
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
  const hint =
    typeof extractJobLocationHint === 'function' ? pnNormalizeText(extractJobLocationHint(wrapper) || '') : '';
  const preferredCard = hint && jdLooksLikeGeographicLocation(hint) && !jdIsJobMetadataNoise(hint) ? hint : '';
  const { location, details } = splitJobMetadata(metadataItems, preferredCard);
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
  let companyName = '';
  if (detailsPanel) {
    for (const selector of [
      '.job-details-jobs-unified-top-card__company-name',
      '[class*="job-details-jobs-unified-top-card__company-name"]',
      '.jobs-unified-top-card__company-name',
      '[class*="jobs-unified-top-card__company-name"]',
      'a[href*="/company/"]'
    ]) {
      try {
        const els =
          typeof querySelectorAllDeep === 'function'
            ? querySelectorAllDeep(detailsPanel, selector)
            : Array.from(detailsPanel.querySelectorAll(selector));
        for (const el of els) {
          const t = pnNormalizeText(el?.innerText || el?.textContent || '');
          if (t && t.length >= 2 && !/voir l’offre|see job/i.test(t)) {
            companyName = t;
            break;
          }
        }
      } catch (_) {}
      if (companyName) break;
    }
  }
  companyName = companyName || cardPayload.companyName || '';
  const descFound = jdFindDescriptionInPanel(detailsPanel);
  const descriptionEl = descFound.el;
  const descriptionText = descFound.text;
  // Titre/entreprise seuls : payload partiel pour diagnostiquer le chargement (évite bestPayload=null).
  if (!companyName && !descriptionText && !cardPayload.jobTitle) return null;
  if (!descriptionText && !companyName) return null;

  let detailJobTitle = '';
  try {
    for (const sel of [
      '.job-details-jobs-unified-top-card__job-title',
      '[class*="job-details-jobs-unified-top-card__job-title"]',
      '.jobs-unified-top-card__job-title',
      '[class*="jobs-unified-top-card__job-title"]',
      'h1'
    ]) {
      const el = detailsPanel?.querySelector?.(sel);
      if (!el) continue;
      const raw =
        typeof pnVisibleTextFromEl === 'function'
          ? pnVisibleTextFromEl(el)
          : pnNormalizeText(el.innerText || el.textContent || '');
      if (raw && raw.length >= 4) {
        detailJobTitle = raw;
        break;
      }
    }
  } catch (_) {}
  const detailJobUrl = detailsPanel?.querySelector?.('a[href*="/jobs/view/"]')?.href || '';
  if (!detailJobTitle && detailsPanel) {
    try {
      const titleLink = detailsPanel.querySelector?.('a[href*="/jobs/view/"]');
      const t =
        typeof pnVisibleTextFromEl === 'function'
          ? pnVisibleTextFromEl(titleLink)
          : pnNormalizeText(titleLink?.innerText || titleLink?.textContent || '');
      if (t && t.length >= 4 && t.length < 220) detailJobTitle = t;
    } catch (_) {}
  }
  const jobTitle =
    typeof pnCleanJobTitle === 'function'
      ? pnCleanJobTitle(detailJobTitle || cardPayload.jobTitle || '')
      : detailJobTitle || cardPayload.jobTitle || '';
  const jobUrl = pnNormalizeText(detailJobUrl || cardPayload.jobUrl || '');
  let linkedinJobId = getJobIdFromWrapper(wrapper, jobUrl);
  if (!linkedinJobId && detailsPanel) {
    try {
      const aboutEl = detailsPanel.querySelector?.(
        '[id*="JobDetails_AboutTheJob_"], [id^="JobDetails_AboutTheJob"], [id^="JobDetails_"]'
      );
      const m = String(aboutEl?.id || '').match(/(\d{8,})/);
      if (m) linkedinJobId = m[1];
    } catch (_) {}
  }
  if (!linkedinJobId) {
    try {
      linkedinJobId = new URL(location.href).searchParams.get('currentJobId') || '';
    } catch (_) {
      linkedinJobId = '';
    }
  }
  const metadataItems = getAllTexts(detailsPanel, JOB_METADATA_ITEM_SELECTORS);
  const fromTopCard = jdExtractLocationFromTopCardLines(detailsPanel);
  const cardLoc = pnNormalizeText(cardPayload.location || '');
  const preferredLoc =
    (fromTopCard && !jdIsJobMetadataNoise(fromTopCard) ? fromTopCard : '') ||
    (cardLoc && jdLooksLikeGeographicLocation(cardLoc) && !jdIsJobMetadataNoise(cardLoc) ? cardLoc : '');
  const { location, details } = splitJobMetadata(metadataItems, preferredLoc);
  const filters = jdExtractJobdeskFilterFields(detailsPanel, metadataItems);
  // Workplace parfois collé au lieu (« Paris (Hybride) ») si chip absente.
  let workplaceType = filters.workplaceType;
  if (!workplaceType && location) {
    workplaceType = jdParseWorkplaceType([location]);
  }
  let employmentType = filters.employmentType;
  if (!employmentType && (jobTitle || cardPayload.jobTitle)) {
    employmentType = jdParseEmploymentType([jobTitle || '', cardPayload.jobTitle || '']);
  }
  const companyType = wrapper?.getAttribute?.(DATA_TYPE) || null;
  const descriptionHtml = descriptionEl?.innerHTML ? String(descriptionEl.innerHTML).trim() : '';
  const resolvedJobUrl = jobUrl || detailJobUrl || cardPayload.jobUrl || '';
  const companyInsight =
    typeof extractJobDetailsCompanyInsightCard === 'function'
      ? extractJobDetailsCompanyInsightCard(resolvedJobUrl)
      : null;
  const insightUrl = companyInsight?.companyLinkedinUrl || null;
  const headerUrl =
    typeof findCompanyUrlFromOpenJobDetailsPanel === 'function'
      ? findCompanyUrlFromOpenJobDetailsPanel(resolvedJobUrl)
      : null;
  const companyLinkedinUrl = insightUrl || headerUrl || null;

  if (!jobTitle && !linkedinJobId && !jobUrl && !descriptionText) return null;
  // Description encore absente : payload « loading » (ne pas sauver comme complete).
  if (!descriptionText) {
    return {
      stage: 'details_loading',
      linkedinJobId: linkedinJobId || cardPayload.linkedinJobId || null,
      companyName: companyName || null,
      companyType: wrapper?.getAttribute?.(DATA_TYPE) || null,
      companyLinkedinUrl: companyLinkedinUrl || null,
      jobTitle: jobTitle || null,
      jobUrl: jobUrl || null,
      location: location || cardPayload.location || null,
      employmentType,
      workplaceType,
      postedText: filters.postedText,
      postedAt: filters.postedAt,
      applicantsCount: filters.applicantsCount,
      descriptionText: '',
      detailsScrapedAt: null,
      source: 'linkedin_jobs',
      linkedinData: { card: cardPayload.cardData || null, details: { companyInsight: null } }
    };
  }

  return {
    stage: 'details',
    linkedinJobId: linkedinJobId || null,
    companyName,
    companyType,
    companyLinkedinUrl: companyLinkedinUrl || null,
    jobTitle: jobTitle || null,
    jobUrl: jobUrl || null,
    location: location || null,
    employmentType: employmentType || null,
    workplaceType: workplaceType || null,
    postedText: filters.postedText || null,
    postedAt: filters.postedAt || null,
    applicantsCount:
      typeof filters.applicantsCount === 'number' ? filters.applicantsCount : null,
    descriptionText,
    detailsScrapedAt: new Date().toISOString(),
    source: 'linkedin_jobs',
    linkedinData: {
      card: cardPayload.cardData || null,
      companyLinkedinUrl: companyLinkedinUrl || null,
      details: {
        metadataItems,
        detailsText: details || null,
        descriptionHtml: descriptionHtml || null,
        filterSignals: filters.filterSignals || [],
        employmentType: employmentType || null,
        workplaceType: workplaceType || null,
        postedText: filters.postedText || null,
        postedAt: filters.postedAt || null,
        applicantsCount:
          typeof filters.applicantsCount === 'number' ? filters.applicantsCount : null,
        companyInsight: companyInsight
          ? {
              companyName: companyInsight.companyName || null,
              employeesHint: companyInsight.employeesHint || null,
              aboutSnippet: companyInsight.aboutSnippet || null,
              companyLinkedinUrl: companyInsight.companyLinkedinUrl || null,
              insightSource: companyInsight.insightSource || null
            }
          : null
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

/**
 * @param {object|null} payload - résultat de buildJobDetailsPayload
 * @param {string} [expectedJid] - jid cible passé par l'auto-open ; si fourni et si le panel
 *   expose un jid différent, isReady = false jusqu'à correspondance.
 */
function getJobDeskReadyState(payload, expectedJid, opts) {
  const requireCompanyInsight = opts?.requireCompanyInsight !== false;
  const detailsPanel = getJobDetailsPanel();
  const metadataCount = Array.isArray(payload?.linkedinData?.details?.metadataItems)
    ? payload.linkedinData.details.metadataItems.length
    : 0;
  const descriptionLength = String(payload?.descriptionText || '').trim().length;
  const hasTitle = String(payload?.jobTitle || '').trim().length > 0;
  const hasCompany = String(payload?.companyName || '').trim().length > 0;
  const hasCompanyInsight = jdScrapeHasCompleteCompanyInsight(payload);

  // Si le panneau expose déjà un jid différent de la cible, ce n’est PAS prêt
  // (sinon on compte un faux OK sur l’offre précédente après un syncUrl sans clic).
  // Si panelJid encore vide : on attend (LinkedIn hydrate).
  const panelJid = String(payload?.linkedinJobId || '').trim();
  const expected = String(expectedJid || '').trim();
  const jidMatches = !expected || !panelJid || panelJid === expected;
  const stillCollapsed = jdPanelHasDescriptionExpandControl(detailsPanel);
  const descLooksComplete =
    descriptionLength >= JOB_SCRAPE_MIN_DESCRIPTION_LEN &&
    (!stillCollapsed || descriptionLength >= JOB_SCRAPE_FULL_DESCRIPTION_TARGET);

  return {
    isReady:
      !!payload &&
      isElementVisible(detailsPanel) &&
      hasCompany &&
      hasTitle &&
      descLooksComplete &&
      jidMatches &&
      (!requireCompanyInsight || hasCompanyInsight),
    hasCompanyInsight,
    jidMatches,
    stillCollapsed,
    descriptionLength,
    signature: JSON.stringify([
      payload?.linkedinJobId || '',
      payload?.jobUrl || '',
      payload?.jobTitle || '',
      payload?.companyName || '',
      payload?.location || '',
      metadataCount,
      descriptionLength,
      String(payload?.linkedinData?.details?.companyInsight?.companyLinkedinUrl || ''),
      String(payload?.linkedinData?.details?.companyInsight?.aboutSnippet || '').length,
      String(payload?.linkedinData?.details?.companyInsight?.employeesHint || '')
    ])
  };
}

/** Encart « À propos de l’entreprise » entièrement chargé (description + URL ou effectifs). */
function jdScrapeHasCompleteCompanyInsight(payload) {
  const ci = payload?.linkedinData?.details?.companyInsight;
  if (!ci) return false;
  const aboutLen = String(ci.aboutSnippet || '').trim().length;
  const emp = String(ci.employeesHint || '').trim();
  const url = String(ci.companyLinkedinUrl || '').trim();
  if (aboutLen < JOB_SCRAPE_INSIGHT_MIN_ABOUT_LEN) return false;
  if (!url && !emp) return false;
  return true;
}

/** Encart entreprise : un léger scroll bas + max 1 « Voir plus » (évite de lutter avec LinkedIn). */
function jdRevealCompanyInsightCard() {
  const panel = getJobDetailsPanel();
  if (!panel) return;
  try {
    if (panel.scrollHeight - panel.clientHeight > 48) {
      panel.scrollTop = Math.min(panel.scrollTop + 400, panel.scrollHeight);
    }
  } catch (_) {}
  try {
    for (const btn of panel.querySelectorAll('button, [role="button"]')) {
      if (!jdIsSafeDescExpandControl(btn)) continue;
      const label = pnNormalizeText(
        btn.getAttribute?.('aria-label') || btn.innerText || btn.textContent || ''
      ).toLowerCase();
      if (!/voir plus|show more|see more|afficher plus/i.test(label)) continue;
      if (/en savoir plus|learn more|interested|intérêt/i.test(label)) continue;
      const scope =
        btn.closest?.(
          '[class*="jobs-company"], [class*="company-module"], [class*="about-the-company"], [class*="about-us"]'
        ) || btn.closest?.('section, article');
      if (!scope) continue;
      if (scope.querySelector?.('[class*="jobs-description"], [class*="job-details-jobs-unified-top-card"]')) {
        continue;
      }
      // Ne jamais cliquer si le bouton est dans un lien company/help.
      if (btn.closest?.('a[href*="/company/"], a[href*="/help/"], a[href*="/life"]')) continue;
      btn.click();
      break;
    }
  } catch (_) {}
}

function pnSaveJobOfferToBackground(jobOffer, wrapper, opts) {
  const confirmComplete = !!opts?.confirmComplete;
  const fingerprint = JSON.stringify([
    jobOffer.stage || '',
    jobOffer.linkedinJobId || '',
    jobOffer.jobUrl || '',
    jobOffer.companyName || '',
    jobOffer.jobTitle || '',
    jobOffer.location || '',
    jobOffer.employmentType || '',
    jobOffer.workplaceType || '',
    jobOffer.postedText || '',
    jobOffer.postedAt || '',
    typeof jobOffer.applicantsCount === 'number' ? jobOffer.applicantsCount : '',
    jobOffer.descriptionText || '',
    jobOffer.linkedinData?.details?.companyInsight?.aboutSnippet || '',
    jobOffer.linkedinData?.details?.companyInsight?.employeesHint || '',
    jobOffer.linkedinData?.details?.companyInsight?.companyLinkedinUrl || ''
  ]);
  if (!confirmComplete && fingerprint === lastSavedJobFingerprint) {
    return Promise.resolve({ ok: true, persistedComplete: false, skippedDuplicateFingerprint: true });
  }
  lastSavedJobFingerprint = fingerprint;
  const dedupKey =
    wrapper && typeof dedupeKeyForCard === 'function' ? dedupeKeyForCard(wrapper) : '';
  const action = confirmComplete ? 'saveJobOfferAndConfirm' : 'saveJobOffer';
  return new Promise((resolve) => {
    sendRuntimeMessageSafe({ action, jobOffer, dedupKey }, (res, err) => {
      if (err) {
        resolve({ ok: false, error: err.message || String(err), persistedComplete: false });
        return;
      }
      const ok = !!res?.ok;
      resolve({
        ok,
        buffered: !!res?.buffered,
        persistedComplete: confirmComplete ? !!res?.persistedComplete : ok
      });
    });
  });
}

/**
 * Enchaîne après ouverture du panneau détail : `buildJobDetailsPayload` lit le DOM Jobdesk.
 * @param {HTMLElement|null} wrapper
 * @param {{ o?: 'a'|'u', jid?: string }} [opts]
 *   o=a auto-open, o=u clic utilisateur
 *   jid=ID LinkedIn attendu — si fourni, attend que le panel affiche ce job avant de scraper
 */
/** Annule le scrape Jobdesk en cours (nouveau clic / navigation). */
let __pnScrapeCancelCurrent = null;

function pnCancelActiveJobScrape(reason = '') {
  if (typeof __pnScrapeCancelCurrent === 'function') {
    try {
      __pnScrapeCancelCurrent(reason || 'cancel');
    } catch (_) {}
    __pnScrapeCancelCurrent = null;
  }
}

function scheduleJobOfferScrape(wrapper, opts) {
  // Un seul scrape à la fois — évite empiler des polls qui bloquent LinkedIn.
  pnCancelActiveJobScrape('supersede');

  const origin = opts?.o === 'u' ? 'u' : 'a';
  const waitForSupabaseComplete = !!opts?.waitForSupabaseComplete;
  const requireCompanyInsight = opts?.requireCompanyInsight !== false;
  const expectedJid = String(opts?.jid || '').trim();
  const card0 = buildJobCardPayload(wrapper);
  const jid0 = expectedJid || String(card0?.linkedinJobId || '');
  const started = Date.now();
  jdScLog({ jid: jid0, st: 'b', o: origin, xjid: expectedJid || undefined });

  return new Promise((resolve) => {
    let finished = false;
    let bestPayload = null;
    let lastReadySignature = '';
    let stableReadyCount = 0;
    // flags one-shot pour éviter de spammer les logs de diagnostic
    let warnedJidMismatch = false;
    let warnedShortDesc = false;
    let warnedMissingInsight = false;
    let revealInsightEvery = 0;

    const done = (result) => {
      if (finished) return;
      finished = true;
      if (__pnScrapeCancelCurrent === cancelFn) __pnScrapeCancelCurrent = null;
      resolve(result || { state: 'e', persistedComplete: false });
    };
    const cancelFn = () => {
      if (finished) return;
      jdScLog({ jid: jid0, st: 'x', o: origin, ms: Date.now() - started, r: 'cancel' });
      done({ state: 'x', persistedComplete: false });
    };
    __pnScrapeCancelCurrent = cancelFn;

    const attempt = async () => {
      try {
        await attemptInner();
      } catch (_) {}
    };

    const attemptInner = async () => {
      if (finished) return;
      if (wrapper && !wrapper.isConnected) {
        jdScLog({ jid: jid0, st: 'x', o: origin, ms: Date.now() - started });
        done({ state: 'x', persistedComplete: false });
        return;
      }
      // Reveals : tôt + retries si « Voir plus » encore présent (évite sauver un extrait 80–200 car.).
      const elapsed = Date.now() - started;
      if (revealInsightEvery === 0 && elapsed >= 900) {
        revealInsightEvery = 1;
        try {
          jdRevealJobDescription();
        } catch (_) {}
      } else if (revealInsightEvery === 1 && elapsed >= 2200) {
        revealInsightEvery = 2;
        try {
          if (jdPanelHasDescriptionExpandControl(getJobDetailsPanel())) jdRevealJobDescription();
        } catch (_) {}
      } else if (revealInsightEvery === 2 && elapsed >= 4500) {
        revealInsightEvery = 3;
        try {
          if (jdPanelHasDescriptionExpandControl(getJobDetailsPanel())) jdRevealJobDescription();
          jdRevealCompanyInsightCard();
        } catch (_) {}
      }

      const payload = buildJobDetailsPayload(wrapper);
      if (payload && payload.stage !== 'details_loading') bestPayload = payload;
      else if (payload && !bestPayload) bestPayload = payload;

      const descLenNow = String(payload?.descriptionText || bestPayload?.descriptionText || '').trim()
        .length;

      // Description jamais arrivée : ne pas bloquer 22–32 s (1re offre « qui charge mal »).
      if (
        descLenNow < JOB_SCRAPE_MIN_DESCRIPTION_LEN &&
        Date.now() - started >= JOB_SCRAPE_NO_DESC_GIVE_UP_MS
      ) {
        jdScLog({
          jid: jid0,
          st: 'e_nodesc',
          o: origin,
          ms: Date.now() - started,
          dl: descLenNow,
          panel: getJobDetailsPanel() ? 1 : 0
        });
        done({ state: 'e_nodesc', persistedComplete: false, saveOk: false });
        return;
      }

      let { isReady, hasCompanyInsight, jidMatches, descriptionLength, signature } = getJobDeskReadyState(
        payload,
        expectedJid,
        { requireCompanyInsight }
      );
      if (requireCompanyInsight && payload && !hasCompanyInsight && !warnedMissingInsight) {
        const descOk = descriptionLength >= JOB_SCRAPE_MIN_DESCRIPTION_LEN;
        if (descOk) {
          warnedMissingInsight = true;
          jdScLog({
            jid: jid0,
            st: 'w_ci',
            o: origin,
            ms: Date.now() - started,
            dl: descriptionLength
          });
        }
      }

      // Log one-shot si on attend que le bon job soit affiché
      if (!jidMatches && !warnedJidMismatch) {
        warnedJidMismatch = true;
        jdScLog({
          jid: jid0,
          st: 'w_jid',
          o: origin,
          ms: Date.now() - started,
          pjid: String(payload?.linkedinJobId || '')
        });
      }
      // Log one-shot si description présente mais trop courte
      if (!isReady && payload && descriptionLength > 0 && descriptionLength < JOB_SCRAPE_MIN_DESCRIPTION_LEN && !warnedShortDesc) {
        warnedShortDesc = true;
        jdScLog({ jid: jid0, st: 'w_desc', o: origin, ms: Date.now() - started, dl: descriptionLength });
      }

      if (isReady) {
        stableReadyCount = signature === lastReadySignature ? stableReadyCount + 1 : 1;
        lastReadySignature = signature;
      } else {
        stableReadyCount = 0;
        lastReadySignature = '';
      }

      const requiredStablePolls = requireCompanyInsight ? JOB_SCRAPE_INSIGHT_STABLE_POLLS : 1;
      if (
        stableReadyCount >= requiredStablePolls &&
        payload &&
        payload.stage !== 'details_loading' &&
        String(payload.descriptionText || '').trim().length >= JOB_SCRAPE_MIN_DESCRIPTION_LEN
      ) {
        const saveRes = await pnSaveJobOfferToBackground(payload, wrapper, {
          confirmComplete: waitForSupabaseComplete
        });
        const persistedComplete = !!saveRes?.persistedComplete;
        const ci = payload.linkedinData?.details?.companyInsight;
        jdScLog({
          jid: String(payload.linkedinJobId || jid0),
          st: 'ok',
          o: origin,
          ms: Date.now() - started,
          dl: String(payload.descriptionText || '').length,
          pc: persistedComplete ? 1 : 0,
          co_url: payload.companyLinkedinUrl ? 1 : 0,
          ci_src: ci?.insightSource || '',
          ci_about: ci?.aboutSnippet ? String(ci.aboutSnippet).length : 0,
          ci_emp: ci?.employeesHint ? 1 : 0
        });
        if (
          payload.companyType === 'Client' &&
          payload.companyName &&
          typeof prefetchFinancialDataForClient === 'function'
        ) {
          let card = wrapper;
          if (!card?.isConnected && payload.linkedinJobId) {
            const id = String(payload.linkedinJobId);
            card =
              document.querySelector(`[data-job-id="${id}"]`) ||
              document.querySelector(`[data-occludable-job-id="${id}"]`);
          }
          prefetchFinancialDataForClient(card || document.body, payload.companyName);
        }
        done({ state: 'ok', persistedComplete, saveOk: !!saveRes?.ok });
        return;
      }

      // Description OK mais encart entreprise absent : ne pas attendre le max (blocage auto-open).
      const softPanelJid = String(bestPayload?.linkedinJobId || '').trim();
      const softJidOk =
        !expectedJid || !softPanelJid || softPanelJid === String(expectedJid).trim();
      const softDescLen = String(bestPayload?.descriptionText || '').trim().length;
      const softStillCollapsed = jdPanelHasDescriptionExpandControl(getJobDetailsPanel());
      const softDescOk =
        !!bestPayload &&
        softJidOk &&
        bestPayload.stage !== 'details_loading' &&
        softDescLen >= JOB_SCRAPE_MIN_DESCRIPTION_LEN &&
        (!softStillCollapsed || softDescLen >= JOB_SCRAPE_FULL_DESCRIPTION_TARGET);
      if (
        softDescOk &&
        (!requireCompanyInsight || !jdScrapeHasCompleteCompanyInsight(bestPayload)) &&
        Date.now() - started >= (requireCompanyInsight ? JOB_SCRAPE_SOFT_NO_INSIGHT_MS : 4500)
      ) {
        const saveRes = await pnSaveJobOfferToBackground(bestPayload, wrapper, {
          confirmComplete: waitForSupabaseComplete
        });
        const persistedComplete = !!saveRes?.persistedComplete;
        jdScLog({
          jid: String(bestPayload.linkedinJobId || jid0),
          st: 'ok_no_ci',
          o: origin,
          ms: Date.now() - started,
          dl: String(bestPayload.descriptionText || '').length,
          pc: persistedComplete ? 1 : 0,
          soft: 1
        });
        if (
          bestPayload.companyType === 'Client' &&
          bestPayload.companyName &&
          typeof prefetchFinancialDataForClient === 'function'
        ) {
          prefetchFinancialDataForClient(wrapper || document.body, bestPayload.companyName);
        }
        done({ state: 'ok', persistedComplete, saveOk: !!saveRes?.ok });
        return;
      }

      if (Date.now() - started >= JOB_SCRAPE_AFTER_OPEN_MAX_MS) {
        const insightComplete = bestPayload && jdScrapeHasCompleteCompanyInsight(bestPayload);
        const descLen = bestPayload ? String(bestPayload.descriptionText || '').trim().length : 0;
        const timeoutStillCollapsed = jdPanelHasDescriptionExpandControl(getJobDetailsPanel());
        const descOk =
          descLen >= JOB_SCRAPE_MIN_DESCRIPTION_LEN &&
          (!timeoutStillCollapsed || descLen >= JOB_SCRAPE_FULL_DESCRIPTION_TARGET);
        const timeoutPanelJid = String(bestPayload?.linkedinJobId || '').trim();
        const timeoutJidMismatch =
          !!expectedJid &&
          !!timeoutPanelJid &&
          timeoutPanelJid !== String(expectedJid).trim();
        if (timeoutJidMismatch) {
          jdScLog({
            jid: jid0,
            st: 'e_jid',
            o: origin,
            ms: Date.now() - started,
            pjid: timeoutPanelJid,
            dl: descLen
          });
          done({ state: 'e_jid', persistedComplete: false, saveOk: false });
          return;
        }

        // Sans encart entreprise : on sauve quand même si la description Jobdesk est là.
        // Sinon l’auto-open reste bloqué ~32s puis échoue (ex. remote jobs) → compteur figé.
        if (requireCompanyInsight && bestPayload && descOk && !insightComplete) {
          const saveRes = await pnSaveJobOfferToBackground(bestPayload, wrapper, {
            confirmComplete: waitForSupabaseComplete
          });
          const persistedComplete = !!saveRes?.persistedComplete;
          jdScLog({
            jid: String(bestPayload.linkedinJobId || jid0),
            st: 'ok_no_ci',
            o: origin,
            ms: Date.now() - started,
            dl: descLen,
            pc: persistedComplete ? 1 : 0,
            co_url: bestPayload.companyLinkedinUrl ? 1 : 0
          });
          if (
            bestPayload.companyType === 'Client' &&
            bestPayload.companyName &&
            typeof prefetchFinancialDataForClient === 'function'
          ) {
            prefetchFinancialDataForClient(wrapper || document.body, bestPayload.companyName);
          }
          done({ state: 'ok', persistedComplete, saveOk: !!saveRes?.ok });
          return;
        }

        if (requireCompanyInsight && !insightComplete) {
          jdScLog({
            jid: String((bestPayload && bestPayload.linkedinJobId) || jid0),
            st: 'w_insight',
            o: origin,
            ms: Date.now() - started,
            dl: descLen,
            ci_about: bestPayload?.linkedinData?.details?.companyInsight?.aboutSnippet
              ? String(bestPayload.linkedinData.details.companyInsight.aboutSnippet).length
              : 0
          });
          done({ state: 'w_insight', persistedComplete: false, saveOk: false });
          return;
        }
        let persistedComplete = false;
        let saveOk = false;
        if (bestPayload) {
          const saveRes = await pnSaveJobOfferToBackground(bestPayload, wrapper, {
            confirmComplete: waitForSupabaseComplete
          });
          persistedComplete = !!saveRes?.persistedComplete;
          saveOk = !!saveRes?.ok;
        }
        jdScLog({
          jid: String((bestPayload && bestPayload.linkedinJobId) || jid0),
          st: bestPayload ? 't' : 'e',
          o: origin,
          ms: Date.now() - started,
          dl: descLen,
          pc: persistedComplete ? 1 : 0
        });
        done({ state: bestPayload ? 't' : 'e', persistedComplete, saveOk });
        return;
      }
      window.setTimeout(() => {
        void attempt();
      }, JOB_SCRAPE_AFTER_OPEN_STEP_MS);
    };

    window.setTimeout(() => {
      void attempt();
    }, JOB_SCRAPE_AFTER_OPEN_FIRST_DELAY_MS);
  });
}

function saveJobCardSnapshot(wrapper) {
  if (!wrapper || wrapper.hasAttribute(DATA_JOB_CARD_SAVED)) return;
  const payload = buildJobCardPayload(wrapper);
  if (!payload) return;
  wrapper.setAttribute(DATA_JOB_CARD_SAVED, 'true');
  void pnSaveJobOfferToBackground(payload);
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

/** Un seul scrape actif — un nouveau clic annule le précédent. */
let __pnScrapeAbort = null;

function scheduleJobOfferScrapeCancellable(wrapper, opts) {
  if (typeof __pnScrapeAbort === 'function') {
    try {
      __pnScrapeAbort();
    } catch (_) {}
    __pnScrapeAbort = null;
  }
  let cancelled = false;
  __pnScrapeAbort = () => {
    cancelled = true;
  };
  // Laisser LinkedIn hydrater le panneau avant de lire le DOM.
  const delay = opts?.o === 'u' ? 900 : 0;
  return new Promise((resolve) => {
    setTimeout(() => {
      if (cancelled) {
        resolve({ state: 'x', persistedComplete: false });
        return;
      }
      const p = scheduleJobOfferScrape(wrapper, opts);
      Promise.resolve(p).then((r) => {
        if (!cancelled) resolve(r);
      });
    }, delay);
  });
}

function attachUserClickJobdeskScrape() {
  if (window.__pnJobdeskUserClickScrape) return;
  window.__pnJobdeskUserClickScrape = true;
  document.body.addEventListener(
    'click',
    (event) => {
      // event.isTrusted === false pour tout clic synthétique dispatché par l'extension elle-même
      // (auto-open : dispatchSyntheticPointerClick / el.click()). Sans ce filtre, l'auto-open
      // se fait passer pour un clic utilisateur, s'auto-abort (jdAbortAutoOpenForUserNavigation)
      // et relance un scrape concurrent qui annule celui déjà en cours → mitraillage de toutes
      // les offres en quelques secondes sans jamais laisser le temps à la description de charger.
      if (event.isTrusted === false) return;
      const wrapper = getJobCardWrapperFromEventTarget(event.target);
      if (!wrapper) return;
      // Ne pas lutter avec le clic utilisateur : stop auto-open + scrape passif différé.
      try {
        if (typeof jdAbortAutoOpenForUserNavigation === 'function') {
          jdAbortAutoOpenForUserNavigation('user-click');
        }
      } catch (_) {}
      void scheduleJobOfferScrapeCancellable(wrapper, {
        o: 'u',
        requireCompanyInsight: false,
        waitForSupabaseComplete: false
      });
    },
    true
  );
}
