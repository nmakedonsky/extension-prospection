/**
 * Clics automatiques sur offres « Client » (liste) pour ouvrir la Jobdesk et déclencher l’aspiration.
 * Dédup par offre (dedupeKeyForCard), délais aléatoires, batch Supabase pour éviter les re-clics inutiles.
 */

const AUTO_OPEN_VIEWPORT_MARGIN_PX = 140;
const AUTO_OPEN_MIN_GAP_MS = 900;
const AUTO_OPEN_AFTER_CLIENT_MS = 700;
const MAX_CLIENT_AUTO_OPEN_QUEUE = 400;

const autoOpenedClientJobKeys = new Set();
const clientJobOpenQueueOrder = [];
const clientJobOpenQueueSet = new Set();

function randomDelayMsBetweenClientClicks() {
  return Math.round(800 + Math.random() * 1400);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Onglet au premier plan : pas de clics auto en arrière-plan (comportement + économie timers). */
function pnTabVisibleForAutoOpen() {
  try {
    return document.visibilityState === 'visible';
  } catch (_) {
    return true;
  }
}

/** Attente entre deux clics ; s’interrompt si l’utilisateur change d’onglet. */
async function sleepBetweenClicksOrUntilHidden(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!pnTabVisibleForAutoOpen()) return false;
    await sleep(Math.min(220, ms - (Date.now() - t0)));
  }
  return pnTabVisibleForAutoOpen();
}

function isJobCardIntersectingViewport(el, verticalMargin = 0) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const pad = 8;
  const m = verticalMargin;
  return r.bottom > pad - m && r.top < vh - pad + m && r.right > pad && r.left < vw - pad;
}

function getVisibleClientJobCardsTopToBottom() {
  const all = querySelectorAllDeep(document, `[${DATA_PROCESSED}][${DATA_TYPE}="Client"]`).filter(
    (w) => typeof isJobCardInListColumn === 'function' && isJobCardInListColumn(w)
  );
  const visible = all.filter((w) => isJobCardIntersectingViewport(w, AUTO_OPEN_VIEWPORT_MARGIN_PX));
  visible.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return visible;
}

function isJobsListSpaPath() {
  try {
    const p = location.pathname || '';
    return p.includes('/jobs/search-results') || p.includes('/jobs/collections') || p.includes('/jobs/search/');
  } catch (_) {
    return false;
  }
}

function syncUrlCurrentJobId(jobId) {
  if (!jobId || !isJobsListSpaPath()) return false;
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('currentJobId') === String(jobId)) return true;
    u.searchParams.set('currentJobId', String(jobId));
    const prev = window.history.state;
    const nextState =
      prev && typeof prev === 'object' ? { ...prev, currentJobId: String(jobId) } : { currentJobId: String(jobId) };
    window.history.replaceState(nextState, '', u.toString());
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    return true;
  } catch (_) {
    return false;
  }
}

function resolveJobIdForOpen(wrapper) {
  const { jobUrl } = getJobInfoFromWrapper(wrapper);
  return getJobIdFromWrapper(wrapper, jobUrl) || getJobIdFromUrl(jobUrl) || null;
}

function dispatchSyntheticPointerClick(el) {
  if (!el || typeof el.click !== 'function') return;
  const view = window;
  const opts = { bubbles: true, cancelable: true, view };
  try {
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        ...opts,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1
      })
    );
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.click();
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        ...opts,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 0
      })
    );
  } catch (_) {
    try {
      el.click();
    } catch (_) {}
  }
}

function performAutoOpenClientJobActions(wrapper) {
  if (!pnTabVisibleForAutoOpen()) return false;
  if (!wrapper?.isConnected) return false;
  const jobId = resolveJobIdForOpen(wrapper);
  try {
    wrapper.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  } catch (_) {}

  if (getJobIdFromComponentKey(wrapper) && wrapper.getAttribute('role') === 'button') {
    dispatchSyntheticPointerClick(wrapper);
    if (jobId) syncUrlCurrentJobId(jobId);
    return true;
  }

  const link = getJobOpenLinkFromCard(wrapper);
  if (link) {
    try {
      link.focus({ preventScroll: true });
    } catch (_) {}
    dispatchSyntheticPointerClick(link);
    if (jobId) syncUrlCurrentJobId(jobId);
    return true;
  }
  if (tryClickJobCardOpenTarget(wrapper)) {
    if (jobId) syncUrlCurrentJobId(jobId);
    return true;
  }
  if (jobId && syncUrlCurrentJobId(jobId)) {
    return true;
  }
  return false;
}

