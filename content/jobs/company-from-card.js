/** Extraction nom société depuis une carte offre. */

/** Texte visible uniquement (LinkedIn duplique souvent le titre en aria-hidden). */
function pnVisibleTextFromEl(el) {
  if (!el) return '';
  try {
    const clone = el.cloneNode(true);
    clone.querySelectorAll?.('[aria-hidden="true"]').forEach((n) => n.remove());
    return String(clone.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (_) {
    return String(el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * LinkedIn Premium colle souvent le titre 2× sans séparateur :
 * « Lead Data EngineerLead Data Engineer ».
 */
function pnCleanJobTitle(raw) {
  let t = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  t = t
    .replace(/\s*\(offre d['’]emploi vérifiée\)\s*/gi, ' ')
    .replace(/\s*\(verified job(?: posting)?\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Duplication exacte ABCABC
  if (t.length >= 8 && t.length % 2 === 0) {
    const half = t.length / 2;
    if (t.slice(0, half) === t.slice(half)) return t.slice(0, half).trim();
  }

  // Duplication sans espace : TitleTitle (même si longueurs impaires après nettoyage)
  const max = Math.min(Math.floor(t.length / 2), 160);
  for (let len = max; len >= 10; len--) {
    const a = t.slice(0, len);
    const rest = t.slice(len);
    if (!rest) continue;
    if (rest === a || rest.startsWith(a)) return a.trim();
    // 2e copie tronquée / sans suffixe vérifié
    if (a.startsWith(rest) && rest.length >= 10) return a.trim();
  }
  return t.slice(0, 200);
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
  clone.querySelectorAll?.('.pn-legit').forEach((n) => n.remove());
  clone.querySelectorAll?.('[aria-hidden="true"]').forEach((n) => n.remove());
  let text = clone.textContent?.trim() || '';
  text = text.replace(/\s+/g, ' ').trim();
  // LinkedIn colle parfois « Société · Promoted / Verified » dans le même nœud.
  text = text.replace(/\s*[·•|]\s*(?:Promoted|Sponsorisé|Verified|Certifié)\b.*$/i, '').trim();
  text = text.replace(/\s*[·•]\s*$/g, '').trim();
  // UI Premium capturée à tort comme nom société
  if (/^afficher les infos premium$/i.test(text) || /^see premium insights$/i.test(text)) return '';
  return text;
}

/** Clé cache tolérante (casse / accents) pour re-peindre après virtualisation. */
function pnNormalizeCompanyKey(name) {
  try {
    return String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  } catch (_) {
    return String(name || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
}

/**
 * Clé stable **par offre d’emploi** (job LinkedIn), pas par entreprise.
 * Sert au suivi « déjà ouvert / déjà aspiré » : deux offres chez le même client → deux clés distinctes.
 * Ordre : data-job-id → componentkey → URL (currentJobId / jobs/view) → repli position (faible).
 */
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

function normalizeTextPn(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getJobIdFromUrl(jobUrl) {
  const value = String(jobUrl || '');
  const viewMatch = value.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch?.[1]) return viewMatch[1];
  const currentMatch = value.match(/[?&]currentJobId=(\d+)/);
  if (currentMatch?.[1]) return currentMatch[1];
  return null;
}

/** Extrait le jobId depuis un componentkey type "job-card-component-ref-4387926645". */
function getJobIdFromComponentKey(el) {
  const ck = el?.getAttribute?.('componentkey') || '';
  const m = ck.match(/^job-card-component-ref-(\d+)$/);
  return m ? m[1] : null;
}

function getJobIdFromWrapper(wrapper, jobUrl = '') {
  const attrValue =
    wrapper?.getAttribute?.('data-job-id') ||
    wrapper?.getAttribute?.('data-occludable-job-id') ||
    wrapper?.dataset?.jobId ||
    wrapper?.dataset?.occludableJobId ||
    '';
  if (normalizeTextPn(attrValue)) return normalizeTextPn(attrValue);
  const ckId = getJobIdFromComponentKey(wrapper);
  if (ckId) return ckId;
  return getJobIdFromUrl(jobUrl);
}

/** @returns {string|null} Alias explicite — même clé que `dedupeKeyForCard` (par offre). */
function getDedupKeyForJobCard(wrapper) {
  return dedupeKeyForCard(wrapper);
}
