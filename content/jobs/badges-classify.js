/** Badges SS2I / Client — classification après scroll complet de la liste, requêtes Supabase groupées. */

const PN_CLASSIFY_CHUNK_SIZE = 10;
const PN_CLASSIFY_CHUNK_TIMEOUT_MS = 55000;
const PN_LOADING_STUCK_MS = 45000;

/** Cache mémoire nom → type : re-peint les badges quand LinkedIn virtualise / recycle les cartes. */
const PN_COMPANY_TYPE_CACHE = new Map();
/** Cache mémoire nom → légitimité (lecture Supabase). */
const PN_COMPANY_LEGIT_CACHE = new Map();
const PN_LEGIT_VERDICTS = new Set(['real', 'recruiter', 'shell', 'uncertain']);

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

/** Vert = real ; orange = recruiter|uncertain ; rouge = shell. */
function pnLegitTone(verdict) {
  const v = String(verdict || '').toLowerCase();
  if (v === 'real') return 'real';
  if (v === 'shell') return 'shell';
  if (v === 'recruiter' || v === 'uncertain') return 'warn';
  return null;
}

function pnLegitTooltip(info) {
  if (!info || !info.verdict) return '';
  const p = info.payload && typeof info.payload === 'object' ? info.payload : {};
  const lines = [];
  const label =
    info.verdict === 'real'
      ? 'Employeur réel'
      : info.verdict === 'recruiter'
        ? 'Recruteur / staffing'
        : info.verdict === 'shell'
          ? 'Coquille / footprint faible'
          : 'Incertain';
  lines.push(label);
  if (info.confidence != null && info.confidence !== '') lines.push(`Confiance: ${info.confidence}%`);
  if (p.hq_country) lines.push(`HQ: ${p.hq_country}`);
  if (p.has_eu_legal_entity === true) lines.push('Entité légale EU/UK: oui');
  if (p.has_eu_legal_entity === false) lines.push('Entité légale EU/UK: non');
  if (p.official_website) lines.push(`Site: ${String(p.official_website).slice(0, 80)}`);
  if (info.india_bodyshop) lines.push('Pattern India bodyshop: oui');
  const reasons = Array.isArray(p.reasons) ? p.reasons : [];
  for (const r of reasons.slice(0, 3)) {
    const t = String(r || '').trim();
    if (t) lines.push(`• ${t.slice(0, 160)}`);
  }
  return lines.join('\n');
}

function createLegitimacyPastille(info) {
  const tone = pnLegitTone(info?.verdict);
  if (!tone) return null;
  const span = document.createElement('span');
  span.className = `pn-legit pn-legit--${tone}`;
  span.setAttribute('data-prospection-legit', '1');
  span.setAttribute('data-verdict', String(info.verdict));
  span.setAttribute('aria-label', `Légitimité: ${info.verdict}`);
  const tip = pnLegitTooltip(info);
  if (tip) span.setAttribute('title', tip);
  return span;
}

function pnRememberCompanyLegitimacy(name, info) {
  const n = String(name || '').trim();
  if (!n || !info || !PN_LEGIT_VERDICTS.has(String(info.verdict || '').toLowerCase())) return;
  const normalized = {
    verdict: String(info.verdict).toLowerCase(),
    india_bodyshop: !!info.india_bodyshop,
    confidence: info.confidence ?? null,
    payload: info.payload && typeof info.payload === 'object' ? info.payload : null,
    at: info.at || null
  };
  PN_COMPANY_LEGIT_CACHE.set(n, normalized);
  const k = typeof pnNormalizeCompanyKey === 'function' ? pnNormalizeCompanyKey(n) : '';
  if (k) PN_COMPANY_LEGIT_CACHE.set(k, normalized);
}

function pnLookupCompanyLegitimacy(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const direct = PN_COMPANY_LEGIT_CACHE.get(n);
  if (direct && PN_LEGIT_VERDICTS.has(direct.verdict)) return direct;
  const k = typeof pnNormalizeCompanyKey === 'function' ? pnNormalizeCompanyKey(n) : '';
  if (!k) return null;
  const folded = PN_COMPANY_LEGIT_CACHE.get(k);
  return folded && PN_LEGIT_VERDICTS.has(folded.verdict) ? folded : null;
}

