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

/** Titres de sections LinkedIn (FR/EN) — pas un nom de personne. */
const PN_PROFILE_SECTION_TITLES =
  /^(l['’]essentiel|infos|à propos|about|sélection|featured|activit[eé]|activity|exp[eé]rience|experience|formation|education|b[eé]n[eé]volat|volunteering|comp[eé]tences|skills|int[eé]r[eê]ts|interests|recommandations?|recommendations?|distinctions?|honors?|langues|languages|certifications?|licenses?|projets?|projects?|publications?)$/i;

const PN_PROFILE_DEGREE_LINE = /^[·•.\s]*\d+\s*(er|e|ème|eme|st|nd|rd|th)?\s*$/i;
const PN_PROFILE_NOISE_LINE =
  /^(coordonn[eé]es|contact\s*info|message|plus|suivre|se connecter|en attente|relations?\b|abonn[eé]s?\b|voir\b|afficher\b|je recrute|envoyer|dire bonjour|ouvrir|fermer)/i;
const PN_PROFILE_SUBSCRIBERS = /\b\d[\d\s.,]*\s*abonn/i;

/**
 * UI LinkedIn 2025+ : classes hashées, nom en h2, top card = lignes de texte.
 * Ne dépend plus de .text-heading-xlarge / .text-body-medium.
 */
function pnFieldsFromDom(pageUrl) {
  const url = pnNormalizeLinkedInProfileUrl(pageUrl || location.href);
  if (!url) return null;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;

  let fullName = '';
  const nameEl = [...main.querySelectorAll('h1, h2')].find((h) => {
    const t = clean(h.textContent);
    return t.length >= 2 && t.length < 100 && !PN_PROFILE_SECTION_TITLES.test(t) && !/linkedin/i.test(t);
  });
  if (nameEl) fullName = clean(nameEl.textContent);

  // Fallback anciens sélecteurs
  if (!fullName) {
    for (const el of document.querySelectorAll(
      '.text-heading-xlarge, [data-anonymize="person-name"], .artdeco-entity-lockup__title'
    )) {
      const t = clean(el.textContent);
      if (t && t.length > 1 && t.length < 120 && !/linkedin/i.test(t)) {
        fullName = t;
        break;
      }
    }
  }

  // Monter jusqu’à une carte avec assez de lignes (nom + headline + lieu + …)
  let card = nameEl;
  let lines = [];
  for (let i = 0; i < 16 && card; i++) {
    const candidate = (card.innerText || '')
      .split('\n')
      .map((s) => clean(s))
      .filter(Boolean);
    if (candidate.length >= 4 && candidate.length <= 40) {
      lines = candidate;
    }
    if (candidate.length > 40) break;
    card = card.parentElement;
  }

  let headline = '';
  let loc = '';
  let company = '';

  if (lines.length) {
    let i = 0;
    if (fullName && clean(lines[0]) === fullName) i = 1;
    else if (!fullName && lines[0] && !PN_PROFILE_SECTION_TITLES.test(lines[0])) {
      fullName = lines[0];
      i = 1;
    }
    while (i < lines.length && (PN_PROFILE_DEGREE_LINE.test(lines[i]) || lines[i] === '·' || lines[i] === '•')) {
      i += 1;
    }
    if (i < lines.length && !PN_PROFILE_NOISE_LINE.test(lines[i]) && !PN_PROFILE_SUBSCRIBERS.test(lines[i])) {
      headline = lines[i];
      i += 1;
    }
    while (i < lines.length && (lines[i] === '·' || lines[i] === '•')) i += 1;
    if (
      i < lines.length &&
      !PN_PROFILE_NOISE_LINE.test(lines[i]) &&
      !PN_PROFILE_SUBSCRIBERS.test(lines[i]) &&
      lines[i].length < 80
    ) {
      loc = lines[i];
      i += 1;
    }
    while (i < lines.length) {
      const t = lines[i];
      i += 1;
      if (PN_PROFILE_NOISE_LINE.test(t) || t === '·' || t === '•') continue;
      if (PN_PROFILE_SUBSCRIBERS.test(t)) break;
      if (/relations?\s+en\s+commun/i.test(t)) break;
      // « Capgemini · Grenoble… » (bandeau recrutement)
      const hiring = t.match(/^(.+?)\s*[·•|]\s+.+$/);
      if (hiring && /grenoble|paris|lyon|hybride|remote| Distanc|sur site|télétravail/i.test(t)) {
        company = clean(hiring[1]);
        break;
      }
      if (t.length >= 2 && t.length < 90 && t !== headline && t !== loc && t !== fullName) {
        company = t;
        break;
      }
    }
  }

  // Anciens sélecteurs headline / lieu si lignes incomplètes
  if (!headline) {
    for (const el of document.querySelectorAll(
      '.text-body-medium.break-words, .pv-text-details__left-panel .text-body-medium, .artdeco-entity-lockup__subtitle'
    )) {
      const t = clean(el.textContent);
      if (t && t.length > 2 && t !== fullName) {
        headline = t;
        break;
      }
    }
  }
  if (!loc) {
    const locEl = document.querySelector(
      '.text-body-small.inline.t-black--light.break-words, span.text-body-small.inline.t-black--light, .pb2 .t-black--light'
    );
    if (locEl) loc = clean(locEl.textContent);
  }

  // Société : texte « Capgemini » dans la top card, sinon 1er lien /company/ sous « Expérience »
  if (!company) {
    const expH = [...main.querySelectorAll('h2, h3')].find((h) =>
      /^exp[eé]rience$|^experience$/i.test(clean(h.textContent))
    );
    const expTop = expH?.getBoundingClientRect?.().top ?? Infinity;
    const underExp = [...main.querySelectorAll('a[href*="/company/"]')]
      .map((a) => ({
        text: clean(a.textContent),
        y: a.getBoundingClientRect().top
      }))
      .filter((x) => x.text && x.text.length >= 2 && x.text.length < 80 && x.y >= expTop - 8)
      .sort((a, b) => a.y - b.y);
    if (underExp[0]) company = underExp[0].text;
  }
  if (!company) {
    // Dernier recours : lien /company/ le plus répété dans le viewport haut
    const nameTop = nameEl?.getBoundingClientRect?.().top ?? 0;
    const counts = new Map();
    for (const a of main.querySelectorAll('a[href*="/company/"]')) {
      const y = a.getBoundingClientRect().top;
      if (y < nameTop - 20 || y > nameTop + 900) continue;
      const t = clean(a.textContent);
      if (!t || t.length >= 80) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    let best = '';
    let bestN = 0;
    for (const [name, n] of counts) {
      if (n > bestN) {
        best = name;
        bestN = n;
      }
    }
    if (bestN >= 2) company = best;
  }

  let jobTitle = headline;
  const m = headline.match(/^(.+?)\s+(?:chez|at|@)\s+(.+)$/i);
  if (m) {
    jobTitle = m[1].trim();
    if (!company) company = m[2].replace(/\s*[|·•].*$/, '').trim();
  }

  const parts = fullName.split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const last = parts.slice(1).join(' ') || '';

  if (!fullName && !headline) return null;

  return {
    linkedin_url: url,
    linkedin_slug: pnLinkedInSlugFromUrl(url),
    first_name: first || null,
    last_name: last || null,
    full_name: fullName || null,
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

/**
 * Extrait un JSON riche depuis le DOM (indépendant de Voyager).
 * Sections : about, expérience, formation, compétences, etc.
 */
function pnExtractDomProfileRich(pageUrl) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main') || document.body;
  const fields = typeof pnFieldsFromDom === 'function' ? pnFieldsFromDom(pageUrl) : null;

  const SECTION_ALIASES = {
    about: /^(infos|à propos|about)$/i,
    experience: /^(exp[eé]rience|experience)$/i,
    education: /^(formation|education)$/i,
    skills: /^(comp[eé]tences|skills)$/i,
    activity: /^(activit[eé]|activity)$/i,
    volunteering: /^(b[eé]n[eé]volat|volunteering)$/i,
    featured: /^(sélection|featured)$/i,
    languages: /^(langues|languages)$/i,
    certifications: /^(certifications?|licenses?|licences?)$/i
  };

  function sectionRoot(headingEl) {
    let root = headingEl?.parentElement || null;
    for (let i = 0; i < 8 && root; i++) {
      const t = (root.innerText || '').trim();
      if (t.length > 60 && t.length < 12000) return root;
      root = root.parentElement;
    }
    return headingEl?.parentElement || null;
  }

  function linesFrom(el, maxLines = 80) {
    if (!el) return [];
    return (el.innerText || '')
      .split('\n')
      .map((s) => clean(s))
      .filter(Boolean)
      .slice(0, maxLines);
  }

  const sections = {};
  for (const h of main.querySelectorAll('h2, h3')) {
    const title = clean(h.textContent);
    if (!title || title.length > 48) continue;
    let key = null;
    for (const [k, re] of Object.entries(SECTION_ALIASES)) {
      if (re.test(title)) {
        key = k;
        break;
      }
    }
    if (!key || sections[key]) continue;
    const root = sectionRoot(h);
    const lines = linesFrom(root, 100);
    // drop the section title itself
    const bodyLines = lines[0] && SECTION_ALIASES[key].test(lines[0]) ? lines.slice(1) : lines;
    const text = bodyLines.join('\n').slice(0, 6000);
    if (text.length < 8) continue;
    sections[key] = { title, text, lines: bodyLines.slice(0, 60) };
  }

  // Expériences structurées approximatives depuis les lignes
  const experiences = [];
  if (sections.experience?.lines?.length) {
    const L = sections.experience.lines;
    let cur = null;
    const DATE =
      /\b(janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|aujourd|present|actuel|\d{4})\b/i;
    for (const line of L) {
      if (/^voir\b|^afficher\b/i.test(line)) continue;
      if (DATE.test(line) && cur) {
        cur.date_range = line;
        continue;
      }
      if (/·|CDI|CDD|Stage|Freelance|Temps plein|Full-time|Internship/i.test(line) && cur && !cur.meta) {
        cur.meta = line;
        continue;
      }
      // Nouveau poste probable : ligne courte sans trop de ponctuation narrative
      if (line.length < 90 && !/^à\s|^au\s|^en\s/i.test(line)) {
        if (cur && (cur.title || cur.company)) experiences.push(cur);
        cur = { title: line, company: null, meta: null, date_range: null, location: null };
        continue;
      }
      if (cur && !cur.company && line.length < 80) cur.company = line;
      else if (cur && !cur.location && line.length < 80) cur.location = line;
    }
    if (cur && (cur.title || cur.company)) experiences.push(cur);
  }

  const education = [];
  if (sections.education?.lines?.length) {
    const L = sections.education.lines;
    let cur = null;
    for (const line of L) {
      if (/^voir\b|^afficher\b/i.test(line)) continue;
      if (!cur) {
        cur = { school: line, degree: null, date_range: null };
        continue;
      }
      if (/\b(20\d{2}|19\d{2})\b/.test(line)) {
        cur.date_range = line;
        education.push(cur);
        cur = null;
      } else if (!cur.degree && line.length < 120) {
        cur.degree = line;
      } else {
        education.push(cur);
        cur = { school: line, degree: null, date_range: null };
      }
    }
    if (cur) education.push(cur);
  }

  const companyLinks = [...main.querySelectorAll('a[href*="/company/"]')]
    .map((a) => ({
      name: clean(a.textContent),
      href: String(a.getAttribute('href') || '').split('?')[0]
    }))
    .filter((x) => x.name && x.name.length < 90)
    .slice(0, 20);

  // dédup liens
  const seenCo = new Set();
  const companies = [];
  for (const c of companyLinks) {
    const k = c.href || c.name.toLowerCase();
    if (seenCo.has(k)) continue;
    seenCo.add(k);
    companies.push(c);
  }

  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    page_url: pageUrl || location.href || null,
    source: 'extension_dom',
    top_card: fields
      ? {
          full_name: fields.full_name,
          first_name: fields.first_name,
          last_name: fields.last_name,
          job_title: fields.job_title,
          company_name: fields.company_name,
          location: fields.location,
          linkedin_url: fields.linkedin_url,
          linkedin_slug: fields.linkedin_slug
        }
      : null,
    about: sections.about?.text || null,
    experience: experiences.slice(0, 20),
    education: education.slice(0, 15),
    skills: sections.skills?.lines?.slice(0, 40) || null,
    activity_preview: sections.activity?.text?.slice(0, 1500) || null,
    volunteering_preview: sections.volunteering?.text?.slice(0, 1200) || null,
    featured_preview: sections.featured?.text?.slice(0, 1200) || null,
    companies_mentioned: companies,
    sections_raw: {
      about: sections.about?.text || null,
      experience: sections.experience?.text?.slice(0, 5000) || null,
      education: sections.education?.text?.slice(0, 3000) || null
    }
  };
}

/**
 * Snapshot complet : DOM riche + captures Voyager/BPR si présentes.
 */
function pnBuildProfileSnapshot(captures, pageUrl) {
  const dom = pnExtractDomProfileRich(pageUrl);
  const voyager = Array.isArray(captures) && captures.length
    ? captures.slice(0, 12).map((c) => ({
        kind: c.kind || 'voyager',
        url: c.url || null,
        at: c.at || null,
        data: c.data
      }))
    : [];
  return pnSanitizeProfileJson({
    ...dom,
    capture_count: voyager.length,
    voyager_captures: voyager.length ? voyager : undefined
  });
}
