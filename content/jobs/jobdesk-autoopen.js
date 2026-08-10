/**
 * Clics automatiques sur offres Client + SS2I (liste) pour ouvrir la Jobdesk et déclencher l’aspiration.
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

/** Clé de page liste (URL avec `start=`) → IDs Client vus sur CETTE page (compteur / pending). */
const JD_SEEN_CLIENT_IDS_BY_LIST_KEY = new Map();
/** Clé stable (sans `start=`) → toutes les offres vues (Client + SS2I) pour last_seen_at Supabase. */
const JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY = new Map();
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
 * Params LinkedIn qui changent à chaque clic d’offre (ne doivent PAS reset badges / gate).
 * Ex. search-results ajoute `eBP=…` → sinon on croit à une « nouvelle recherche » et on strip les labels.
 */
const JD_VOLATILE_JOBS_QUERY_PARAMS = [
  'currentJobId',
  'cj',
  'eBP',
  'trackingId',
  'refId',
  'lipi',
  'lici',
  'trk',
  'originalSubdomain',
  'alertAction',
  'saved',
  'isWaitingSubmission',
  'storeCtaType'
];

function jdSanitizeJobsSearchParams(sp, { dropStart = false } = {}) {
  if (!sp) return sp;
  for (const k of JD_VOLATILE_JOBS_QUERY_PARAMS) {
    try {
      sp.delete(k);
    } catch (_) {}
  }
  if (dropStart) {
    try {
      sp.delete('start');
    } catch (_) {}
  }
  return sp;
}

/**
 * Clé complète par page LinkedIn (incluant `start`, sans params volatils de clic).
 * Utilisée pour le gate "done" (JD_FULLY_SCROLLED_LIST_KEYS) : chaque page paginée a son propre gate.
 */
function jdListPageKey() {
  try {
    const u = new URL(location.href);
    const sp = jdSanitizeJobsSearchParams(new URLSearchParams(u.search));
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
    const sp = jdSanitizeJobsSearchParams(new URLSearchParams(u.search), { dropStart: true });
    const qs = sp.toString();
    return `${u.pathname || ''}${qs ? `?${qs}` : ''}`.slice(0, 200);
  } catch (_) {
    return '';
  }
}

/** Retire `start` + params volatils d’une clé liste `pathname?query`. */
function jdStripStartFromListKey(lk) {
  if (!lk) return '';
  try {
    const q = lk.indexOf('?');
    if (q < 0) return lk;
    const path = lk.slice(0, q);
    const sp = jdSanitizeJobsSearchParams(new URLSearchParams(lk.slice(q + 1)), { dropStart: true });
    const qs = sp.toString();
    return `${path}${qs ? `?${qs}` : ''}`;
  } catch (_) {
    return lk;
  }
}

/** Canonique : même recherche / collection (ignore start= et eBP/currentJobId). */
function jdCanonicalListKeyFromLk(lk) {
  return jdStripStartFromListKey(lk);
}

/** LinkedIn met à jour `start=` / `eBP=` / `currentJobId` — ce n’est pas une nouvelle recherche. */
function jdIsStartOnlyListKeyChange(prevLk, nextLk) {
  return !!(
    prevLk &&
    nextLk &&
    prevLk !== nextLk &&
    jdCanonicalListKeyFromLk(prevLk) === jdCanonicalListKeyFromLk(nextLk)
  );
}

/** Clé stable pour IDs vus / déjà ouverts (ne doit pas se fragmenter quand `start` bouge). */
function jdStableListKey() {
  return jdListBaseKey() || jdListPageKey();
}

function jdCarryScrollGatesAcrossStartChange(prevLk, nextLk) {
  if (!prevLk || !nextLk) return;
  if (JD_FULLY_SCROLLED_LIST_KEYS.has(prevLk)) {
    jdPruneSmallSet(JD_FULLY_SCROLLED_LIST_KEYS, 12);
    JD_FULLY_SCROLLED_LIST_KEYS.add(nextLk);
  }
  if (JD_LIST_USER_SCROLLED_KEYS.has(prevLk)) {
    jdPruneSmallSet(JD_LIST_USER_SCROLLED_KEYS, 12);
    JD_LIST_USER_SCROLLED_KEYS.add(nextLk);
  }
}