function ensureLegitimacyPastilleOnHost(host, companyName) {
  if (!host) return;
  host.querySelectorAll('.pn-legit').forEach((b) => b.remove());
  const info = companyName ? pnLookupCompanyLegitimacy(companyName) : null;
  if (!info) return;
  const el = createLegitimacyPastille(info);
  if (el) host.appendChild(el);
}

/** Hôte du badge : nom société, sinon ligne titre, sinon la carte. */
function getBadgeHostElement(card) {
  const cel = findCompanyElementInCard(card);
  if (cel && !isNodeInJobDetailsComposed(card)) return cel;
  const title = card.querySelector?.(
    '[class*="job-card-list__title"], [class*="base-search-card__title"], [class*="job-card-container__link"], h3, h2'
  );
  if (title && !isNodeInJobDetailsComposed(title)) return title;
  return card;
}

/**
 * Badges visibles uniquement après scroll complet de la page courante,
 * ou pendant le workflow classify (déjà déclenché post-scroll, avant markFullyScrolled).
 */
function pnCanPaintBadgesNow() {
  // Pendant le scrape : toujours autoriser le re-peinture (LinkedIn recycle les cartes).
  if (typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning) {
    return true;
  }
  if (typeof jdIsCurrentListFullyScrolled === 'function' && jdIsCurrentListFullyScrolled()) {
    return true;
  }
  return (
    (typeof classificationPassRunning !== 'undefined' && classificationPassRunning) ||
    (typeof pnListWorkflowRunning !== 'undefined' && pnListWorkflowRunning)
  );
}

function pnListAllowsClassificationNow() {
  // Pendant le workflow (in-flight) ou page marquée fully scrolled.
  if (typeof window.jdIsListWorkflowActive === 'function') return window.jdIsListWorkflowActive();
  if (typeof jdIsCurrentListFullyScrolled === 'function') return jdIsCurrentListFullyScrolled();
  return false;
}

function pnRememberCompanyType(name, type) {
  const n = String(name || '').trim();
  if (!n || (type !== 'Client' && type !== 'SS2I')) return;
  PN_COMPANY_TYPE_CACHE.set(n, type);
  const k = typeof pnNormalizeCompanyKey === 'function' ? pnNormalizeCompanyKey(n) : '';
  if (k) PN_COMPANY_TYPE_CACHE.set(k, type);
}

function pnLookupCompanyType(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const direct = PN_COMPANY_TYPE_CACHE.get(n);
  if (direct === 'Client' || direct === 'SS2I') return direct;
  const k = typeof pnNormalizeCompanyKey === 'function' ? pnNormalizeCompanyKey(n) : '';
  if (!k) return null;
  const folded = PN_COMPANY_TYPE_CACHE.get(k);
  return folded === 'Client' || folded === 'SS2I' ? folded : null;
}

function sendClassifyBatchChunkOnce(companyNames) {
  return new Promise((resolve) => {
    const list = Array.isArray(companyNames) ? companyNames : [];
    if (!list.length) {
      resolve({});
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value && typeof value === 'object' ? value : {});
    };
    const timer = setTimeout(() => {
      if (typeof jdLog === 'function') {
        jdLog('jd_classify', {
          st: 'timeout',
          ms: PN_CLASSIFY_CHUNK_TIMEOUT_MS,
          co: list.length
        });
      }
      finish({ __pnTimeout: true });
    }, PN_CLASSIFY_CHUNK_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ type: 'CLASSIFY_COMPANIES_BATCH', companyNames: list }, (res) => {
        if (chrome.runtime.lastError) {
          if (typeof jdLog === 'function') {
            jdLog('jd_classify', {
              st: 'sw_err',
              m: String(chrome.runtime.lastError.message || '').slice(0, 120)
            });
          }
          finish({});
          return;
        }
        finish(res);
      });
    } catch (_) {
      finish({});
    }
  });
}

