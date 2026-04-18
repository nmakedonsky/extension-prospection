/**
 * Contexte de matching unique : collecte DOM + logo en image (base64) + tentatives si incomplet.
 * Doit être chargé après company-dock.js (utilise getJobInfoFromWrapper).
 */

const MATCH_CONTEXT_VERSION = 1;
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
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Premier lien /company/ valide dans un sous-arbre (tous les candidats, pas seulement le premier).
 */
function findCompanyUrlInRoot(root) {
  if (!root?.querySelectorAll) return null;
  const anchors = root.querySelectorAll('a[href*="company"]');
  for (const a of anchors) {
    const n = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
    if (n) return n;
  }
  return null;
}

/**
 * Sur jobs/search-results, le lien société est souvent uniquement dans le panneau détail (droite),
 * pas dans la carte liste — on complète depuis le détail ou la colonne droite.
 */
function findCompanyUrlFromJobDetailsPane(wrapper) {
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
      const roots = document.querySelectorAll(sel);
      for (const root of roots) {
        if (isNodeInJobDetailsComposed && !isNodeInJobDetailsComposed(root)) continue;
        const u = findCompanyUrlInRoot(root);
        if (u) return u;
      }
    } catch (_) {}
  }

  const vw = window.innerWidth || 1200;
  const split = vw * 0.42;
  const all = document.querySelectorAll('a[href*="company"]');
  for (const a of all) {
    const r = a.getBoundingClientRect?.();
    if (!r || r.width < 1 || r.height < 1) continue;
    if (r.left < split) continue;
    const n = pnNormalizeCompanyHref(a.getAttribute('href') || a.href);
    if (n) return n;
  }
  return null;
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
  const logoImg = wrapper?.querySelector?.('img[alt*="Logo"], img[class*="EntityPhoto"]');
  let companyLinkedinUrl =
    findCompanyUrlInRoot(wrapper) ||
    findCompanyUrlFromJobDetailsPane(wrapper);
  const jobInfo =
    typeof getJobInfoFromWrapper === 'function'
      ? getJobInfoFromWrapper(wrapper)
      : { jobTitle: '', jobUrl: '' };

  const ctx = {
    matchContextVersion: MATCH_CONTEXT_VERSION,
    companyName: name,
    logoUrl: logoImg?.src ? String(logoImg.src).trim() : null,
    logoAlt: logoImg?.alt ? String(logoImg.alt).trim() : name ? `Logo de ${name}` : null,
    companyLinkedinUrl,
    jobTitle: pnTrim(jobInfo.jobTitle),
    jobUrl: pnTrim(jobInfo.jobUrl),
    jobLocation: extractJobLocationHint(wrapper) || null,
    logoInlineData: null,
    logoInlineSkipped: false
  };

  const missing = [];
  if (!pnIsValidLinkedinCompanyUrl(ctx.companyLinkedinUrl)) missing.push('companyLinkedinUrl');
  if (!ctx.logoUrl || !/^https?:\/\//i.test(ctx.logoUrl)) missing.push('logoUrl');
  if (!ctx.jobTitle || ctx.jobTitle.length < 2) missing.push('jobTitle');

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
