/**
 * Clics automatiques sur offres « Client » (liste) pour ouvrir la Jobdesk et déclencher l’aspiration.
 * Dédup par offre (dedupeKeyForCard), délais aléatoires, batch Supabase pour éviter les re-clics inutiles.
 */

const AUTO_OPEN_VIEWPORT_MARGIN_PX = 140;
const AUTO_OPEN_MIN_GAP_MS = 900;
const AUTO_OPEN_AFTER_CLIENT_MS = 700;
const MAX_CLIENT_AUTO_OPEN_QUEUE = 400;

/** Dernière raison d’invocation auto-open (scroll, init, etc.) pour les logs `jd_*`. */
let lastJdRunReason = '';
let __jdLastScrollLogAt = 0;
const JD_SCROLL_LOG_MS = 22000;
let __jdAwaitFullScrollLogAt = 0;
const JD_AWAIT_FULL_SCROLL_LOG_MS = 8000;

/** Clé de liste (URL sans `currentJobId`) → IDs Client vus au scroll (virtualisation LinkedIn). */
const JD_SEEN_CLIENT_IDS_BY_LIST_KEY = new Map();
/** Dernière clé de liste pour laquelle on a fusionné le DOM — sert à détecter un changement d’URL liste. */
let jdMergeLastLk = '';
const JD_LIST_IDS_CHUNK_CHARS = 7500;
/** Après changement de liste (SPA), vider le tampon background : `pagehide` ne part pas toujours sur LinkedIn. */
const JD_NAV_SUPABASE_FLUSH_MS = 750;
let jobsTabSupabaseFlushTimer = null;
const JD_SCROLL_BOTTOM_EPSILON_PX = 28;
const JD_SCROLL_ROOT_SELECTORS = [
  '.jobs-search-results-list',
  '[class*="jobs-search-results-list"]',
  '.jobs-search-two-pane__results',
  '[class*="jobs-search-two-pane__results"]',
  '.scaffold-layout__list',
  '[class*="scaffold-layout__list"]',
  'main[role="main"]'
];
const JD_FULLY_SCROLLED_LIST_KEYS = new Set();
/** Workflow badges→clics en cours pour cette lk (gate validé seulement après classify OK). */
const JD_WORKFLOW_IN_FLIGHT_KEYS = new Set();
/** Liste (lk) pour laquelle l’utilisateur a scrollé le panneau jobs (évite badges avant scroll). */
const JD_LIST_USER_SCROLLED_KEYS = new Set();
const JD_OPENED_CLIENT_IDS_BY_LIST_KEY = new Map();

function scheduleJobsTabSupabaseFlush() {
  if (jobsTabSupabaseFlushTimer) clearTimeout(jobsTabSupabaseFlushTimer);
  jobsTabSupabaseFlushTimer = setTimeout(() => {
    jobsTabSupabaseFlushTimer = null;
    try {
      sendRuntimeMessageSafe({ type: 'PN_FLUSH_JOBS_TAB_STATE' }, () => {});
    } catch (_) {}
  }, JD_NAV_SUPABASE_FLUSH_MS);
}

/**
 * Clé complète par page LinkedIn (incluant `start`).
 * Utilisée pour le gate "done" (JD_FULLY_SCROLLED_LIST_KEYS) : chaque page paginée a son propre gate.
 */
function jdListPageKey() {
  try {
    const u = new URL(location.href);
    const sp = new URLSearchParams(u.search);
    sp.delete('currentJobId');
    sp.delete('cj');
    const qs = sp.toString();
    return `${u.pathname || ''}${qs ? `?${qs}` : ''}`.slice(0, 200);
  } catch (_) {
    return '';
  }
}

/**
 * Clé de base sans `start` — utilisée uniquement pour JD_WORKFLOW_IN_FLIGHT_KEYS.
 * Pendant le scroll d'une liste, LinkedIn change start=0→25→50→75 ; cette clé reste stable
 * et empêche les workflows en rafale sans bloquer les vraies pages suivantes.
 */
