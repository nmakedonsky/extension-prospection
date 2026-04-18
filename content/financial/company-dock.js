/** Nom société / contexte depuis une carte (aligné jobs-page). */

function extractCompanyNameDock(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll?.('.pn-badge').forEach((n) => n.remove());
  return String(clone.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoiseCompanyTextDock(t) {
  const s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 2) return true;
  if (/Sponsorisé|Consulté|Enregistré/i.test(s)) return true;
  if (/Publiée le|il y a \d|weeks? ago|days? ago|mois|semaines?|jour/i.test(s)) return true;
  if (/€\s*K\/yr|€\/yr|\$\s*K/i.test(s)) return true;
  return false;
}

function findCompanyElementInCardDock(card) {
  if (!card?.querySelector) return null;
  const linked =
    card.querySelector(':scope a[href*="/company/"]') || card.querySelector('a[href*="/company/"]');
  if (linked) return linked;
  const classic = card.querySelector(
    '[class*="artdeco-entity-lockup__subtitle"], [class*="company-name"], [class*="job-card-container__company-name"], [class*="job-card-container__primary-description"], [class*="job-card-list__subtitle"]'
  );
  if (classic) return classic;
  const ps = Array.from(card.querySelectorAll(':scope p')).filter(
    (p) => !isNoiseCompanyTextDock(p.textContent)
  );
  if (ps.length >= 2) return ps[1];
  if (ps.length === 1) return ps[0];
  return null;
}

function getJobInfoFromWrapper(wrapper) {
  const link = wrapper.querySelector(JOB_LINK_TITLE_SEL);
  let titleEl = wrapper.querySelector(
    '[class*="base-search-card__title"], [class*="job-card-list__title"], a[href*="/jobs/"]'
  );
  if (!titleEl) {
    const firstP = wrapper.querySelector('p');
    if (firstP) titleEl = firstP;
  }
  let jobUrl = link ? String(link.href || '').trim() : '';
  if (!jobUrl) {
    const dj =
      wrapper.getAttribute?.('data-job-id') ||
      wrapper.getAttribute?.('data-occludable-job-id') ||
      '';
    if (dj) {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('currentJobId', dj);
        jobUrl = u.toString();
      } catch (_) {}
    }
  }
  return {
    jobTitle: titleEl ? String(titleEl.textContent || '').trim().slice(0, 200) : '',
    jobUrl
  };
}