async function sendClassifyBatchChunk(companyNames) {
  const first = await sendClassifyBatchChunkOnce(companyNames);
  if (!first?.__pnTimeout) return first;
  if (typeof jdLog === 'function') {
    jdLog('jd_classify', { st: 'chunk_retry', co: (companyNames || []).length });
  }
  await new Promise((r) => setTimeout(r, 600));
  const second = await sendClassifyBatchChunkOnce(companyNames);
  if (second && typeof second === 'object') {
    const { __pnTimeout, ...rest } = second;
    return rest;
  }
  return {};
}

/** Ingère types + légitimité du SW (un seul round-trip). Retourne la map types. */
function pnIngestClassifyPayload(part) {
  if (!part || typeof part !== 'object') return {};
  const hasEnvelope = part.types != null || part.legitimacy != null;
  const types = hasEnvelope
    ? part.types && typeof part.types === 'object'
      ? part.types
      : {}
    : part;
  const legitimacy =
    hasEnvelope && part.legitimacy && typeof part.legitimacy === 'object' ? part.legitimacy : {};
  for (const [name, info] of Object.entries(legitimacy)) {
    if (info && info.verdict) pnRememberCompanyLegitimacy(name, info);
  }
  for (const [name, type] of Object.entries(types)) {
    if (name === '__pnTimeout') continue;
    if (type === 'Client' || type === 'SS2I') pnRememberCompanyType(name, type);
  }
  const out = {};
  for (const [name, type] of Object.entries(types)) {
    if (name === '__pnTimeout') continue;
    out[name] = type;
  }
  return out;
}

async function sendClassifyBatch(companyNames, opts) {
  const list = [
    ...new Set(
      (companyNames || [])
        .map((n) => String(n || '').trim())
        .filter((n) => n.length >= 2)
    )
  ];
  if (!list.length) return {};
  const out = {};
  const totalChunks = Math.ceil(list.length / PN_CLASSIFY_CHUNK_SIZE);
  const onChunk = typeof opts?.onChunk === 'function' ? opts.onChunk : null;
  for (let i = 0; i < list.length; i += PN_CLASSIFY_CHUNK_SIZE) {
    const chunkIdx = Math.floor(i / PN_CLASSIFY_CHUNK_SIZE) + 1;
    const chunk = list.slice(i, i + PN_CLASSIFY_CHUNK_SIZE);
    if (typeof jdLog === 'function') {
      jdLog('jd_classify', { st: 'chunk', n: chunkIdx, tot: totalChunks, co: chunk.length });
    }
    const part = await sendClassifyBatchChunk(chunk);
    if (part && typeof part === 'object') {
      const { __pnTimeout, ...rest } = part;
      const types = pnIngestClassifyPayload(rest);
      Object.assign(out, types);
      if (onChunk) {
        try {
          onChunk(types, { chunkIdx, totalChunks });
        } catch (_) {}
      }
    }
  }
  return out;
}

function ensureBadgeOnProcessedCard(card) {
  if (!pnCanPaintBadgesNow()) return;
  if (!card?.hasAttribute?.(DATA_PROCESSED)) return;
  const type = card.getAttribute(DATA_TYPE);
  if (type !== 'Client' && type !== 'SS2I') return;
  if (isNodeInJobDetailsComposed(card)) return;
  const host = getBadgeHostElement(card);
  if (!host) return;
  if (!host.querySelector('.pn-badge')) host.appendChild(createBadge(type));
  const name = extractCompanyName(findCompanyElementInCard(card));
  ensureLegitimacyPastilleOnHost(host, name);
}

/**
 * Re-applique les badges depuis le cache (DOM recyclé par LinkedIn).
 * Uniquement si la page courante a terminé son scroll (évite labels trop tôt).
 */