function jdListBaseKey() {
  try {
    const u = new URL(location.href);
    const sp = new URLSearchParams(u.search);
    sp.delete('currentJobId');
    sp.delete('start');
    sp.delete('cj');
    const qs = sp.toString();
    return `${u.pathname || ''}${qs ? `?${qs}` : ''}`.slice(0, 200);
  } catch (_) {
    return '';
  }
}

function jdPruneSeenIdsMap() {
  while (JD_SEEN_CLIENT_IDS_BY_LIST_KEY.size > 10) {
    const k = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.keys().next().value;
    if (k != null) JD_SEEN_CLIENT_IDS_BY_LIST_KEY.delete(k);
  }
}

function jdPruneSmallSet(s, max = 12) {
  while (s.size > max) {
    const k = s.keys().next().value;
    if (k != null) s.delete(k);
  }
}

function jdClearListGatingState(lk) {
  if (!lk) return;
  JD_FULLY_SCROLLED_LIST_KEYS.delete(lk);
  // In-flight uses base key (without start) — delete both to be safe
  JD_WORKFLOW_IN_FLIGHT_KEYS.delete(lk);
  JD_WORKFLOW_IN_FLIGHT_KEYS.delete(jdListBaseKey());
  JD_LIST_USER_SCROLLED_KEYS.delete(lk);
}

/** Classification ou workflow interrompu : permet de relancer sans recharger la page. */
function jdAbortListWorkflowGate(reason = '') {
  const lk = jdListPageKey();
  const bk = jdListBaseKey();
  if (!lk) return;
  JD_FULLY_SCROLLED_LIST_KEYS.delete(lk);
  JD_WORKFLOW_IN_FLIGHT_KEYS.delete(bk);
  jdLog('jd_classify', { st: 'abort', r: String(reason || '').slice(0, 48), lk: lk.slice(0, 120) });
}

function jdIsListWorkflowActive() {
  const bk = jdListBaseKey();
  const lk = jdListPageKey();
  if (!lk) return false;
  return JD_WORKFLOW_IN_FLIGHT_KEYS.has(bk) || JD_FULLY_SCROLLED_LIST_KEYS.has(lk);
}

function jdPruneOpenedIdsMap() {
  while (JD_OPENED_CLIENT_IDS_BY_LIST_KEY.size > 12) {
    const k = JD_OPENED_CLIENT_IDS_BY_LIST_KEY.keys().next().value;
    if (k != null) JD_OPENED_CLIENT_IDS_BY_LIST_KEY.delete(k);
  }
}

function jdGetOpenedIdsSetForListKey(lk) {
  if (!lk) return new Set();
  if (!JD_OPENED_CLIENT_IDS_BY_LIST_KEY.has(lk)) {
    jdPruneOpenedIdsMap();
    JD_OPENED_CLIENT_IDS_BY_LIST_KEY.set(lk, new Set());
  }
  return JD_OPENED_CLIENT_IDS_BY_LIST_KEY.get(lk);
}

function jdIsScrollableElement(el) {
  if (!el || !el.getBoundingClientRect) return false;
  try {
    const style = window.getComputedStyle(el);
    const ovy = String(style?.overflowY || '');
    const canScroll = ovy === 'auto' || ovy === 'scroll' || ovy === 'overlay';
    return canScroll && el.scrollHeight - el.clientHeight > 40;
  } catch (_) {
    return false;
  }
}

function jdFindScrollableAncestor(el) {
  let n = el?.parentElement || null;
  while (n && n !== document.body && n !== document.documentElement) {
    if (jdIsScrollableElement(n)) return n;
    n = n.parentElement;
  }
  return null;
}