function jdPruneSeenIdsMap() {
  while (JD_SEEN_CLIENT_IDS_BY_LIST_KEY.size > 16) {
    const k = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.keys().next().value;
    if (k != null) JD_SEEN_CLIENT_IDS_BY_LIST_KEY.delete(k);
  }
  while (JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.size > 10) {
    const k = JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.keys().next().value;
    if (k != null) JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.delete(k);
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
  return JD_WORKFLOW_IN_FLIGHT_KEYS.has(bk) || jdIsCurrentListFullyScrolled();
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

/** Liste courte : tout le contenu tient sans barre de scroll (diagnostic interne). */
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

/** Scroll utilisateur explicite sur le panneau liste (wheel / scroll / scrollend). */
function jdHasUserScrolledCurrentList() {
  const lk = jdListPageKey();
  if (!lk) return false;
  return JD_LIST_USER_SCROLLED_KEYS.has(lk);
}

/** `start` brut de la clé liste ('' si absent — distinct de start=0 explicite). */
function jdListKeyStartRaw(lk) {
  try {
    const q = String(lk || '').indexOf('?');
    if (q < 0) return '';
    return new URLSearchParams(lk.slice(q + 1)).get('start') || '';
  } catch (_) {
    return '';
  }
}

function jdIsCurrentListFullyScrolled() {
  const lk = jdListPageKey();
  if (!lk) return false;
  if (JD_FULLY_SCROLLED_LIST_KEYS.has(lk)) return true;
  // LinkedIn retire souvent `start=` pendant les clics Jobdesk : le gate reste sur
  // `…&start=25` alors que l’URL courante n’a plus le param → sans heal, tick strip les labels.
  const canon = jdCanonicalListKeyFromLk(lk);
  if (!canon) return false;
  const curStart = jdListKeyStartRaw(lk);
  for (const k of JD_FULLY_SCROLLED_LIST_KEYS) {
    if (jdCanonicalListKeyFromLk(k) !== canon) continue;
    const ks = jdListKeyStartRaw(k);
    if (ks === curStart) {
      jdPruneSmallSet(JD_FULLY_SCROLLED_LIST_KEYS, 12);
      JD_FULLY_SCROLLED_LIST_KEYS.add(lk);
      return true;
    }
    // Flap : URL sans start= alors qu’une page start=N de cette recherche est « done ».
    // (Pas l’inverse start=N vs gate sans start — ça casserait la pagination 0→25.)
    if (!curStart && ks) {
      jdPruneSmallSet(JD_FULLY_SCROLLED_LIST_KEYS, 12);
      JD_FULLY_SCROLLED_LIST_KEYS.add(lk);
      return true;
    }
  }
  return false;
}

function jdMarkCurrentListFullyScrolled(reason = '') {
  const lk = jdListPageKey();
  if (!lk) return false;
  if (JD_FULLY_SCROLLED_LIST_KEYS.has(lk)) return false;
  jdPruneSmallSet(JD_FULLY_SCROLLED_LIST_KEYS, 12);
  JD_FULLY_SCROLLED_LIST_KEYS.add(lk);
  jdLog('jd_gate', { lk, y: 'open', r: String(reason || '').slice(0, 60) });
  try {
    pnSetPageStatus('idle', 'Attente');
  } catch (_) {}
  return true;
}

let __jdScrollRootHooked = null;
let __jdScrollEndTimer = null;
const JD_SCROLL_END_MS = 280;
/** Une fois par élément scroll racine : sonder après branchement tardif (évite reload si SPA restaure le scroll avant nos listeners). */
const jdScrollHookProbeTimers = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

/**
 * Rattrapage après branchement tardif du scroll root / entrée SPA.
 * - Liste courte (pas de scroll nécessaire) → démarrer comme « bas atteint »
 * - Liste déjà au bas avec scrollTop > 0 → preuve de scroll avant nos listeners
 */
function jdTryKickWorkflowAfterScrollHook(reason = '') {
  try {
    if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
    mergeSeenClientJobsFromDom();
    const lk = jdListPageKey();
    if (!lk) return;
    if (JD_LIST_USER_SCROLLED_KEYS.has(lk)) {
      if (jdHasReachedBottomForCurrentList()) jdOnListScrollFinished();
      return;
    }
    const root = jdGetLikelyJobsListScrollRoot();
    if (!root) return;
    const noScrollNeeded = jdListHasNoScrollNeeded();
    const atBottom = jdHasReachedBottomForCurrentList();
    if (!noScrollNeeded && !atBottom) return;
    const overflow = root.scrollHeight - root.clientHeight;
    const st = Number(root.scrollTop) || 0;
    // Liste scrollable : exiger un scrollTop > 0 (restauration SPA) sauf si vraiment sans overflow
    if (!noScrollNeeded && st <= 1) return;
    jdNoteListScrollActivity();
    jdOnListScrollFinished();
    if (reason && typeof jdLog === 'function') {
      jdLog('jd_boot', {
        r: String(reason || '').slice(0, 48),
        st: Math.round(st),
        ov: Math.round(overflow),
        nosc: !!noScrollNeeded
      });
    }
  } catch (_) {}
}

/** Entrée SPA /jobs/* : rebrancher le scroll root + kicks différés (liste monte après pushState). */
let __jdWakeSpaTimer = null;
let __jdWakeLastCanonical = '';
function jdWakeAfterSpaPathChange(reason = '') {
  try {
    if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
    const canon = jdCanonicalListKeyFromLk(jdListPageKey()) || '';
    mergeSeenClientJobsFromDom();
    // Même recherche (seul currentJobId / eBP change) → ne pas re-kick (bloque le Jobdesk).
    if (__jdWakeLastCanonical && canon && __jdWakeLastCanonical === canon) return;
    __jdWakeLastCanonical = canon;

    __jdScrollRootHooked = null;
    jdEnsureListScrollRootListener(reason || 'spa-wake');
    jdTryKickWorkflowAfterScrollHook(reason || 'spa-wake');
    if (__jdWakeSpaTimer) clearTimeout(__jdWakeSpaTimer);
    __jdWakeSpaTimer = setTimeout(() => {
      __jdWakeSpaTimer = null;
      try {
        if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) return;
        jdEnsureListScrollRootListener(`${reason || 'spa'}-d1200`);
        jdTryKickWorkflowAfterScrollHook(`${reason || 'spa'}-d1200`);
      } catch (_) {}
    }, 1200);
  } catch (_) {}
}

/** Arrête l’auto-open si l’utilisateur clique manuellement une offre (ne pas lutter avec LinkedIn). */
function jdAbortAutoOpenForUserNavigation(reason = '') {
  try {
    openClientJobsSequenceRunning = false;
    autoOpenRunQueued = false;
    if (autoOpenCoalesceTimer) {
      clearTimeout(autoOpenCoalesceTimer);
      autoOpenCoalesceTimer = null;
    }
    deferredAutoOpenWhileTabHidden = false;
    autoOpenDisabledUntil = Date.now() + 8000;
    jdLog('jd_nav', { r: 'user-abort-auto', why: String(reason || '').slice(0, 40) });
  } catch (_) {}
}

try {
  window.jdWakeAfterSpaPathChange = jdWakeAfterSpaPathChange;
  window.jdTryKickWorkflowAfterScrollHook = jdTryKickWorkflowAfterScrollHook;
} catch (_) {}

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
  if (typeof collectJobCards === 'function' && collectJobCards().length < 1) {
    setTimeout(() => {
      if (jdHasUserScrolledCurrentList() && jdHasReachedBottomForCurrentList()) {
        jdOnListScrollFinished();
      }
    }, 900);
    return;
  }
  jdTryStartListWorkflow('scroll-finished');
}

