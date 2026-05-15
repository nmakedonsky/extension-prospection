/** Badges SS2I / Client — classification après scroll complet de la liste, requêtes Supabase groupées. */

const PN_CLASSIFY_CHUNK_SIZE = 10;
const PN_CLASSIFY_CHUNK_TIMEOUT_MS = 55000;
const PN_LOADING_STUCK_MS = 45000;

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

/** Aligné sur le gate auto-open (jobdesk-autoopen.js). */
function pnListAllowsClassificationNow() {
  if (typeof window.jdIsListWorkflowActive === 'function') return window.jdIsListWorkflowActive();
  if (typeof jdIsCurrentListFullyScrolled === 'function') return jdIsCurrentListFullyScrolled();
  return true;
}

function sendClassifyBatchChunk(companyNames) {
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
      finish({});
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

async function sendClassifyBatch(companyNames) {
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
  for (let i = 0; i < list.length; i += PN_CLASSIFY_CHUNK_SIZE) {
    const chunkIdx = Math.floor(i / PN_CLASSIFY_CHUNK_SIZE) + 1;
    const chunk = list.slice(i, i + PN_CLASSIFY_CHUNK_SIZE);
    if (typeof jdLog === 'function') {
      jdLog('jd_classify', { st: 'chunk', n: chunkIdx, tot: totalChunks, co: chunk.length });
    }
    const part = await sendClassifyBatchChunk(chunk);
    Object.assign(out, part);
  }
  return out;
}

function ensureBadgeOnProcessedCard(card) {
  if (!card?.hasAttribute?.(DATA_PROCESSED)) return;
  const type = card.getAttribute(DATA_TYPE);
  if (type !== 'Client' && type !== 'SS2I') return;
  if (isNodeInJobDetailsComposed(card)) return;
  const host = getBadgeHostElement(card);
  if (!host) return;
  const hasBadge = !!host.querySelector('.pn-badge');
  if (hasBadge) return;
  host.appendChild(createBadge(type));
}

function clearCardLoadingState(card) {
  if (!card) return;
  card.removeAttribute(DATA_LOADING);
  card.removeAttribute(DATA_LOADING_AT);
  const host = getBadgeHostElement(card);
  if (!host) return;
  host.querySelectorAll('.pn-badge').forEach((b) => b.remove());
}

function setCardLoadingBadge(card) {
  const hostEl = getBadgeHostElement(card);
  if (!hostEl || isNodeInJobDetailsComposed(card)) return;
  card.setAttribute(DATA_LOADING, 'true');
  card.setAttribute(DATA_LOADING_AT, String(Date.now()));
  hostEl.querySelectorAll('.pn-badge').forEach((b) => b.remove());
  hostEl.appendChild(createBadge('loading'));
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
  if (type === 'Client') {
    if (companyName) prefetchFinancialDataForClient(card, companyName);
    if (!pnSuppressClientClassifiedEvent) {
      try {
        document.dispatchEvent(new CustomEvent('pn-client-classified', { detail: { card } }));
      } catch (_) {}
    }
  }

  const el = getBadgeHostElement(card);
  if (el && !isNodeInJobDetailsComposed(card)) {
    el.querySelectorAll('.pn-badge').forEach((b) => b.remove());
    el.appendChild(createBadge(type));
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

async function runClassificationPass() {
  if (!isClassificationTargetPage()) return false;
  if (!pnListAllowsClassificationNow()) return false;
  if (classificationPassRunning) return false;

  const passStarted = performance.now();
  const cards = collectJobCards();
  /** @type {Map<string, HTMLElement[]>} */
  const byCompany = new Map();

  for (const card of cards) {
    if (card.hasAttribute(DATA_PROCESSED)) {
      ensureBadgeOnProcessedCard(card);
      continue;
    }
    if (card.hasAttribute(DATA_LOADING)) {
      if (!pnIsLoadingStuckOnCard(card)) continue;
      clearCardLoadingState(card);
    }
    const failedAt = Number(card.getAttribute(DATA_FAILED) || '0');
    if (failedAt && Date.now() - failedAt < 15000) continue;
    const cel = findCompanyElementInCard(card);
    const name = extractCompanyName(cel);
    if (!name || name.length < 2) continue;
    if (!byCompany.has(name)) byCompany.set(name, []);
    byCompany.get(name).push(card);
  }

  const companyNames = [...byCompany.keys()];
  if (!companyNames.length) return true;

  classificationPassRunning = true;
  pnSuppressClientClassifiedEvent = true;
  let passOk = false;
  if (typeof jdLog === 'function') {
    jdLog('jd_classify', { st: 'start', co: companyNames.length });
  }
  try {
    for (const cardList of byCompany.values()) {
      for (const card of cardList) {
        if (card?.isConnected) setCardLoadingBadge(card);
      }
    }

    const types = await sendClassifyBatch(companyNames);
    const missingTypes = companyNames.filter(
      (n) => types[n] !== 'Client' && types[n] !== 'SS2I'
    );

    for (const [name, cardList] of byCompany) {
      const type = types[name] === 'Client' || types[name] === 'SS2I' ? types[name] : null;
      for (const card of cardList) {
        if (card?.isConnected) applyClassificationToCard(card, type);
      }
    }

    const passMs = Math.round(performance.now() - passStarted);
    let cardCount = 0;
    for (const list of byCompany.values()) cardCount += list.length;
    passOk = missingTypes.length === 0;
    if (!passOk && typeof jdLog === 'function') {
      jdLog('jd_classify', { st: 'partial', miss: missingTypes.length, co: companyNames.length });
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
    if (!passOk || stillLoading > 0) {
      if (typeof window.jdAbortListWorkflowGate === 'function') {
        window.jdAbortListWorkflowGate(passOk ? 'loading_left' : 'classify_err');
      }
    }
    pnSuppressClientClassifiedEvent = false;
    classificationPassRunning = false;
  }
  return passOk;
}

try {
  window.pnRunClassificationPassAfterScroll = runClassificationPass;
} catch (_) {}