function pnRepaintVisibleBadgesFromCache() {
  if (!pnCanPaintBadgesNow()) return 0;
  if (typeof collectJobCards !== 'function') return 0;
  const cards = collectJobCards();
  let n = 0;
  for (const card of cards) {
    if (!card?.isConnected || isNodeInJobDetailsComposed(card)) continue;
    if (card.hasAttribute(DATA_PROCESSED)) {
      ensureBadgeOnProcessedCard(card);
      n += 1;
      continue;
    }
    const name = extractCompanyName(findCompanyElementInCard(card));
    const type = name ? pnLookupCompanyType(name) : null;
    if (type !== 'Client' && type !== 'SS2I') continue;
    applyClassificationToCard(card, type);
    n += 1;
  }
  return n;
}

/** Retire badges + attributs sur les cartes liste (changement de page / avant bas). */
function pnStripVisibleListBadges() {
  if (typeof collectJobCards !== 'function') return;
  for (const card of collectJobCards()) {
    if (!card?.isConnected || isNodeInJobDetailsComposed(card)) continue;
    card.removeAttribute(DATA_PROCESSED);
    card.removeAttribute(DATA_TYPE);
    card.removeAttribute(DATA_FAILED);
    card.removeAttribute(DATA_LOADING);
    card.removeAttribute(DATA_LOADING_AT);
    try {
      getBadgeHostElement(card)?.querySelectorAll('.pn-badge, .pn-legit').forEach((b) => b.remove());
    } catch (_) {}
  }
}

/**
 * Après le classify principal : s’assurer que chaque carte classifiable a un badge
 * avant de démarrer le scrape.
 * @returns {Promise<boolean>} true seulement si plus aucune carte classifiable sans badge
 */
async function pnEnsureAllVisibleBadgesPainted(opts) {
  const maxRounds = Math.max(1, Number(opts?.maxRounds) || 4);

  function countMissingClassifiable() {
    const cards = typeof collectJobCards === 'function' ? collectJobCards() : [];
    let classifiable = 0;
    let missing = 0;
    let noName = 0;
    for (const c of cards) {
      if (!c?.isConnected || isNodeInJobDetailsComposed(c)) continue;
      const host = getBadgeHostElement(c);
      const hasBadge = !!host?.querySelector?.('.pn-badge:not(.pn-badge--loading)');
      const type = c.getAttribute(DATA_TYPE);
      if (
        c.hasAttribute(DATA_PROCESSED) &&
        (type === 'Client' || type === 'SS2I') &&
        hasBadge
      ) {
        classifiable += 1;
        continue;
      }
      const name = extractCompanyName(findCompanyElementInCard(c));
      if (!name || name.length < 2) {
        // Sans nom : ne bloque pas le scrape (carte encore hydratée / pub).
        noName += 1;
        continue;
      }
      classifiable += 1;
      // DATA_FAILED / sans badge = encore manquant (retry), pas un « OK ».
      if (!hasBadge) missing += 1;
    }
    return { cards: cards.length, classifiable, missing, noName };
  }

  function clearFailedForRetry() {
    const cards = typeof collectJobCards === 'function' ? collectJobCards() : [];
    for (const c of cards) {
      if (!c?.hasAttribute?.(DATA_FAILED)) continue;
      const name = extractCompanyName(findCompanyElementInCard(c));
      if (name && name.length >= 2) c.removeAttribute(DATA_FAILED);
    }
  }

  let lastMissing = -1;
  for (let round = 0; round < maxRounds; round++) {
    pnRepaintVisibleBadgesFromCache();
    const stats = countMissingClassifiable();
    if (typeof jdLog === 'function') {
      jdLog('jd_classify', {
        st: 'badges_gate',
        round,
        cards: stats.cards,
        miss: stats.missing,
        ok: stats.classifiable - stats.missing,
        noname: stats.noName
      });
    }
    if (stats.missing === 0) return true;

    if (stats.missing === lastMissing && round > 0) {
      if (!classificationPassRunning) {
        clearFailedForRetry();
        await runClassificationPass({ settle: false });
      }
      pnRepaintVisibleBadgesFromCache();
      const again = countMissingClassifiable();
      if (typeof jdLog === 'function') {
        jdLog('jd_classify', {
          st: 'badges_gate_stuck',
          miss: again.missing,
          cards: again.cards
        });
      }
      if (again.missing === 0) return true;
      // Encore des trous : attendre un peu (rate-limit Gemini) puis continuer les rounds.
      await new Promise((r) => setTimeout(r, 700));
    }
    lastMissing = stats.missing;

    if (!classificationPassRunning) {
      if (round > 0) clearFailedForRetry();
      await runClassificationPass({ settle: false });
    }
    await new Promise((r) => setTimeout(r, 320));
  }
  pnRepaintVisibleBadgesFromCache();
  const finalStats = countMissingClassifiable();
  if (typeof jdLog === 'function') {
    jdLog('jd_classify', {
      st: 'badges_gate_timeout',
      miss: finalStats.missing,
      cards: finalStats.cards
    });
  }
  return finalStats.missing === 0;
}