function jdScheduleScrollFinishedCheck() {
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
    root.addEventListener(
      'scroll',
      () => {
        jdNoteListScrollActivity();
        jdScheduleScrollFinishedCheck();
      },
      { passive: true }
    );
    root.addEventListener(
      'scrollend',
      () => {
        jdNoteListScrollActivity();
        jdOnListScrollFinished();
      },
      { passive: true }
    );
    root.addEventListener(
      'wheel',
      () => {
        jdNoteListScrollActivity();
      },
      { passive: true }
    );
  } catch (_) {
    try {
      root.addEventListener(
        'scroll',
        () => {
          jdNoteListScrollActivity();
          jdScheduleScrollFinishedCheck();
        },
        { passive: true }
      );
    } catch (_) {}
  }
  if (newlyHooked) jdScheduleKickAfterScrollHook(root, hookReason || 'scroll-hook');
  return root;
}

/** Démarre le workflow (badges → clics Client/SS2I), une fois par page après scroll complet.
 *  - JD_FULLY_SCROLLED_LIST_KEYS  : gate par page complète (lk avec start) → page 2, 3... peuvent passer
 *  - JD_WORKFLOW_IN_FLIGHT_KEYS   : verrou pendant le classify (bk sans start) → évite doublons pendant scroll
 */
function jdTryStartListWorkflow(reason = '') {
  if (typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning) {
    return false;
  }
  if (typeof classificationPassRunning !== 'undefined' && classificationPassRunning) {
    return false;
  }
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

/** Cherche la carte DOM d'une offre par son ID LinkedIn (pour un vrai clic plutôt qu'un simple sync d'URL). */
function jdFindJobCardWrapperById(jid) {
  const id = String(jid || '').trim();
  if (!id) return null;
  const matchesId = (w) => {
    try {
      const { jobUrl } = getJobInfoFromWrapper(w);
      if ((getJobIdFromWrapper(w, jobUrl) || '') === id) return true;
      if (w.getAttribute?.('data-job-id') === id) return true;
      if (w.getAttribute?.('data-occludable-job-id') === id) return true;
      if (w.querySelector?.(`[href*="${id}"]`)) return true;
    } catch (_) {}
    return false;
  };
  try {
    // 1) Cartes déjà classées Client/SS2I
    const aspirable = querySelectorAllDeep(document, pnAspirableJobCardsSelector());
    for (const w of aspirable) {
      if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(w)) continue;
      if (matchesId(w)) return w;
    }
  } catch (_) {}
  try {
    // 2) Toutes les cartes liste (virtualisation / badge pas encore collé)
    const cards = typeof collectJobCards === 'function' ? collectJobCards() : [];
    for (const w of cards) {
      if (typeof isJobCardInListColumn === 'function' && !isJobCardInListColumn(w)) continue;
      if (matchesId(w)) return w;
    }
  } catch (_) {}
  try {
    // 3) Attributs LinkedIn directs
    const byAttr =
      document.querySelector(`[data-job-id="${id}"]`) ||
      document.querySelector(`[data-occludable-job-id="${id}"]`) ||
      document.querySelector(`a[href*="/jobs/view/${id}"]`)?.closest?.(
        'li, div[componentkey], article, .job-card-container'
      );
    if (byAttr && (!(typeof isJobCardInListColumn === 'function') || isJobCardInListColumn(byAttr))) {
      return byAttr;
    }
  } catch (_) {}
  return null;
}