function jdGetLikelyJobsListScrollRoot() {
  for (const sel of JD_SCROLL_ROOT_SELECTORS) {
    let nodes = [];
    try {
      nodes = querySelectorAllDeep(document, sel) || [];
    } catch (_) {
      nodes = [];
    }
    for (const el of nodes) {
      if (!jdIsScrollableElement(el)) continue;
      if (typeof isInLeftJobListColumn === 'function' && !isInLeftJobListColumn(el)) continue;
      return el;
    }
  }
  if (typeof collectJobCards === 'function') {
    for (const card of collectJobCards()) {
      if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(card)) continue;
      const root = jdFindScrollableAncestor(card);
      if (root) return root;
    }
  }
  const cards = querySelectorAllDeep(document, `[${DATA_PROCESSED}]`) || [];
  for (const card of cards) {
    if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(card)) continue;
    const root = jdFindScrollableAncestor(card);
    if (root) return root;
  }
  return null;
}

function jdHasReachedBottomForCurrentList() {
  const root = jdGetLikelyJobsListScrollRoot();
  if (!root) return false;
  const dist = root.scrollHeight - (root.scrollTop + root.clientHeight);
  return dist <= JD_SCROLL_BOTTOM_EPSILON_PX;
}

/** Liste courte : tout le contenu tient sans barre de scroll. */
function jdListHasNoScrollNeeded() {
  const root = jdGetLikelyJobsListScrollRoot();
  if (!root) return false;
  return root.scrollHeight - root.clientHeight <= JD_SCROLL_BOTTOM_EPSILON_PX;
}

function jdNoteListScrollActivity() {
  const lk = jdListPageKey();
  if (!lk) return;
  jdPruneSmallSet(JD_LIST_USER_SCROLLED_KEYS, 12);
  JD_LIST_USER_SCROLLED_KEYS.add(lk);
}

/** Scroll utilisateur sur le panneau liste, ou liste non scrollable. */
function jdHasUserScrolledCurrentList() {
  const lk = jdListPageKey();
  if (!lk) return false;
  if (JD_LIST_USER_SCROLLED_KEYS.has(lk)) return true;
  return jdListHasNoScrollNeeded();
}

function jdIsCurrentListFullyScrolled() {
  const lk = jdListPageKey();
  if (!lk) return false;
  return JD_FULLY_SCROLLED_LIST_KEYS.has(lk);
}

function jdMarkCurrentListFullyScrolled(reason = '') {
  const lk = jdListPageKey();
  if (!lk) return false;
  if (JD_FULLY_SCROLLED_LIST_KEYS.has(lk)) return false;
  jdPruneSmallSet(JD_FULLY_SCROLLED_LIST_KEYS, 12);
  JD_FULLY_SCROLLED_LIST_KEYS.add(lk);
  jdLog('jd_gate', { lk, y: 'open', r: String(reason || '').slice(0, 60) });
  return true;
}

let __jdScrollRootHooked = null;
let __jdScrollEndTimer = null;
const JD_SCROLL_END_MS = 280;
/** Une fois par élément scroll racine : sonder après branchement tardif (évite reload si SPA restaure le scroll avant nos listeners). */
const jdScrollHookProbeTimers = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

/**
 * LinkedIn monte souvent la liste après nos scripts : les scroll ont lieu avant addEventListener.
 * Si la liste est déjà en bas avec une position scrollée (scrollTop > 0), on considère le scroll « vu ».
 * Si liste courte sans scroll (jdListHasNoScrollNeeded), jdHasUserScrolledCurrentList couvre déjà ce cas.
 */
function jdTryKickWorkflowAfterScrollHook(reason = '') {
  try {
    if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
    mergeSeenClientJobsFromDom();
    if (!jdHasReachedBottomForCurrentList()) return;
    const root = jdGetLikelyJobsListScrollRoot();
    if (!root) return;
    const overflow = root.scrollHeight - root.clientHeight;
    const needsScroll = overflow > JD_SCROLL_BOTTOM_EPSILON_PX;
    const st = Number(root.scrollTop) || 0;
    if (needsScroll && st <= 1) return;
    jdNoteListScrollActivity();
    jdOnListScrollFinished();
    if (reason && typeof jdLog === 'function') {
      jdLog('jd_boot', { r: String(reason || '').slice(0, 48), st: Math.round(st), ov: Math.round(overflow) });
    }
  } catch (_) {}
}