function clearCardLoadingState(card) {
  if (!card) return;
  card.removeAttribute(DATA_LOADING);
  card.removeAttribute(DATA_LOADING_AT);
  const host = getBadgeHostElement(card);
  if (!host) return;
  host.querySelectorAll('.pn-badge').forEach((b) => b.remove());
}

function applyClassificationToCard(card, type) {
  const hostEl = getBadgeHostElement(card);
  if (!hostEl || isNodeInJobDetailsComposed(card)) return;

  hostEl.querySelectorAll('.pn-badge').forEach((b) => b.remove());
  card.removeAttribute(DATA_LOADING);
  card.removeAttribute(DATA_LOADING_AT);

  if (!type) {
    card.setAttribute(DATA_FAILED, String(Date.now()));
    return;
  }

  card.setAttribute(DATA_PROCESSED, 'true');
  card.setAttribute(DATA_TYPE, type);
  card.removeAttribute(DATA_FAILED);

  const companyName = extractCompanyName(findCompanyElementInCard(card));
  if (companyName) pnRememberCompanyType(companyName, type);
  if (typeof pnIsAspirableEmployerType === 'function' ? pnIsAspirableEmployerType(type) : type === 'Client') {
    // Enfile pour auto-open / scrape (Client + SS2I). Prefetch financier reste Client-only au scrape.
    if (!pnSuppressClientClassifiedEvent) {
      try {
        document.dispatchEvent(new CustomEvent('pn-client-classified', { detail: { card, type } }));
      } catch (_) {}
    }
  }

  // Peinture visuelle seulement après fin de scroll de la page courante.
  if (!pnCanPaintBadgesNow()) return;

  const el = getBadgeHostElement(card);
  if (el && !isNodeInJobDetailsComposed(card)) {
    el.querySelectorAll('.pn-badge').forEach((b) => b.remove());
    el.appendChild(createBadge(type));
    ensureLegitimacyPastilleOnHost(el, companyName);
  }
}

/** Pendant le batch post-scroll : pas d’événements qui relancent l’auto-open. */
let pnSuppressClientClassifiedEvent = false;

let classificationPassRunning = false;

function pnIsLoadingStuckOnCard(card) {
  if (!card?.hasAttribute?.(DATA_LOADING)) return false;
  const at = Number(card.getAttribute(DATA_LOADING_AT) || '0');
  return !at || Date.now() - at >= PN_LOADING_STUCK_MS;
}

/**
 * Attend que la hauteur de liste se stabilise en bas (LinkedIn charge encore des cartes).
 * Évite de classer trop tôt → badges seulement en haut.
 */
