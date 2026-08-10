/** Parse Voyager / BPR / DOM LinkedIn → champs saved_prospects. */

function pnNormalizeLinkedInProfileUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!s.startsWith('http')) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, '')) && !/\.linkedin\.com$/i.test(u.hostname)) {
      return null;
    }
    const m = u.pathname.match(/\/in\/([^/]+)\/?/i);
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).replace(/\/+$/, '');
    if (!slug) return null;
    return `https://www.linkedin.com/in/${slug}`;
  } catch (_) {
    return null;
  }
}

function pnLinkedInSlugFromUrl(url) {
  const m = String(url || '').match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : null;
}

function pnIsProfilePath(pathname) {
  return /^\/in\/[^/]+/i.test(String(pathname || ''));
}

function pnWalkCollect(obj, pred, out, depth, max) {
  if (!obj || depth > 12 || out.length >= max) return;
  if (Array.isArray(obj)) {
    for (const item of obj) pnWalkCollect(item, pred, out, depth + 1, max);
    return;
  }
  if (typeof obj !== 'object') return;
  if (pred(obj)) out.push(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') pnWalkCollect(v, pred, out, depth + 1, max);
  }
}

function pnTextVal(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text.replace(/\s+/g, ' ').trim();
    if (typeof v.value === 'string') return v.value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function pnPickProfileEntity(data) {
  if (!data || typeof data !== 'object') return null;
  const hits = [];
  pnWalkCollect(
    data,
    (o) => {
      const first = pnTextVal(o.firstName);
      const hasName = !!(first || pnTextVal(o.lastName) || pnTextVal(o.fullName));
      const hasHeadline = !!(pnTextVal(o.headline) || pnTextVal(o.occupation));
      const looksProfile =
        typeof o.publicIdentifier === 'string' ||
        typeof o.vanityName === 'string' ||
        (typeof o.entityUrn === 'string' && /fsd_profile|fs_miniProfile|profile/i.test(o.entityUrn));
      return !!(hasName && (hasHeadline || looksProfile || first));
    },
    hits,
    0,
    60
  );
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const sa = a.publicIdentifier || a.vanityName ? 3 : 0;
    const sb = b.publicIdentifier || b.vanityName ? 3 : 0;
    const ha = pnTextVal(a.headline).length;
    const hb = pnTextVal(b.headline).length;
    return sb - sa || hb - ha;
  });
  return hits[0];
}

/** Poste / expérience courante dans le JSON (souvent hors DOM non déroulé). */
function pnCurrentExperienceFromPayload(data) {
  if (!data) return { title: '', company: '' };
  const positions = [];
  pnWalkCollect(
    data,
    (o) => {
      const title = pnTextVal(o.title) || pnTextVal(o.headline);
      const company =
        pnTextVal(o.companyName) ||
        pnTextVal(o.company) ||
        pnTextVal(o?.companyDetails?.name) ||
        '';
      const typeHint = String(o.$type || o.entityUrn || '');
      return !!(title && company) || (/Position|Experience|profilePosition/i.test(typeHint) && !!title);
    },
    positions,
    0,
    80
  );

  function isCurrent(o) {
    const dr = o.dateRange || o.timePeriod || o.date;
    if (!dr || typeof dr !== 'object') return true;
    if (dr.end == null && dr.endDate == null) return true;
    if (dr.end === undefined && dr.endDate === undefined && (dr.start || dr.startDate)) return true;
    return false;
  }

  const current = positions.find(isCurrent) || positions[0];
  if (!current) return { title: '', company: '' };
  return {
    title: pnTextVal(current.title) || pnTextVal(current.headline) || '',
    company:
      pnTextVal(current.companyName) ||
      pnTextVal(current.company) ||
      pnTextVal(current?.companyDetails?.name) ||
      ''
  };
}

function pnCompanyFromEntity(entity, payload) {
  if (entity && typeof entity === 'object') {
    const direct =
      pnTextVal(entity.companyName) ||
      pnTextVal(entity.company) ||
      pnTextVal(entity.primaryOrganization) ||
      '';
    if (direct) return direct;
    const headline = pnTextVal(entity.headline) || pnTextVal(entity.occupation);
    const m = headline.match(/\s+(?:chez|at|@)\s+(.+)$/i);
    if (m) return m[1].replace(/\s*[|·•].*$/, '').trim();
  }
  return pnCurrentExperienceFromPayload(payload).company;
}

function pnJobTitleFromEntity(entity, payload) {
  if (entity && typeof entity === 'object') {
    const title =
      pnTextVal(entity.headline) ||
      pnTextVal(entity.occupation) ||
      pnTextVal(entity.title) ||
      '';
    if (title) {
      const m = title.match(/^(.+?)\s+(?:chez|at|@)\s+/i);
      return (m ? m[1] : title).trim();
    }
  }
  return pnCurrentExperienceFromPayload(payload).title;
}

function pnLocationFromEntity(entity, payload) {
  if (entity && typeof entity === 'object') {
    const loc =
      pnTextVal(entity.locationName) ||
      pnTextVal(entity.geoLocationName) ||
      pnTextVal(entity.location) ||
      pnTextVal(entity?.geoLocation?.geo?.defaultLocalizedName) ||
      pnTextVal(entity?.geoLocation?.defaultLocalizedName) ||
      '';
    if (loc) return loc;
  }
  const hits = [];
  pnWalkCollect(
    payload,
    (o) => !!(pnTextVal(o.defaultLocalizedName) || pnTextVal(o.geoLocationName)),
    hits,
    0,
    10
  );
  if (hits[0]) {
    return pnTextVal(hits[0].defaultLocalizedName) || pnTextVal(hits[0].geoLocationName) || '';
  }
  return '';
}