function jdScheduleKickAfterScrollHook(root, reason = '') {
  if (!root) return;
  const scheduleDelayed = () => {
    try {
      jdTryKickWorkflowAfterScrollHook(reason);
    } catch (_) {}
  };
  requestAnimationFrame(() => requestAnimationFrame(scheduleDelayed));
  if (!jdScrollHookProbeTimers) return;
  const prev = jdScrollHookProbeTimers.get(root);
  if (prev) clearTimeout(prev);
  const t = setTimeout(scheduleDelayed, 850);
  jdScrollHookProbeTimers.set(root, t);
}

/** Scroll terminé + bas de liste → badges puis clics. */
function jdOnListScrollFinished() {
  mergeSeenClientJobsFromDom();
  if (!jdHasUserScrolledCurrentList()) return;
  if (!jdHasReachedBottomForCurrentList()) return;
  jdTryStartListWorkflow('scroll-finished');
}

function jdScheduleScrollFinishedCheck() {
  jdNoteListScrollActivity();
  if (__jdScrollEndTimer) clearTimeout(__jdScrollEndTimer);
  __jdScrollEndTimer = setTimeout(() => {
    __jdScrollEndTimer = null;
    jdOnListScrollFinished();
  }, JD_SCROLL_END_MS);
}

/** Le scroll de la liste LinkedIn ne remonte pas à document : écouter le panneau liste. */
function jdEnsureListScrollRootListener(hookReason = '') {
  const root = jdGetLikelyJobsListScrollRoot();
  if (!root) return null;
  const newlyHooked = __jdScrollRootHooked !== root;
  if (__jdScrollRootHooked === root) return root;
  __jdScrollRootHooked = root;
  try {
    root.addEventListener('scroll', jdScheduleScrollFinishedCheck, { passive: true });
    root.addEventListener(
      'scrollend',
      () => {
        jdNoteListScrollActivity();
        jdOnListScrollFinished();
      },
      { passive: true }
    );
  } catch (_) {
    try {
      root.addEventListener('scroll', jdScheduleScrollFinishedCheck, { passive: true });
    } catch (_) {}
  }
  if (newlyHooked) jdScheduleKickAfterScrollHook(root, hookReason || 'scroll-hook');
  return root;
}

/** Démarre le workflow (badges → clics Client), une fois par page après scroll complet.
 *  - JD_FULLY_SCROLLED_LIST_KEYS  : gate par page complète (lk avec start) → page 2, 3... peuvent passer
 *  - JD_WORKFLOW_IN_FLIGHT_KEYS   : verrou pendant le classify (bk sans start) → évite doublons pendant scroll
 */
function jdTryStartListWorkflow(reason = '') {
  if (!jdHasUserScrolledCurrentList()) return false;
  if (!jdHasReachedBottomForCurrentList()) return false;
  const lk = jdListPageKey();
  const bk = jdListBaseKey();
  if (!lk) return false;
  if (JD_FULLY_SCROLLED_LIST_KEYS.has(lk)) return false;
  if (JD_WORKFLOW_IN_FLIGHT_KEYS.has(bk)) return false;
  if (typeof window.pnRunListWorkflowAfterFullScroll !== 'function') {
    jdLog('jd_fail', { m: 'no_workflow_fn', r: String(reason || '').slice(0, 48) });
    return false;
  }
  JD_WORKFLOW_IN_FLIGHT_KEYS.add(bk);
  jdLog('jd_wf', { r: String(reason || '').slice(0, 48) });
  void window.pnRunListWorkflowAfterFullScroll(reason).finally(() => {
    JD_WORKFLOW_IN_FLIGHT_KEYS.delete(bk);
  });
  return true;
}

try {
  window.jdMarkCurrentListFullyScrolled = jdMarkCurrentListFullyScrolled;
  window.jdAbortListWorkflowGate = jdAbortListWorkflowGate;
  window.jdIsListWorkflowActive = jdIsListWorkflowActive;
} catch (_) {}