function getJobOpenLinkFromCard(wrapper) {
  const prefer = [
    'a[href*="/jobs/view/"]',
    'a[href*="/jobs/search/"]',
    'a[href*="/jobs/search-results"]',
    'a[href*="/jobs/collections"][href*="currentJobId="]',
    'a[href*="/jobs?"]',
    'a[href*="linkedin.com/jobs/"]',
    'a[href*="/jobs/"]',
    'a[href*="jobs"]'
  ];
  for (const sel of prefer) {
    const a = wrapper.querySelector(sel);
    if (a && a.getAttribute('href')) return a;
  }
  const roleLink = wrapper.querySelector('[role="link"][href]');
  if (roleLink && roleLink.getAttribute('href')) return roleLink;
  return null;
}

function tryClickJobCardOpenTarget(wrapper) {
  if (!wrapper) return false;
  const candidates = [
    () => wrapper.querySelector('a[href*="job"]'),
    () => wrapper.querySelector('[role="link"]'),
    () => wrapper.querySelector('[role="button"][tabindex]'),
    () => wrapper.querySelector('.job-card-container__link'),
    () => wrapper.querySelector('[class*="job-card-list__title"]'),
    () => wrapper
  ];
  for (const getEl of candidates) {
    const el = getEl();
    if (!el || typeof el.click !== 'function') continue;
    try {
      el.click();
      return true;
    } catch (_) {}
  }
  return false;
}

function getJobSupabaseLookupFields(wrapper) {
  const { jobUrl } = getJobInfoFromWrapper(wrapper);
  const linkedinJobId = getJobIdFromWrapper(wrapper, jobUrl) || null;
  return {
    dedupKey: dedupeKeyForCard(wrapper),
    linkedinJobId,
    jobUrl: jobUrl ? pnNormalizeText(jobUrl) : null
  };
}

function enqueueClientJobForAutoOpenByKey(key) {
  const k = String(key || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!k) return;
  if (clientJobOpenQueueSet.has(k)) return;
  if (autoOpenedClientJobKeys.has(k)) return;
  while (clientJobOpenQueueOrder.length >= MAX_CLIENT_AUTO_OPEN_QUEUE) {
    const dropped = clientJobOpenQueueOrder.shift();
    if (dropped) clientJobOpenQueueSet.delete(dropped);
  }
  clientJobOpenQueueOrder.push(k);
  clientJobOpenQueueSet.add(k);
}

function dequeueClientJobOpenKey(k) {
  if (!k || !clientJobOpenQueueSet.has(k)) return;
  clientJobOpenQueueSet.delete(k);
  const idx = clientJobOpenQueueOrder.indexOf(k);
  if (idx >= 0) clientJobOpenQueueOrder.splice(idx, 1);
}

function pruneClientJobOpenQueueFromVisited(visited) {
  if (!visited || typeof visited !== 'object') return;
  for (const k of [...clientJobOpenQueueOrder]) {
    if (visited[k]) dequeueClientJobOpenKey(k);
  }
}

function pruneClientJobOpenQueueFromPresentComplete(present) {
  if (!present || typeof present !== 'object') return;
  for (const k of [...clientJobOpenQueueOrder]) {
    if (present[k]) dequeueClientJobOpenKey(k);
  }
}

function findClientJobCardWrapperByDedupKey(key) {
  if (!key) return null;
  const nodes = querySelectorAllDeep(document, `[${DATA_PROCESSED}][${DATA_TYPE}="Client"]`);
  for (const w of nodes) {
    if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(w)) continue;
    if (dedupeKeyForCard(w) === key) return w;
  }
  return null;
}

