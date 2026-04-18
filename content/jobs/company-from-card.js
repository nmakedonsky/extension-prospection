/** Extraction nom société depuis une carte offre. */

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