/** Tous les jobs Client + SS2I actuellement présents dans le DOM (colonne liste). */
function harvestAllClientJobIdsInListColumn() {
  const ids = [];
  const seen = new Set();
  try {
    const nodes = querySelectorAllDeep(document, pnAspirableJobCardsSelector());
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

/** Toutes les offres visibles dans la colonne liste (pour last_seen_at en base). */
function harvestAllJobIdsInListColumn() {
  const ids = [];
  const seen = new Set();
  try {
    const cards = typeof collectJobCards === 'function' ? collectJobCards() : [];
    for (const w of cards) {
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

function scheduleLastSeenTouchForJobIds(linkedinJobIds, reason) {
  const ids = (linkedinJobIds || [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!ids.length) return;
  try {
    sendRuntimeMessageSafe({ action: 'touchSavedJobsLastSeen', linkedinJobIds: ids, reason }, () => {});
  } catch (_) {}
}

function flushLastSeenTouchForListKey(lk, reason) {
  if (!lk) return;
  const sk = jdStripStartFromListKey(lk) || lk;
  const set = JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.get(sk);
  if (!set || set.size === 0) {
    JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.delete(sk);
    return;
  }
  scheduleLastSeenTouchForJobIds(Array.from(set), reason || 'list-flush');
  JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.delete(sk);
}

function mergeSeenClientJobsFromDom() {
  const lk = jdListPageKey();
  const sk = jdStableListKey();
  if (!lk) {
    if (jdMergeLastLk) {
      const prevSk = jdStripStartFromListKey(jdMergeLastLk) || jdMergeLastLk;
      flushAccumulatedClientJobIdsForListKey(prevSk, 'left-jobs-list');
      flushLastSeenTouchForListKey(prevSk, 'left-jobs-list');
      jdClearListGatingState(jdMergeLastLk);
      jdMergeLastLk = '';
      scheduleJobsTabSupabaseFlush();
    }
    return;
  }
  let listKeyChanged = false;
  if (jdMergeLastLk && jdMergeLastLk !== lk) {
    if (jdIsStartOnlyListKeyChange(jdMergeLastLk, lk)) {
      // Soft : LinkedIn a bougé start= / eBP= / currentJobId — garder badges + gates.
      const prevStart = (() => {
        try {
          return new URLSearchParams(String(jdMergeLastLk).split('?')[1] || '').get('start') || '0';
        } catch (_) {
          return '0';
        }
      })();
      const nextStart = (() => {
        try {
          return new URLSearchParams(String(lk).split('?')[1] || '').get('start') || '0';
        } catch (_) {
          return '0';
        }
      })();
      const startChanged = prevStart !== nextStart;
      if (startChanged) {
        // LinkedIn bascule souvent start= (absent ↔ 25) à chaque clic d’offre pendant le scrape.
        // Ne jamais strip / reset le gate mid-sequence — sinon labels reload + cancels en cascade.
        const seqRunning =
          typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning;
        const prevN = parseInt(prevStart, 10) || 0;
        const nextN = parseInt(nextStart, 10) || 0;
        const prevFullyScrolled = JD_FULLY_SCROLLED_LIST_KEYS.has(jdMergeLastLk);
        // Pagination réelle : start augmente clairement (page N → N+1), hors scrape.
        const realForwardPage =
          !seqRunning && prevFullyScrolled && nextN > prevN && nextN - prevN >= 10;
        if (realForwardPage) {
          jdClearListGatingState(lk);
          try {
            if (typeof window.pnStripVisibleListBadges === 'function') {
              window.pnStripVisibleListBadges();
            }
          } catch (_) {}
          jdLog('jd_nav', {
            r: 'start-soft-newpage',
            from: String(jdMergeLastLk).slice(0, 100),
            to: String(lk).slice(0, 100)
          });
        } else {
          jdCarryScrollGatesAcrossStartChange(jdMergeLastLk, lk);
          if (JD_LIST_USER_SCROLLED_KEYS.has(jdMergeLastLk)) {
            jdPruneSmallSet(JD_LIST_USER_SCROLLED_KEYS, 12);
            JD_LIST_USER_SCROLLED_KEYS.add(lk);
          }
          jdLog('jd_nav', {
            r: seqRunning ? 'start-soft-seq-hold' : 'start-soft',
            from: String(jdMergeLastLk).slice(0, 100),
            to: String(lk).slice(0, 100)
          });
        }
      } else {
        // Clic offre (eBP / currentJobId) : ne jamais strip les badges.
        jdCarryScrollGatesAcrossStartChange(jdMergeLastLk, lk);
        jdLog('jd_nav', {
          r: 'volatile-soft',
          from: String(jdMergeLastLk).slice(0, 100),
          to: String(lk).slice(0, 100)
        });
      }
    } else {
      const prevSk = jdStripStartFromListKey(jdMergeLastLk) || jdMergeLastLk;
      flushAccumulatedClientJobIdsForListKey(prevSk, 'list-url-changed');
      flushLastSeenTouchForListKey(prevSk, 'list-url-changed');
      jdClearListGatingState(jdMergeLastLk);
      // Nouvelle recherche / autre collection : force un re-scroll sur la destination.
      jdClearListGatingState(lk);
      __jdScrollRootHooked = null;
      listKeyChanged = true;
    }
  }
  // Clients : compteur + pending par page (clé avec start=) — pas de cumul 0→175.
  if (!JD_SEEN_CLIENT_IDS_BY_LIST_KEY.has(lk)) {
    jdPruneSeenIdsMap();
    JD_SEEN_CLIENT_IDS_BY_LIST_KEY.set(lk, new Set());
  }
  const set = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.get(lk);
  for (const id of harvestAllClientJobIdsInListColumn()) set.add(id);
  // last_seen : cumul sur la collection (clé stable sans start=)
  if (!JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.has(sk)) {
    jdPruneSeenIdsMap();
    JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.set(sk, new Set());
  }
  const allSet = JD_SEEN_ALL_JOB_IDS_BY_LIST_KEY.get(sk);
  for (const id of harvestAllJobIdsInListColumn()) allSet.add(id);
  jdMergeLastLk = lk;
  if (listKeyChanged) scheduleJobsTabSupabaseFlush();
}

/** Envoie une fois vers Supabase la liste cumulée pour la collection, puis vide les pages locales. */
function flushAccumulatedClientJobIdsForListKey(lk, reason) {
  if (!lk) return;
  const sk = jdStripStartFromListKey(lk) || lk;
  const merged = new Set();
  const keysToDelete = [];
  for (const [k, set] of JD_SEEN_CLIENT_IDS_BY_LIST_KEY) {
    if (k === lk || k === sk || (jdStripStartFromListKey(k) || k) === sk) {
      for (const id of set) merged.add(id);
      keysToDelete.push(k);
    }
  }
  for (const k of keysToDelete) JD_SEEN_CLIENT_IDS_BY_LIST_KEY.delete(k);
  if (merged.size === 0) return;
  const sorted = Array.from(merged).sort();
  const joined = sorted.join(',');
  const n = sorted.length;
  const r = String(reason || '').slice(0, 60);
  if (joined.length <= JD_LIST_IDS_CHUNK_CHARS) {
    jdLog('jd_list', { lk: sk, n, r, ids: joined });
  } else {
    const pt = Math.ceil(joined.length / JD_LIST_IDS_CHUNK_CHARS);
    for (let pi = 0; pi < pt; pi++) {
      const chunk = joined.slice(pi * JD_LIST_IDS_CHUNK_CHARS, (pi + 1) * JD_LIST_IDS_CHUNK_CHARS);
      jdLog('jd_list', { lk: sk, n, r, pi, pt, ids: chunk });
    }
  }
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
    const nodes = querySelectorAllDeep(document, pnAspirableJobCardsSelector());
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

/** Pause courte après un scrape complet (l’attente principale est dans scheduleJobOfferScrape). */
function randomDelayMsAfterScrapeComplete() {
  return Math.round(350 + Math.random() * 450);
}

async function jdAwaitJobScrapeAfterOpen(wrapper, jid, lk) {
  // search-results : l’encart « Infos entreprise » charge souvent mal → description suffit.
  let requireCompanyInsight = true;
  try {
    const p = String(location.pathname || '');
    if (p.includes('/jobs/search-results') || p.includes('/jobs/search/')) {
      requireCompanyInsight = false;
    }
  } catch (_) {}
  const scrapeRes = await scheduleJobOfferScrape(wrapper, {
    o: 'a',
    jid: jid || undefined,
    waitForSupabaseComplete: true,
    requireCompanyInsight
  });
  // Succès si sauvé (confirmé) OU ok avec saveOk (réseau lent / présence différée).
  if (
    scrapeRes?.state === 'ok' &&
    (scrapeRes?.persistedComplete || scrapeRes?.saveOk)
  ) {
    return scrapeRes;
  }
  if (jid && lk) {
    jdGetOpenedIdsSetForListKey(lk).delete(jid);
  }
  if (wrapper) {
    const k = dedupeKeyForCard(wrapper);
    if (k) autoOpenedClientJobKeys.delete(k);
  }
  jdLog('jd_fail', {
    jid: String(jid || ''),
    m: 'scrape',
    st: String(scrapeRes?.state || 'e'),
    pc: scrapeRes?.persistedComplete ? 1 : 0
  });
  return scrapeRes;
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
  const all = querySelectorAllDeep(document, pnAspirableJobCardsSelector()).filter(
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
    // Pas de popstate : ça casse souvent le panneau Jobdesk search-results (panel=0).
    window.history.replaceState(nextState, '', u.toString());
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

  let clicked = false;
  if (getJobIdFromComponentKey(wrapper) && wrapper.getAttribute('role') === 'button') {
    dispatchSyntheticPointerClick(wrapper);
    clicked = true;
  } else {
    const link = getJobOpenLinkFromCard(wrapper);
    if (link) {
      try {
        link.focus({ preventScroll: true });
      } catch (_) {}
      dispatchSyntheticPointerClick(link);
      clicked = true;
    } else if (tryClickJobCardOpenTarget(wrapper)) {
      clicked = true;
    }
  }
  // Sync URL seulement après un vrai clic (évite replaceState seul qui laisse panel vide).
  if (clicked && jobId) {
    try {
      syncUrlCurrentJobId(jobId);
    } catch (_) {}
  }
  return clicked;
}

function jdIsSafeJobOpenHref(href) {
  const h = String(href || '').toLowerCase();
  if (!h || h === '#' || h.startsWith('javascript:')) return false;
  // Jamais naviguer hors liste jobs (help « I’m interested », company/life…).
  if (
    h.includes('/help/') ||
    h.includes('/company/') ||
    h.includes('/in/') ||
    h.includes('/preload') ||
    h.includes('interested')
  ) {
    return false;
  }
  return (
    h.includes('/jobs/view/') ||
    h.includes('/jobs/search') ||
    h.includes('/jobs/collections') ||
    h.includes('currentjobid=') ||
    /\/jobs\/[^/?#]+-emplois/i.test(h)
  );
}

function getJobOpenLinkFromCard(wrapper) {
  const prefer = [
    'a[href*="/jobs/view/"]',
    'a[href*="/jobs/search/"]',
    'a[href*="/jobs/search-results"]',
    'a[href*="/jobs/collections"][href*="currentJobId="]',
    'a[href*="/jobs?"]',
    'a[href*="linkedin.com/jobs/"]',
    'a[href*="/jobs/"]'
  ];
  for (const sel of prefer) {
    const a = wrapper.querySelector(sel);
    if (a && jdIsSafeJobOpenHref(a.getAttribute('href'))) return a;
  }
  const roleLink = wrapper.querySelector('[role="link"][href]');
  if (roleLink && jdIsSafeJobOpenHref(roleLink.getAttribute('href'))) return roleLink;
  return null;
}

function tryClickJobCardOpenTarget(wrapper) {
  if (!wrapper) return false;
  const candidates = [
    () => wrapper.querySelector('a[href*="/jobs/view/"]'),
    () => wrapper.querySelector('a[href*="currentJobId="]'),
    () => wrapper.querySelector('[role="button"][tabindex]'),
    () => wrapper.querySelector('.job-card-container__link'),
    () => wrapper.querySelector('[class*="job-card-list__title"]'),
    () => (wrapper.getAttribute?.('role') === 'button' ? wrapper : null)
  ];
  for (const getEl of candidates) {
    const el = getEl();
    if (!el || typeof el.click !== 'function') continue;
    if (el.tagName === 'A' && !jdIsSafeJobOpenHref(el.getAttribute('href'))) continue;
    if (el.closest?.('a[href*="/company/"], a[href*="/help/"], a[href*="/in/"]')) continue;
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
  const nodes = querySelectorAllDeep(document, pnAspirableJobCardsSelector());
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
  // Compteur / pending : page courante (clé avec start=), pas le cumul collection.
  const set = JD_SEEN_CLIENT_IDS_BY_LIST_KEY.get(lk);
  if (!set || set.size === 0) return [];
  return Array.from(set)
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .sort();
}

async function getPendingClientJobIdsForCurrentList() {
  const lk = jdListPageKey();
  const sk = jdStableListKey();
  if (!lk || !sk) return { lk: '', ids: [], presentCount: 0, totalSeen: 0 };
  const seenIds = getSeenClientJobIdsForListKey(lk);
  if (!seenIds.length) return { lk: sk, ids: [], presentCount: 0, totalSeen: 0 };

  // Ouverts : clé stable pour ne pas recliquer la même offre sur une autre page start=
  const opened = jdGetOpenedIdsSetForListKey(sk);
  const baseIds = seenIds.filter((id) => !opened.has(id));
  if (!baseIds.length) return { lk: sk, ids: [], presentCount: 0, totalSeen: seenIds.length };

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
  return { lk: sk, ids, presentCount, totalSeen: seenIds.length };
}

let openClientJobsSequenceRunning = false;
let autoOpenCoalesceTimer = null;
let autoOpenRunQueued = false;
let autoOpenDisabledUntil = 0;
let lastAutoOpenRunAt = 0;
let autoOpenAfterClientTimer = null;
/** File reportée tant que l’onglet LinkedIn n’est pas visible. */
let deferredAutoOpenWhileTabHidden = false;

function pnEnsurePageStatusPill() {
  let el = document.getElementById('pn-page-status');
  if (el) {
    pnMountPageStatusInDock(el);
    return el;
  }
  el = document.createElement('div');
  el.id = 'pn-page-status';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<span class="pn-page-status__dot" aria-hidden="true"></span><span class="pn-page-status__label"></span>';
  if (!pnMountPageStatusInDock(el)) {
    try {
      document.documentElement.appendChild(el);
    } catch (_) {
      return null;
    }
  }
  return el;
}

/** Place le compteur à droite de « Prospection » dans le bandeau du dock gauche. */
function pnMountPageStatusInDock(el) {
  if (!el) return false;
  try {
    if (typeof ensureFinancialDock === 'function') ensureFinancialDock();
  } catch (_) {}
  const host =
    document.querySelector('.lph-financial-dock__status-host') ||
    document.querySelector('[data-pn-status-host="1"]');
  if (!host) return false;
  if (el.parentElement !== host) {
    try {
      host.appendChild(el);
    } catch (_) {
      return false;
    }
  }
  return true;
}

/**
 * Pastille bas-droite : idle | running | ready
 * Libellés : « 5/10 » = 5 offres déjà traitées / 10 aspirables (Client+SS2I) vues sur la liste.
 * @param {'idle'|'running'|'ready'} state
 * @param {string} [label]
 */
function pnSetPageStatus(state, label) {
  const el = pnEnsurePageStatusPill();
  if (!el) return;
  const st = state === 'running' || state === 'ready' ? state : 'idle';
  el.dataset.state = st;
  el.dataset.visible = '1';
  const labelEl = el.querySelector('.pn-page-status__label');
  if (labelEl) {
    labelEl.textContent =
      label ||
      (st === 'running' ? '…' : st === 'ready' ? 'OK' : 'Attente');
  }
}

/** @param {number} done Offres déjà OK (base + cliquées) @param {number} total Offres aspirables vues sur la liste */
function pnSetPageStatusRunning(done, total) {
  const d = Math.max(0, Number(done) || 0);
  const t = Math.max(0, Number(total) || 0);
  const shown = t > 0 ? Math.min(d, t) : d;
  pnSetPageStatus('running', t > 0 ? `${shown}/${t}` : '…');
}

/** @param {{ done?: number, scraped?: number, known?: number, total?: number }} [opts] */
function pnSetPageStatusReady(opts) {
  const total = Number(opts?.total);
  const doneExplicit = Number(opts?.done);
  const scraped = Number(opts?.scraped);
  const known = Number(opts?.known);
  const t = Number.isFinite(total) && total > 0 ? total : 0;
  const d = Number.isFinite(doneExplicit)
    ? doneExplicit
    : Math.max(
        0,
        (Number.isFinite(scraped) ? scraped : 0) + (Number.isFinite(known) ? known : 0)
      );
  if (t > 0) {
    const shown = Math.min(Math.max(d, 0), t);
    pnSetPageStatus('ready', `OK · ${shown}/${t}`);
    return;
  }
  pnSetPageStatus('ready', 'OK');
}

function requestAutoOpenRun(reason = '') {
  const now = Date.now();
  if (now < autoOpenDisabledUntil) return;
  if (!isJobsListSpaPath()) return;
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
  // Pendant une séquence de clics : ne pas re-planifier (évite cancels + reclassif).
  if (typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning) {
    return;
  }
  if (!jdIsCurrentListFullyScrolled()) return;
  if (autoOpenAfterClientTimer) clearTimeout(autoOpenAfterClientTimer);
  autoOpenAfterClientTimer = setTimeout(() => {
    autoOpenAfterClientTimer = null;
    if (typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning) {
      return;
    }
    if (!jdIsCurrentListFullyScrolled()) return;
    requestAutoOpenRun('after-client-classified');
  }, AUTO_OPEN_AFTER_CLIENT_MS);
}

async function tryAutoOpenNewVisibleClientJobs() {
  if (Date.now() < autoOpenDisabledUntil) return;
  if (!isJobsListSpaPath()) {
    jdLog('jd_skip', { y: 'not_jobs_list', r: lastJdRunReason });
    return;
  }
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
    const totalClients = Math.max(
      pendingById.totalSeen || 0,
      pendingById.ids.length + pendingById.presentCount
    );
    const doneBase = Math.max(0, totalClients - pendingById.ids.length);
    pnSetPageStatusRunning(doneBase, totalClients);
    try {
      for (let i = 0; i < pendingById.ids.length; i++) {
        if (!isJobsListSpaPath()) {
          jdLog('jd_nav', { r: 'left-jobs-mid-seq' });
          break;
        }
        if (!pnTabVisibleForAutoOpen()) {
          deferredAutoOpenWhileTabHidden = true;
          autoOpenRunQueued = true;
          break;
        }
        const jid = pendingById.ids[i];
        // Compteur = succès seulement (pas i) — sinon 25/25 puis retour à 24/25 si échec.
        pnSetPageStatusRunning(doneBase + batchOpened, totalClients);
        try {
          // Léger : re-peindre depuis le cache seulement.
          // Ne PAS relancer pnEnsure… (classify + retries) entre chaque clic — ça ralentit énormément.
          if (typeof window.pnRepaintVisibleBadgesFromCache === 'function') {
            window.pnRepaintVisibleBadgesFromCache();
          }
        } catch (_) {}
        // Préférer un vrai clic sur la carte (si présente dans le DOM) : un simple
        // history.replaceState (syncUrlCurrentJobId) ne déclenche pas toujours le
        // chargement du panneau Jobdesk côté LinkedIn (liste paginée / carte hors virtualisation)
        // → panneau figé sur l'offre précédente et description jamais chargée (e_nodesc en boucle).
        const wrapperForJid = jdFindJobCardWrapperById(jid);
        let opened = false;
        let clickedReal = false;
        if (wrapperForJid) {
          opened = performAutoOpenClientJobActions(wrapperForJid);
          clickedReal = opened;
        }
        if (!opened) {
          opened = syncUrlCurrentJobId(jid);
        }
        let scrapeRes = null;
        if (opened) {
          if (clickedReal) saveJobCardSnapshot(wrapperForJid);
          jdLog('jd_click', {
            jid,
            i,
            m: pendingById.ids.length,
            r: `${lastJdRunReason}|id-pass`,
            ck: clickedReal ? 1 : 0
          });
          scrapeRes = await jdAwaitJobScrapeAfterOpen(clickedReal ? wrapperForJid : null, jid, pendingById.lk);
          // Marquer ouvert + compteur seulement si le panneau correspond vraiment au jid.
          if (scrapeRes?.state === 'ok') {
            jdGetOpenedIdsSetForListKey(pendingById.lk).add(jid);
            batchOpened += 1;
          } else if (scrapeRes?.state === 'e_jid' || scrapeRes?.state === 'e_nodesc') {
            // Ne pas rester bloqué 24/25 : offre sans panneau / sans desc → skip session.
            jdGetOpenedIdsSetForListKey(pendingById.lk).add(jid);
            batchOpened += 1;
            jdLog('jd_fail', {
              jid,
              m: scrapeRes.state === 'e_jid' ? 'panel_jid_mismatch' : 'nodesc_skip',
              i,
              r: lastJdRunReason,
              ck: clickedReal ? 1 : 0
            });
          }
        } else {
          jdLog('jd_fail', { jid, m: 'open-by-id', i, r: lastJdRunReason });
        }
        pnSetPageStatusRunning(doneBase + batchOpened, totalClients);
        if (
          opened &&
          (scrapeRes?.state === 'ok' ||
            scrapeRes?.state === 'e_nodesc' ||
            scrapeRes?.state === 'e_jid') &&
          i < pendingById.ids.length - 1
        ) {
          const stillHere = await sleepBetweenClicksOrUntilHidden(randomDelayMsAfterScrapeComplete());
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
      pnSetPageStatusReady({
        done: doneBase + batchOpened,
        scraped: batchOpened,
        known: pendingById.presentCount,
        total: totalClients
      });
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
      const openedById = jdGetOpenedIdsSetForListKey(jdStableListKey());
      if (openedById.has(jid)) return false;
    }
    return true;
  });

  if (pending.length === 0) {
    jdLog('jd_skip', { y: 'no_pending', r: lastJdRunReason });
    openClientJobsSequenceRunning = false;
    pnSetPageStatusReady({ scraped: 0, known: 0 });
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
    pnSetPageStatusReady({
      done: pending.length,
      scraped: 0,
      known: Object.keys(present || {}).length,
      total: pending.length || Object.keys(present || {}).length
    });
    return;
  }

  // openClientJobsSequenceRunning déjà = true (posé avant le premier await)
  let batchOpened = 0;
  const totalClients = pending.length;
  const doneBase = Math.max(0, totalClients - pendingToOpen.length);
  pnSetPageStatusRunning(doneBase, totalClients);
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
      pnSetPageStatusRunning(doneBase + batchOpened, totalClients);
      const jid = resolveJobIdForOpen(wrapper) || '';
      const sk = jdStableListKey();
      const opened = performAutoOpenClientJobActions(wrapper);
      let scrapeRes = null;
      if (opened) {
        saveJobCardSnapshot(wrapper);
        jdLog('jd_click', {
          jid: String(jid),
          lk: jdListPageKey() || undefined,
          i,
          m: pendingToOpen.length,
          r: lastJdRunReason
        });
        scrapeRes = await jdAwaitJobScrapeAfterOpen(wrapper, jid, sk);
        if (scrapeRes?.state === 'ok') {
          autoOpenedClientJobKeys.add(k);
          if (jid) jdGetOpenedIdsSetForListKey(sk).add(jid);
          dequeueClientJobOpenKey(k);
          batchOpened += 1;
        } else if (scrapeRes?.state === 'e_jid' || scrapeRes?.state === 'e_nodesc') {
          autoOpenedClientJobKeys.add(k);
          if (jid) jdGetOpenedIdsSetForListKey(sk).add(jid);
          dequeueClientJobOpenKey(k);
          batchOpened += 1;
          jdLog('jd_fail', {
            jid: String(jid),
            k: String(k).slice(0, 80),
            m: scrapeRes.state === 'e_jid' ? 'panel_jid_mismatch' : 'nodesc_skip',
            i,
            r: lastJdRunReason
          });
        }
      } else {
        jdLog('jd_fail', { jid: String(jid), k: String(k).slice(0, 80), m: 'open', i, r: lastJdRunReason });
      }
      pnSetPageStatusRunning(doneBase + batchOpened, totalClients);
      if (
        opened &&
        (scrapeRes?.state === 'ok' ||
          scrapeRes?.state === 'e_nodesc' ||
          scrapeRes?.state === 'e_jid') &&
        i < pendingToOpen.length - 1
      ) {
        const stillHere = await sleepBetweenClicksOrUntilHidden(randomDelayMsAfterScrapeComplete());
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
    pnSetPageStatusReady({
      done: doneBase + batchOpened,
      scraped: batchOpened,
      known: doneBase,
      total: totalClients
    });
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
  let lastCanon = '';
  let lastStart = '';
  const onPathChange = () => {
    // Navigation hors liste jobs (help, company/life…) : couper l’auto-open immédiatement.
    if (!isJobsListSpaPath()) {
      try {
        if (openClientJobsSequenceRunning && typeof pnCancelActiveJobScrape === 'function') {
          pnCancelActiveJobScrape('left-jobs');
        }
        openClientJobsSequenceRunning = false;
        autoOpenRunQueued = false;
        if (autoOpenCoalesceTimer) {
          clearTimeout(autoOpenCoalesceTimer);
          autoOpenCoalesceTimer = null;
        }
        jdLog('jd_nav', { r: 'left-jobs-abort', path: String(location.pathname || '').slice(0, 80) });
      } catch (_) {}
      lastCanon = '';
      lastStart = '';
      return;
    }
    let canon = '';
    let start = '0';
    try {
      const lk = jdListPageKey();
      canon = jdCanonicalListKeyFromLk(lk) || '';
      start = new URLSearchParams(String(lk).split('?')[1] || '').get('start') || '0';
    } catch (_) {}
    const sameList = lastCanon && canon && lastCanon === canon;
    const sameStart = lastStart === start;
    lastCanon = canon || lastCanon;
    lastStart = start;
    const seqRunning =
      typeof openClientJobsSequenceRunning !== 'undefined' && openClientJobsSequenceRunning;
    // Clic job (eBP/currentJobId) ou flap start= pendant scrape : merge seulement — pas de wake/kick.
    if (sameList && (sameStart || seqRunning)) {
      try {
        mergeSeenClientJobsFromDom();
      } catch (_) {}
      return;
    }
    if (typeof jdWakeAfterSpaPathChange === 'function') {
      jdWakeAfterSpaPathChange(sameList ? 'spa-start' : 'spa-nav');
    } else {
      mergeSeenClientJobsFromDom();
      __jdScrollRootHooked = null;
      jdEnsureListScrollRootListener('spa-nav');
      jdTryKickWorkflowAfterScrollHook('spa-nav-sync');
    }
  };
  try {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (...args) {
        const r = orig.apply(this, args);
        // Différé : ne pas bloquer le thread LinkedIn pendant replaceState.
        setTimeout(onPathChange, 0);
        return r;
      };
    };
    wrap('pushState');
    wrap('replaceState');
  } catch (_) {}
  window.addEventListener('popstate', () => {
    setTimeout(onPathChange, 0);
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
  const mo = new MutationObserver(() => {
    debouncedAutoOpenOnMutation();
  });
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
  /** Listeners SPA/scroll : toujours, même hors Jobs (sinon on rate le pushState feed → collections). */
  function installAlwaysOnJobdeskListeners() {
    if (window.__pnJobdeskListenersInstalled) return;
    window.__pnJobdeskListenersInstalled = true;
    installPnHistoryAutoOpenListener();
    installAutoOpenVisibilityListener();
    attachAutoOpenScrollListeners();
    installAutoOpenMutationObserver();
    window.addEventListener(
      'pagehide',
      () => {
        try {
          mergeSeenClientJobsFromDom();
          const lk = jdListPageKey();
          flushAccumulatedClientJobIdsForListKey(lk, 'pagehide');
          flushLastSeenTouchForListKey(lk, 'pagehide');
          jdMergeLastLk = '';
          sendRuntimeMessageSafe({ type: 'PN_FLUSH_JOBS_TAB_STATE' }, () => {});
        } catch (_) {}
      },
      { capture: true }
    );
  }

  /** Handlers Jobs (classify / scrape) : seulement sur pages classification. */
  function tryInstallJobdeskAutoOpen() {
    installAlwaysOnJobdeskListeners();
    if (window.__pnJobdeskAutoopenInstalled) {
      if (typeof isClassificationTargetPage === 'function' && isClassificationTargetPage()) {
        jdEnsureListScrollRootListener('poll');
      }
      return true;
    }
    if (typeof isClassificationTargetPage !== 'function' || !isClassificationTargetPage()) {
      return false;
    }
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

    attachUserClickJobdeskScrape();
    try {
      pnSetPageStatus('idle', 'En attente');
    } catch (_) {}

    jdEnsureListScrollRootListener('init');
    jdWakeAfterSpaPathChange('install-jobs');
    return true;
  }

  installAlwaysOnJobdeskListeners();
  tryInstallJobdeskAutoOpen();
  // SPA feed → /jobs/* : réessayer l’install Jobs + kick
  let __jdLastSpaPath = location.pathname + location.search;
  setInterval(() => {
    try {
      const p = location.pathname + location.search;
      const pathChanged = p !== __jdLastSpaPath;
      if (pathChanged) __jdLastSpaPath = p;
      const wasInstalled = !!window.__pnJobdeskAutoopenInstalled;
      tryInstallJobdeskAutoOpen();
      if (pathChanged && typeof isClassificationTargetPage === 'function' && isClassificationTargetPage()) {
        jdWakeAfterSpaPathChange('path-poll');
      } else if (!wasInstalled && window.__pnJobdeskAutoopenInstalled) {
        jdWakeAfterSpaPathChange('first-install');
      } else if (window.__pnJobdeskAutoopenInstalled) {
        jdEnsureListScrollRootListener('poll');
      }
    } catch (_) {}
  }, 900);
  [500, 1500, 3500].forEach((ms) => {
    setTimeout(() => {
      try {
        tryInstallJobdeskAutoOpen();
      } catch (_) {}
    }, ms);
  });
})();
