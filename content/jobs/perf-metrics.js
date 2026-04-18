/**
 * Métriques de perf pour les logs Supabase (jobs_page_heartbeat) :
 * durée collecte DOM, extraction noms, délai jusqu’à la 1re carte après changement de route.
 */

let pathKey = '';
let pathSegmentStartMs = performance.now();
let sawNonzeroCards = false;
let msToFirstNonzeroCards = null;

function pnResetPathSegment() {
  pathSegmentStartMs = performance.now();
  sawNonzeroCards = false;
  msToFirstNonzeroCards = null;
}

/**
 * À appeler au début de chaque buildScanPayload : reset si le chemin LinkedIn a changé (SPA).
 */
function pnSyncPathForPerf() {
  const p = String(location.pathname || '');
  if (p !== pathKey) {
    pathKey = p;
    pnResetPathSegment();
  }
}

/**
 * @param {number} cardCount
 * @param {number} collectMs
 * @param {number} extractCompaniesMs
 */
function pnNotifyScanStep(cardCount, collectMs, extractCompaniesMs) {
  if (cardCount > 0 && !sawNonzeroCards) {
    sawNonzeroCards = true;
    msToFirstNonzeroCards = Math.round(performance.now() - pathSegmentStartMs);
  }
  return {
    collectMs,
    extractCompaniesMs,
    msToFirstNonzeroCards,
    msSincePathSegment: Math.round(performance.now() - pathSegmentStartMs)
  };
}

/**
 * @param {number} passMs
 * @param {number} todoCount
 */
function pnRecordClassificationPass(passMs, todoCount) {
  try {
    window.__pnLastClassify = {
      passMs,
      todoCount,
      at: Date.now()
    };
  } catch (_) {}
}

function pnConsumeLastClassificationForPayload() {
  try {
    const c = window.__pnLastClassify;
    if (!c || typeof c.at !== 'number') return null;
    const age = Date.now() - c.at;
    if (age > 120000) return null;
    return {
      lastClassifyPassMs: c.passMs,
      lastClassifyTodo: c.todoCount,
      lastClassifyAgeMs: age
    };
  } catch (_) {
    return null;
  }
}