function buildMergedClientCardsForAutoOpen() {
  const out = [];
  const seenKeys = new Set();

  for (const key of [...clientJobOpenQueueOrder]) {
    if (seenKeys.has(key)) continue;
    if (autoOpenedClientJobKeys.has(key)) continue;
    const w = findClientJobCardWrapperByDedupKey(key);
    if (w?.isConnected) {
      seenKeys.add(key);
      out.push(w);
    }
  }

  for (const w of getVisibleClientJobCardsTopToBottom()) {
    const k = dedupeKeyForCard(w);
    if (!k || seenKeys.has(k)) continue;
    if (autoOpenedClientJobKeys.has(k)) continue;
    seenKeys.add(k);
    out.push(w);
  }

  return out;
}

function querySavedJobsPresenceFromBackground(items) {
  return new Promise((resolve) => {
    sendRuntimeMessageSafe({ action: 'checkSavedJobsInSupabase', items }, (res, err) => {
      if (err || !res?.ok || !res.present) {
        resolve({});
        return;
      }
      resolve(res.present);
    });
  });
}

let openClientJobsSequenceRunning = false;
let autoOpenCoalesceTimer = null;
let autoOpenRunQueued = false;
let autoOpenDisabledUntil = 0;
let lastAutoOpenRunAt = 0;
let autoOpenAfterClientTimer = null;
/** File reportée tant que l’onglet LinkedIn n’est pas visible. */
let deferredAutoOpenWhileTabHidden = false;

function requestAutoOpenRun(reason = '') {
  const now = Date.now();
  if (now < autoOpenDisabledUntil) return;
  if (!pnTabVisibleForAutoOpen()) {
    deferredAutoOpenWhileTabHidden = true;
    return;
  }
  if (openClientJobsSequenceRunning) {
    autoOpenRunQueued = true;
    return;
  }
  if (autoOpenCoalesceTimer) return;
  const delay = Math.max(0, AUTO_OPEN_MIN_GAP_MS - (now - lastAutoOpenRunAt));
  autoOpenCoalesceTimer = setTimeout(() => {
    autoOpenCoalesceTimer = null;
    lastAutoOpenRunAt = Date.now();
    void tryAutoOpenNewVisibleClientJobs();
  }, delay);
}

function scheduleAutoOpenAfterClientClassified() {
  if (autoOpenAfterClientTimer) clearTimeout(autoOpenAfterClientTimer);
  autoOpenAfterClientTimer = setTimeout(() => {
    autoOpenAfterClientTimer = null;
    requestAutoOpenRun('after-client-classified');
  }, AUTO_OPEN_AFTER_CLIENT_MS);
}