async function pnWaitForListScrollStable(maxWaitMs = 900) {
  const stepMs = 180;
  const start = Date.now();
  let lastH = -1;
  let stableRounds = 0;
  while (Date.now() - start < maxWaitMs) {
    if (typeof jdHasReachedBottomForCurrentList === 'function' && !jdHasReachedBottomForCurrentList()) {
      stableRounds = 0;
    }
    let h = 0;
    try {
      const root =
        typeof jdGetLikelyJobsListScrollRoot === 'function' ? jdGetLikelyJobsListScrollRoot() : null;
      h = root ? root.scrollHeight : 0;
    } catch (_) {}
    if (h > 0 && Math.abs(h - lastH) <= 8) {
      stableRounds += 1;
      if (stableRounds >= 2) return true;
    } else {
      stableRounds = 0;
      lastH = h;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return typeof jdHasReachedBottomForCurrentList === 'function'
    ? jdHasReachedBottomForCurrentList()
    : true;
}

async function runClassificationPass(opts) {
  if (!isClassificationTargetPage()) return false;
  if (!pnListAllowsClassificationNow()) return false;
  if (classificationPassRunning) return false;

  const settle = opts?.settle !== false;
  if (settle) {
    await pnWaitForListScrollStable();
    if (!pnListAllowsClassificationNow()) return false;
    if (typeof jdHasReachedBottomForCurrentList === 'function' && !jdHasReachedBottomForCurrentList()) {
      if (typeof jdLog === 'function') jdLog('jd_classify', { st: 'skip_not_bottom' });
      return false;
    }
  }

  const passStarted = performance.now();
  const cards = collectJobCards();
  /** @type {Map<string, HTMLElement[]>} */
  const byCompany = new Map();
  let processedOnPage = 0;
  let paintedFromCache = 0;

  for (const card of cards) {
    if (card.hasAttribute(DATA_PROCESSED)) {
      const t = card.getAttribute(DATA_TYPE);
      if (t === 'Client' || t === 'SS2I') {
        processedOnPage += 1;
        ensureBadgeOnProcessedCard(card);
        continue;
      }
    }
    if (card.hasAttribute(DATA_LOADING)) {
      if (!pnIsLoadingStuckOnCard(card)) continue;
      clearCardLoadingState(card);
    }
    const failedAt = Number(card.getAttribute(DATA_FAILED) || '0');
    // Retry plus tôt : un échec Gemini/timeout ne doit pas laisser des trous durables.
    if (failedAt && Date.now() - failedAt < 6000) continue;
    if (failedAt) card.removeAttribute(DATA_FAILED);
    const cel = findCompanyElementInCard(card);
    const name = extractCompanyName(cel);
    if (!name || name.length < 2) continue;

    const cached = pnLookupCompanyType(name);
    if (cached === 'Client' || cached === 'SS2I') {
      // Différé : on peindra tout d’un coup avec le reste du batch.
      if (!byCompany.has(name)) byCompany.set(name, []);
      byCompany.get(name).push(card);
      paintedFromCache += 1;
      continue;
    }

    if (!byCompany.has(name)) byCompany.set(name, []);
    byCompany.get(name).push(card);
  }

  const companyNames = [...byCompany.keys()].filter((n) => !pnLookupCompanyType(n));
  const allNamesInPass = [...byCompany.keys()];

  // Batch unique : type manquant OU légitimité manquante (évite 2e round-trip LEGITIMACY_*).
  const namesForBatch = [
    ...new Set(
      [...allNamesInPass].filter((n) => !pnLookupCompanyType(n) || !pnLookupCompanyLegitimacy(n))
    )
  ];

  // Noms déjà traités sur la page (pastilles si backfill dispo).
  const processedNames = [];
  for (const card of cards) {
    if (!card.hasAttribute(DATA_PROCESSED)) continue;
    const n = extractCompanyName(findCompanyElementInCard(card));
    if (n && n.length >= 2 && !pnLookupCompanyLegitimacy(n)) processedNames.push(n);
  }
  for (const n of processedNames) {
    if (!namesForBatch.includes(n)) namesForBatch.push(n);
  }

  if (!allNamesInPass.length) {
    if (!cards.length) {
      if (typeof jdLog === 'function') {
        jdLog('jd_classify', { st: 'skip_no_cards' });
      }
      return false;
    }
    // Ne pas valider s’il reste des cartes nommées sans badge (échecs récents / virtualisation).
    let namedGaps = 0;
    for (const card of cards) {
      if (!card?.isConnected || isNodeInJobDetailsComposed(card)) continue;
      const host = getBadgeHostElement(card);
      if (host?.querySelector?.('.pn-badge:not(.pn-badge--loading)')) continue;
      const name = extractCompanyName(findCompanyElementInCard(card));
      if (!name || name.length < 2) continue;
      namedGaps += 1;
    }
    if (processedOnPage > 0 && namedGaps === 0) {
      if (namesForBatch.length) {
        await sendClassifyBatch(namesForBatch);
        pnRepaintVisibleBadgesFromCache();
      }
      return true;
    }
    if (typeof jdLog === 'function') {
      jdLog('jd_classify', {
        st: namedGaps ? 'skip_gaps_cooling' : 'skip_no_companies',
        cards: cards.length,
        gaps: namedGaps
      });
    }
    return namedGaps === 0 && processedOnPage > 0;
  }

  classificationPassRunning = true;
  pnSuppressClientClassifiedEvent = true;
  let passOk = false;
  if (typeof jdLog === 'function') {
    jdLog('jd_classify', {
      st: 'start',
      co: companyNames.length,
      batch: namesForBatch.length,
      cache: paintedFromCache
    });
  }
  try {
    // Peindre progressivement dès qu’un chunk a type (+ légitimité dans le même payload).
    const paintKnown = (typesMap) => {
      let painted = 0;
      for (const [name, cardList] of byCompany) {
        const type =
          typesMap?.[name] === 'Client' || typesMap?.[name] === 'SS2I'
            ? typesMap[name]
            : pnLookupCompanyType(name);
        if (type !== 'Client' && type !== 'SS2I') continue;
        for (const card of cardList) {
          if (card?.isConnected) {
            applyClassificationToCard(card, type);
            painted += 1;
          }
        }
      }
      pnRepaintVisibleBadgesFromCache();
      return painted;
    };

    // Cache mémoire immédiat (entreprises déjà vues — pastille si déjà en cache).
    paintKnown({});

    let types = namesForBatch.length
      ? await sendClassifyBatch(namesForBatch, {
          onChunk: (part) => {
            paintKnown(part);
          }
        })
      : {};
    for (const [name, type] of Object.entries(types)) {
      if (type === 'Client' || type === 'SS2I') pnRememberCompanyType(name, type);
    }

    let missingTypes = companyNames.filter(
      (n) => types[n] !== 'Client' && types[n] !== 'SS2I' && !pnLookupCompanyType(n)
    );
    // Un chunk timeout / 429 laisse des trous : 1 retry ciblé avant d’abandonner.
    if (missingTypes.length) {
      if (typeof jdLog === 'function') {
        jdLog('jd_classify', { st: 'retry_miss', miss: missingTypes.length });
      }
      await new Promise((r) => setTimeout(r, 450));
      const retryTypes = await sendClassifyBatch(missingTypes, {
        onChunk: (part) => {
          for (const [name, type] of Object.entries(part || {})) {
            if (type === 'Client' || type === 'SS2I') {
              types[name] = type;
              pnRememberCompanyType(name, type);
            }
          }
          paintKnown(part);
        }
      });
      for (const [name, type] of Object.entries(retryTypes)) {
        if (type === 'Client' || type === 'SS2I') {
          types[name] = type;
          pnRememberCompanyType(name, type);
        }
      }
      missingTypes = companyNames.filter(
        (n) => types[n] !== 'Client' && types[n] !== 'SS2I' && !pnLookupCompanyType(n)
      );
    }

    const paint = () => {
      for (const [name, cardList] of byCompany) {
        const type =
          types[name] === 'Client' || types[name] === 'SS2I'
            ? types[name]
            : pnLookupCompanyType(name);
        const resolved = type === 'Client' || type === 'SS2I' ? type : null;
        for (const card of cardList) {
          if (card?.isConnected) applyClassificationToCard(card, resolved);
        }
      }
      pnRepaintVisibleBadgesFromCache();
    };
    if (typeof requestAnimationFrame === 'function') {
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          paint();
          resolve();
        });
      });
    } else {
      paint();
    }

    const passMs = Math.round(performance.now() - passStarted);
    let cardCount = 0;
    for (const list of byCompany.values()) cardCount += list.length;
    passOk = missingTypes.length === 0;
    if (!passOk && typeof jdLog === 'function') {
      jdLog('jd_classify', {
        st: 'partial',
        miss: missingTypes.length,
        co: companyNames.length,
        sample: missingTypes.slice(0, 5)
      });
    }
    if (typeof jdLog === 'function') {
      jdLog('jd_classify', { st: 'done', co: companyNames.length, cards: cardCount, ms: passMs });
    }
    if (typeof pnRecordClassificationPass === 'function') {
      pnRecordClassificationPass(passMs, cardCount);
    }
  } catch (e) {
    if (typeof jdLog === 'function') {
      jdLog('jd_classify', {
        st: 'err',
        m: String(e?.message || e).slice(0, 120)
      });
    }
  } finally {
    let stillLoading = 0;
    for (const cardList of byCompany.values()) {
      for (const card of cardList) {
        if (card?.isConnected && card.hasAttribute(DATA_LOADING)) {
          stillLoading += 1;
          applyClassificationToCard(card, null);
        }
      }
    }
    // Pendant le workflow liste, ne pas abort ici : list-workflow + ensure badges gèrent les retries.
    if (
      (!passOk || stillLoading > 0) &&
      (typeof pnListWorkflowRunning === 'undefined' || !pnListWorkflowRunning)
    ) {
      if (typeof window.jdAbortListWorkflowGate === 'function') {
        window.jdAbortListWorkflowGate(passOk ? 'loading_left' : 'classify_err');
      }
    }
    pnSuppressClientClassifiedEvent = false;
    classificationPassRunning = false;
  }
  return passOk;
}