function pnFieldsFromVoyagerPayload(data, pageUrl) {
  const entity = pnPickProfileEntity(data);
  const url =
    pnNormalizeLinkedInProfileUrl(pageUrl) ||
    (entity?.publicIdentifier
      ? pnNormalizeLinkedInProfileUrl(`https://www.linkedin.com/in/${entity.publicIdentifier}`)
      : null) ||
    (entity?.vanityName
      ? pnNormalizeLinkedInProfileUrl(`https://www.linkedin.com/in/${entity.vanityName}`)
      : null);

  if (!url && !entity) {
    const exp = pnCurrentExperienceFromPayload(data);
    const page = pnNormalizeLinkedInProfileUrl(pageUrl);
    if (!page || (!exp.title && !exp.company)) return null;
    return {
      linkedin_url: page,
      linkedin_slug: pnLinkedInSlugFromUrl(page),
      first_name: null,
      last_name: null,
      full_name: null,
      job_title: exp.title || null,
      company_name: exp.company || null,
      location: null,
      email: null,
      phone: null,
      source: 'extension',
      profile_entity: null
    };
  }
  if (!url) return null;

  const first = pnTextVal(entity?.firstName);
  const last = pnTextVal(entity?.lastName);
  const full = [first, last].filter(Boolean).join(' ') || pnTextVal(entity?.fullName);

  return {
    linkedin_url: url,
    linkedin_slug: pnLinkedInSlugFromUrl(url),
    first_name: first || null,
    last_name: last || null,
    full_name: full || null,
    job_title: pnJobTitleFromEntity(entity, data) || null,
    company_name: pnCompanyFromEntity(entity, data) || null,
    location: pnLocationFromEntity(entity, data) || null,
    email: null,
    phone: null,
    source: 'extension',
    profile_entity: entity || null
  };
}

/** JSON embarqué LinkedIn (`<code id="bpr-guid-…">`) — profil hors DOM. */
function pnCollectBprCodePayloads() {
  const out = [];
  const nodes = document.querySelectorAll('code[id^="bpr-guid-"], code.bpr-guid');
  for (const node of nodes) {
    const raw = (node.textContent || '').trim();
    if (!raw || raw.length < 40) continue;
    try {
      const data = JSON.parse(raw);
      const s = JSON.stringify(data);
      if (!/publicIdentifier|fsd_profile|firstName|Profile|Experience|headline/i.test(s)) continue;
      out.push({ id: node.id || null, data });
    } catch (_) {}
  }
  return out;
}

function pnFieldsFromDom(pageUrl) {
  const url = pnNormalizeLinkedInProfileUrl(pageUrl || location.href);
  if (!url) return null;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  let h1 = '';
  const h1Candidates = [
    ...document.querySelectorAll(
      'h1, .text-heading-xlarge, [data-anonymize="person-name"], .artdeco-entity-lockup__title'
    )
  ];
  for (const el of h1Candidates) {
    const t = clean(el.textContent);
    if (t && t.length > 1 && t.length < 120 && !/linkedin/i.test(t)) {
      h1 = t;
      break;
    }
  }

  let headline = '';
  const headlineCandidates = [
    ...document.querySelectorAll(
      '.text-body-medium.break-words, .pv-text-details__left-panel .text-body-medium, [data-generated-suggestion-target] .text-body-medium, .artdeco-entity-lockup__subtitle'
    )
  ];
  for (const el of headlineCandidates) {
    const t = clean(el.textContent);
    if (t && t.length > 2 && t !== h1) {
      headline = t;
      break;
    }
  }

  let loc = '';
  const locEl = document.querySelector(
    '.text-body-small.inline.t-black--light.break-words, span.text-body-small.inline.t-black--light, .pb2 .t-black--light'
  );
  if (locEl) loc = clean(locEl.textContent);

  let company = '';
  const companyEl =
    document.querySelector('#experience ~ div .hoverable-link-text') ||
    document.querySelector('[data-field="experience_company_logo"] + div span[aria-hidden="true"]') ||
    document.querySelector(
      'button[aria-label*="Current company"], button[aria-label*="Entreprise actuelle"]'
    ) ||
    document.querySelector('a[href*="/company/"] span[aria-hidden="true"]');
  if (companyEl) company = clean(companyEl.textContent);

  let jobTitle = headline;
  const m = headline.match(/^(.+?)\s+(?:chez|at|@)\s+(.+)$/i);
  if (m) {
    jobTitle = m[1].trim();
    if (!company) company = m[2].replace(/\s*[|·•].*$/, '').trim();
  }

  const parts = h1.split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const last = parts.slice(1).join(' ') || '';

  if (!h1 && !headline) return null;

  return {
    linkedin_url: url,
    linkedin_slug: pnLinkedInSlugFromUrl(url),
    first_name: first || null,
    last_name: last || null,
    full_name: h1 || null,
    job_title: jobTitle || null,
    company_name: company || null,
    location: loc || null,
    email: null,
    phone: null,
    source: 'extension',
    profile_entity: null
  };
}

function pnSanitizeProfileJson(data, maxChars = 450000) {
  try {
    const s = JSON.stringify(data);
    if (s.length <= maxChars) return data;
    return {
      _truncated: true,
      _original_chars: s.length,
      _preview: s.slice(0, maxChars)
    };
  } catch (_) {
    return { _error: 'serialize_failed' };
  }
}

function pnBuildProfileSnapshot(captures, pageUrl) {
  return pnSanitizeProfileJson({
    captured_at: new Date().toISOString(),
    page_url: pageUrl || null,
    capture_count: captures.length,
    captures: captures.slice(0, 12).map((c) => ({
      kind: c.kind || 'voyager',
      url: c.url || null,
      at: c.at || null,
      data: c.data
    }))
  });
}