function jdLogAwaitFullScroll(reason = '') {
  const now = Date.now();
  if (now - __jdAwaitFullScrollLogAt < JD_AWAIT_FULL_SCROLL_LOG_MS) return;
  __jdAwaitFullScrollLogAt = now;
  jdLog('jd_skip', { y: 'await_full_scroll', r: String(reason || '').slice(0, 80) });
}

/** Tous les jobs Client actuellement présents dans le DOM (colonne liste). */
function harvestAllClientJobIdsInListColumn() {
  const ids = [];
  const seen = new Set();
  try {
    const nodes = querySelectorAllDeep(document, `[${DATA_PROCESSED}][${DATA_TYPE}="Client"]`);
    for (const w of nodes) {
      if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(w)) continue;
      const { jobUrl } = getJobInfoFromWrapper(w);
      const id = getJobIdFromWrapper(w, jobUrl) || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  } catch (_) {}
  return ids;
}

function mergeSeenClientJobsFromDom() {
  const lk = jdListPageKey();
  if (!lk) {
    if (jdMergeLastLk) {
      flushAccumulatedClientJobIdsForListKey(jdMergeLastLk, 'left-jobs-list');
      jdClearListGatingState(jdMergeLastLk);
      jdMergeLastLk = '';
      scheduleJobsTabSupabaseFlush();
    }
    return;
  }
  let listKeyChanged = false;
  if (jdMergeLastLk && jdMergeLastLk !== lk) {
    flushAccumulatedClientJobIdsForListKey(jdMergeLastLk, 'list-url-changed');
    jdClearListGatingState(jdMergeLastLk);
    // Réinitialise uniquement le gate de scroll sur la destination (force un re-scroll)
    // mais conserve les sets seen/opened pour éviter de re-cliquer des jobs déjà traités.
    jdClearListGatingState(lk);
    __jdScrollRootHooked = null;
    listKeyChanged = true;
  }
  if (!JD_SEEN_CLIENT_IDS_BY_LIST_KEY.has(lk)) {
    jdPruneSeenIdsMap();
    JD_SEEN_CLIENT_IDS_BY_LIST_KEY.set(lk, new Set());
  }
  const set = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.get(lk);
  for (const id of harvestAllClientJobIdsInListColumn()) set.add(id);
  jdMergeLastLk = lk;
  if (listKeyChanged) scheduleJobsTabSupabaseFlush();
}

/** Envoie une fois vers Supabase la liste cumulée pour `lk`, puis vide l’entrée locale (peu de requêtes). */
function flushAccumulatedClientJobIdsForListKey(lk, reason) {
  if (!lk) return;
  const set = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.get(lk);
  if (!set || set.size === 0) {
    JD_SEEN_CLIENT_IDS_BY_LIST_KEY.delete(lk);
    return;
  }
  const sorted = Array.from(set).sort();
  const joined = sorted.join(',');
  const n = sorted.length;
  const r = String(reason || '').slice(0, 60);
  if (joined.length <= JD_LIST_IDS_CHUNK_CHARS) {
    jdLog('jd_list', { lk, n, r, ids: joined });
  } else {
    const pt = Math.ceil(joined.length / JD_LIST_IDS_CHUNK_CHARS);
    for (let pi = 0; pi < pt; pi++) {
      const chunk = joined.slice(pi * JD_LIST_IDS_CHUNK_CHARS, (pi + 1) * JD_LIST_IDS_CHUNK_CHARS);
      jdLog('jd_list', { lk, n, r, pi, pt, ids: chunk });
    }
  }
  JD_SEEN_CLIENT_IDS_BY_LIST_KEY.delete(lk);
}

function jdPageKey() {
  try {
    const u = new URL(location.href);
    const st = u.searchParams.get('start') || '0';
    const cj = u.searchParams.get('currentJobId') || '';
    return `${u.pathname}|st=${st}|cj=${cj}`.slice(0, 200);
  } catch (_) {
    return '';
  }
}