/**
 * Après fully-scrolled : rattrape les cartes sans badge (virtualisation / échec partiel).
 * @returns {Promise<number>} nombre de cartes encore sans badge après tentative
 */
let __pnCatchUpMissingRunning = false;
async function pnCatchUpMissingBadges() {
  if (__pnCatchUpMissingRunning) return 0;
  if (!pnCanPaintBadgesNow()) return 0;
  if (classificationPassRunning) return 0;
  if (typeof pnListWorkflowRunning !== 'undefined' && pnListWorkflowRunning) return 0;
  if (typeof collectJobCards !== 'function') return 0;

  const cards = collectJobCards();
  let gaps = 0;
  for (const card of cards) {
    if (!card?.isConnected || isNodeInJobDetailsComposed(card)) continue;
    const host = getBadgeHostElement(card);
    if (host?.querySelector?.('.pn-badge:not(.pn-badge--loading)')) continue;
    const name = extractCompanyName(findCompanyElementInCard(card));
    if (!name || name.length < 2) continue;
    const cached = pnLookupCompanyType(name);
    if (cached) {
      applyClassificationToCard(card, cached);
      continue;
    }
    if (card.hasAttribute(DATA_PROCESSED)) {
      ensureBadgeOnProcessedCard(card);
      if (host?.querySelector?.('.pn-badge:not(.pn-badge--loading)')) continue;
    }
    gaps += 1;
  }
  if (!gaps) return 0;

  __pnCatchUpMissingRunning = true;
  try {
    if (typeof jdLog === 'function') jdLog('jd_classify', { st: 'catchup', gaps });
    await runClassificationPass({ settle: false });
    pnRepaintVisibleBadgesFromCache();
    let left = 0;
    for (const card of collectJobCards()) {
      if (!card?.isConnected || isNodeInJobDetailsComposed(card)) continue;
      const host = getBadgeHostElement(card);
      if (host?.querySelector?.('.pn-badge:not(.pn-badge--loading)')) continue;
      const name = extractCompanyName(findCompanyElementInCard(card));
      if (name && name.length >= 2) left += 1;
    }
    return left;
  } finally {
    __pnCatchUpMissingRunning = false;
  }
}

try {
  window.pnRunClassificationPassAfterScroll = runClassificationPass;
  window.pnRepaintVisibleBadgesFromCache = pnRepaintVisibleBadgesFromCache;
  window.pnEnsureAllVisibleBadgesPainted = pnEnsureAllVisibleBadgesPainted;
  window.pnStripVisibleListBadges = pnStripVisibleListBadges;
  window.pnCanPaintBadgesNow = pnCanPaintBadgesNow;
  window.pnCatchUpMissingBadges = pnCatchUpMissingBadges;
} catch (_) {}