async function tryAutoOpenNewVisibleClientJobs() {
  if (Date.now() < autoOpenDisabledUntil) return;
  if (!pnTabVisibleForAutoOpen()) {
    deferredAutoOpenWhileTabHidden = true;
    return;
  }
  if (openClientJobsSequenceRunning) {
    autoOpenRunQueued = true;
    return;
  }
  const visited = await getVisitedJobDeskMap();
  pruneClientJobOpenQueueFromVisited(visited);

  const cards = buildMergedClientCardsForAutoOpen();
  const pending = cards.filter((w) => {
    const k = dedupeKeyForCard(w);
    if (!k) return false;
    if (visited[k]) return false;
    if (autoOpenedClientJobKeys.has(k)) return false;
    return true;
  });

  if (pending.length === 0) {
    return;
  }

  const lookupItems = pending
    .map((w) => getJobSupabaseLookupFields(w))
    .filter((it) => it.dedupKey && (it.linkedinJobId || it.jobUrl));

  const present = await querySavedJobsPresenceFromBackground(lookupItems);
  pruneClientJobOpenQueueFromPresentComplete(present);

  for (const it of lookupItems) {
    if (present[it.dedupKey]) {
      void markJobDeskVisitedPersistent(it.dedupKey);
    }
  }

  const pendingToOpen = pending.filter((w) => {
    const k = dedupeKeyForCard(w);
    return k && !present[k];
  });

  if (pendingToOpen.length === 0) {
    return;
  }

  openClientJobsSequenceRunning = true;
  try {
    for (let i = 0; i < pendingToOpen.length; i++) {
      if (!pnTabVisibleForAutoOpen()) {
        deferredAutoOpenWhileTabHidden = true;
        autoOpenRunQueued = true;
        break;
      }
      const wrapper = pendingToOpen[i];
      if (!wrapper.isConnected) continue;
      const k = dedupeKeyForCard(wrapper);
      if (!k || autoOpenedClientJobKeys.has(k)) continue;
      const opened = performAutoOpenClientJobActions(wrapper);
      if (opened) {
        saveJobCardSnapshot(wrapper);
        scheduleJobOfferScrape(wrapper);
        autoOpenedClientJobKeys.add(k);
        dequeueClientJobOpenKey(k);
        void markJobDeskVisitedPersistent(k);
      }
      if (i < pendingToOpen.length - 1) {
        const stillHere = await sleepBetweenClicksOrUntilHidden(randomDelayMsBetweenClientClicks());
        if (!stillHere) {
          deferredAutoOpenWhileTabHidden = true;
          autoOpenRunQueued = true;
          break;
        }
      }
    }
  } finally {
    openClientJobsSequenceRunning = false;
    if (autoOpenRunQueued) {
      autoOpenRunQueued = false;
      requestAutoOpenRun('queued-after-running');
    }
  }
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

const debouncedAutoOpenClientJobs = debounce(() => {
  requestAutoOpenRun('scroll-debounce');
}, 650);

const debouncedAutoOpenOnMutation = debounce(() => {
  requestAutoOpenRun('dom-mutation');
}, 850);

function installPnHistoryAutoOpenListener() {
  if (window.__pnHistoryAutoOpenListener) return;
  window.__pnHistoryAutoOpenListener = true;
  const onPathChange = () => {
    requestAutoOpenRun('path-change');
  };
  try {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (...args) {
        const r = orig.apply(this, args);
        onPathChange();
        return r;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  } catch (_) {}
  window.addEventListener('popstate', onPathChange);
}

function attachAutoOpenScrollListeners() {
  document.addEventListener(
    'scroll',
    () => {
      debouncedAutoOpenClientJobs();
    },
    { passive: true, capture: true }
  );
  document.addEventListener(
    'scrollend',
    () => {
      requestAutoOpenRun('scrollend');
    },
    { passive: true, capture: true }
  );
}

function installAutoOpenMutationObserver() {
  if (window.__pnAutoOpenMutationObserver) return;
  window.__pnAutoOpenMutationObserver = true;
  const mo = new MutationObserver(() => debouncedAutoOpenOnMutation());
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
}

function installAutoOpenVisibilityListener() {
  if (window.__pnAutoOpenVisibilityListener) return;
  window.__pnAutoOpenVisibilityListener = true;
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!pnTabVisibleForAutoOpen()) {
        if (autoOpenCoalesceTimer) {
          clearTimeout(autoOpenCoalesceTimer);
          autoOpenCoalesceTimer = null;
        }
        deferredAutoOpenWhileTabHidden = true;
        return;
      }
      deferredAutoOpenWhileTabHidden = false;
      requestAutoOpenRun('tab-visible');
    },
    false
  );
}

(function initPnJobdeskAutoOpen() {
  if (window.__pnJobdeskAutoopenInstalled) return;
  if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
  window.__pnJobdeskAutoopenInstalled = true;

  document.addEventListener(
    'pn-client-classified',
    (e) => {
      const card = e.detail?.card;
      const k = card && dedupeKeyForCard(card);
      if (k) enqueueClientJobForAutoOpenByKey(k);
      scheduleAutoOpenAfterClientClassified();
    },
    false
  );

  installPnHistoryAutoOpenListener();
  installAutoOpenVisibilityListener();
  attachAutoOpenScrollListeners();
  installAutoOpenMutationObserver();
  attachUserClickJobdeskScrape();

  setTimeout(() => requestAutoOpenRun('init-3500'), 3500);
  setTimeout(() => requestAutoOpenRun('init-9500'), 9500);
})();