function jdClientIdsSample(maxN = 16, maxChars = 200) {
  const out = [];
  try {
    const nodes = querySelectorAllDeep(document, `[${DATA_PROCESSED}][${DATA_TYPE}="Client"]`);
    for (const w of nodes) {
      if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(w)) continue;
      const { jobUrl } = getJobInfoFromWrapper(w);
      const id = getJobIdFromWrapper(w, jobUrl) || '';
      if (!id || out.includes(id)) continue;
      out.push(id);
      if (out.length >= maxN) break;
    }
  } catch (_) {}
  let s = out.join(',');
  if (s.length > maxChars) s = s.slice(0, maxChars);
  return { n: out.length, s };
}

function jdLog(event, payload) {
  try {
    const ev = String(event || '');
    const base = payload && typeof payload === 'object' ? payload : {};
    const lkVal = ev.startsWith('jd_') ? jdListPageKey() : '';
    sendRuntimeMessageSafe(
      {
        type: 'EXTENSION_LOG',
        event: ev.slice(0, 200),
        level: 'info',
        data: {
          ...base,
          pk: jdPageKey(),
          ...(lkVal ? { lk: lkVal } : {}),
          t: Date.now()
        }
      },
      () => {}
    );
  } catch (_) {}
}

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
    return (
      p.includes('/jobs/search-results') ||
      p.includes('/jobs/collections') ||
      p.includes('/jobs/search/') ||
      (typeof isJobsSlugListingPath === 'function' && isJobsSlugListingPath())
    );
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

function getSeenClientJobIdsForListKey(lk) {
  if (!lk) return [];
  const set = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.get(lk);
  if (!set || set.size === 0) return [];
  return Array.from(set)
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .sort();
}

async function getPendingClientJobIdsForCurrentList() {
  const lk = jdListPageKey();
  if (!lk) return { lk: '', ids: [], presentCount: 0, totalSeen: 0 };
  const seenIds = getSeenClientJobIdsForListKey(lk);
  if (!seenIds.length) return { lk, ids: [], presentCount: 0, totalSeen: 0 };

  const opened = jdGetOpenedIdsSetForListKey(lk);
  const baseIds = seenIds.filter((id) => !opened.has(id));
  if (!baseIds.length) return { lk, ids: [], presentCount: 0, totalSeen: seenIds.length };

  const lookupItems = baseIds.map((id) => ({ dedupKey: `jid:${id}`, linkedinJobId: id }));
  const present = await querySavedJobsPresenceFromBackground(lookupItems);
  let presentCount = 0;
  for (const id of baseIds) {
    if (present[`jid:${id}`]) {
      opened.add(id);
      presentCount += 1;
    }
  }
  const ids = baseIds.filter((id) => !present[`jid:${id}`]);
  return { lk, ids, presentCount, totalSeen: seenIds.length };
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
  lastJdRunReason = String(reason || '').slice(0, 80);
  const immediateAfterFullScroll = lastJdRunReason.includes('full-scroll-ready');
  if (!pnTabVisibleForAutoOpen()) {
    deferredAutoOpenWhileTabHidden = true;
    return;
  }
  if (openClientJobsSequenceRunning) {
    autoOpenRunQueued = true;
    return;
  }
  if (!jdIsCurrentListFullyScrolled()) {
    jdLogAwaitFullScroll(lastJdRunReason);
    return;
  }
  if (autoOpenCoalesceTimer) {
    if (!immediateAfterFullScroll) return;
    clearTimeout(autoOpenCoalesceTimer);
    autoOpenCoalesceTimer = null;
  }
  const delay = immediateAfterFullScroll
    ? 0
    : Math.max(0, AUTO_OPEN_MIN_GAP_MS - (now - lastAutoOpenRunAt));
  autoOpenCoalesceTimer = setTimeout(() => {
    autoOpenCoalesceTimer = null;
    lastAutoOpenRunAt = Date.now();
    void tryAutoOpenNewVisibleClientJobs();
  }, delay);
}

function scheduleAutoOpenAfterClientClassified() {
  if (!jdIsCurrentListFullyScrolled()) return;
  if (autoOpenAfterClientTimer) clearTimeout(autoOpenAfterClientTimer);
  autoOpenAfterClientTimer = setTimeout(() => {
    autoOpenAfterClientTimer = null;
    if (!jdIsCurrentListFullyScrolled()) return;
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
  mergeSeenClientJobsFromDom();
  if (!jdIsCurrentListFullyScrolled()) {
    jdLogAwaitFullScroll(lastJdRunReason);
    return;
  }

  // Verrouillage AVANT l'await pour éviter une double entrée concurrente
  // (DOM mutation ou popstate peuvent re-déclencher pendant le fetch Supabase).
  openClientJobsSequenceRunning = true;
  let pendingById;
  try {
    pendingById = await getPendingClientJobIdsForCurrentList();
  } catch (_) {
    openClientJobsSequenceRunning = false;
    return;
  }

  if (pendingById.ids.length > 0) {
    let batchOpened = 0;
    try {
      for (let i = 0; i < pendingById.ids.length; i++) {
        if (!pnTabVisibleForAutoOpen()) {
          deferredAutoOpenWhileTabHidden = true;
          autoOpenRunQueued = true;
          break;
        }
        const jid = pendingById.ids[i];
        const opened = syncUrlCurrentJobId(jid);
        if (opened) {
          jdGetOpenedIdsSetForListKey(pendingById.lk).add(jid);
          batchOpened += 1;
          scheduleJobOfferScrape(null, { o: 'a', jid });
          jdLog('jd_click', {
            jid,
            i,
            m: pendingById.ids.length,
            r: `${lastJdRunReason}|id-pass`
          });
        } else {
          jdLog('jd_fail', { jid, m: 'open-by-id', i, r: lastJdRunReason });
        }
        if (opened && i < pendingById.ids.length - 1) {
          const stillHere = await sleepBetweenClicksOrUntilHidden(randomDelayMsBetweenClientClicks());
          if (!stillHere) {
            deferredAutoOpenWhileTabHidden = true;
            autoOpenRunQueued = true;
            break;
          }
        }
      }
    } finally {
      jdLog('jd_seq', {
        cl: batchOpened,
        tot: pendingById.ids.length,
        r: `${lastJdRunReason}|id-pass`,
        sb: pendingById.presentCount,
        vi: pendingById.totalSeen
      });
      openClientJobsSequenceRunning = false;
      if (autoOpenRunQueued) {
        autoOpenRunQueued = false;
        requestAutoOpenRun('queued-after-running');
      }
    }
    return;
  }

  const cards = buildMergedClientCardsForAutoOpen();
  const pending = cards.filter((w) => {
    const k = dedupeKeyForCard(w);
    if (!k) return false;
    if (autoOpenedClientJobKeys.has(k)) return false;
    const jid = resolveJobIdForOpen(w) || '';
    if (jid) {
      const lk = jdListPageKey();
      const openedById = jdGetOpenedIdsSetForListKey(lk);
      if (openedById.has(jid)) return false;
    }
    return true;
  });

  if (pending.length === 0) {
    jdLog('jd_skip', { y: 'no_pending', r: lastJdRunReason });
    openClientJobsSequenceRunning = false;
    return;
  }

  const lookupItems = pending
    .map((w) => getJobSupabaseLookupFields(w))
    .filter((it) => it.dedupKey && (it.linkedinJobId || it.jobUrl));

  const present = await querySavedJobsPresenceFromBackground(lookupItems);
  pruneClientJobOpenQueueFromPresentComplete(present);

  for (const it of lookupItems) {
    if (present[it.dedupKey]) {
      autoOpenedClientJobKeys.add(it.dedupKey);
    }
  }

  const pendingToOpen = pending.filter((w) => {
    const k = dedupeKeyForCard(w);
    return k && !present[k];
  });

  const sample = jdClientIdsSample(20, 220);
  jdLog('jd_run', {
    r: lastJdRunReason,
    n: pending.length,
    q: lookupItems.length,
    sb: Object.keys(present || {}).length,
    o: pendingToOpen.length,
    ids: sample.s,
    vi: sample.n
  });

  if (pendingToOpen.length === 0) {
    jdLog('jd_skip', { y: 'all_sb', r: lastJdRunReason, n: pending.length });
    openClientJobsSequenceRunning = false;
    return;
  }

  // openClientJobsSequenceRunning déjà = true (posé avant le premier await)
  let batchOpened = 0;
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
      const jid = resolveJobIdForOpen(wrapper) || '';
      const lk = jdListPageKey();
      const opened = performAutoOpenClientJobActions(wrapper);
      if (opened) {
        saveJobCardSnapshot(wrapper);
        autoOpenedClientJobKeys.add(k);
        if (jid) jdGetOpenedIdsSetForListKey(lk).add(jid);
        batchOpened += 1;
        dequeueClientJobOpenKey(k);
        scheduleJobOfferScrape(wrapper, { o: 'a', jid: jid || undefined });
        jdLog('jd_click', {
          jid: String(jid),
          lk: jdListPageKey() || undefined,
          i,
          m: pendingToOpen.length,
          r: lastJdRunReason
        });
      } else {
        jdLog('jd_fail', { jid: String(jid), k: String(k).slice(0, 80), m: 'open', i, r: lastJdRunReason });
      }
      if (opened && i < pendingToOpen.length - 1) {
        const stillHere = await sleepBetweenClicksOrUntilHidden(randomDelayMsBetweenClientClicks());
        if (!stillHere) {
          deferredAutoOpenWhileTabHidden = true;
          autoOpenRunQueued = true;
          break;
        }
      }
    }
  } finally {
    jdLog('jd_seq', { cl: batchOpened, tot: pendingToOpen.length, r: lastJdRunReason });
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
  jdEnsureListScrollRootListener('doc-scroll');
  jdScheduleScrollFinishedCheck();
  const now = Date.now();
  if (now - __jdLastScrollLogAt >= JD_SCROLL_LOG_MS) {
    __jdLastScrollLogAt = now;
    const sample = jdClientIdsSample(18, 200);
    jdLog('jd_scroll', { ids: sample.s, n: sample.n, r: 'scroll-debounce' });
  }
}, 650);

const debouncedAutoOpenOnMutation = debounce(() => {
  jdEnsureListScrollRootListener('mutation-dom');
}, 850);

function installPnHistoryAutoOpenListener() {
  if (window.__pnHistoryAutoOpenListener) return;
  window.__pnHistoryAutoOpenListener = true;
  const onPathChange = () => {
    mergeSeenClientJobsFromDom();
    __jdScrollRootHooked = null;
    jdEnsureListScrollRootListener('spa-nav');
    jdTryKickWorkflowAfterScrollHook('spa-nav-sync');
  };
  try {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (...args) {
        const r = orig.apply(this, args);
        mergeSeenClientJobsFromDom();
        onPathChange();
        return r;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  } catch (_) {}
  window.addEventListener('popstate', () => {
    mergeSeenClientJobsFromDom();
    onPathChange();
  });
}

function attachAutoOpenScrollListeners() {
  document.addEventListener(
    'scroll',
    () => {
      debouncedAutoOpenClientJobs();
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
      if (jdIsCurrentListFullyScrolled()) {
        requestAutoOpenRun('tab-visible-resume');
      }
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

  window.addEventListener(
    'pagehide',
    () => {
      try {
        mergeSeenClientJobsFromDom();
        const lk = jdListPageKey();
        flushAccumulatedClientJobIdsForListKey(lk, 'pagehide');
        jdMergeLastLk = '';
        sendRuntimeMessageSafe({ type: 'PN_FLUSH_JOBS_TAB_STATE' }, () => {});
      } catch (_) {}
    },
    { capture: true }
  );

  jdEnsureListScrollRootListener('init');

  /** Liste courte (pas de scroll possible) : workflow après chargement DOM. */
  setTimeout(() => {
    jdEnsureListScrollRootListener('init-delay');
    jdTryKickWorkflowAfterScrollHook('init-delay');
    if (jdListHasNoScrollNeeded()) jdOnListScrollFinished();
  }, 3500);
})();
