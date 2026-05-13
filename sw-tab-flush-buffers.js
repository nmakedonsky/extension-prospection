/**
 * Tampon par onglet (LinkedIn Jobs uniquement) : logs extension_logs + upserts saved_jobs
 * différés jusqu’au pagehide / fermeture d’onglet — limite les requêtes Supabase.
 * Lectures (présence jobs), LLM et autres actions hors Jobs restent immédiates.
 */

/** @type {Map<number, { logs: { event: string, data: object, level: string }[], jobs: { jobOffer: object, dedupKey: string|null }[], pendingDedupKeys: Set<string> }>} */
const PN_TAB_FLUSH_BUFFERS = new Map();

const PN_MAX_BUFFERED_LOGS_PER_TAB = 600;
const PN_MAX_BUFFERED_JOBS_PER_TAB = 200;

function pnIsLinkedInJobsTabUrl(tabUrl) {
  const u = String(tabUrl || '');
  return u.includes('linkedin.com') && u.includes('/jobs');
}

function pnTabFlushBucket(tabId, tabUrl) {
  if (typeof tabId !== 'number') return null;
  if (!pnIsLinkedInJobsTabUrl(tabUrl)) return null;
  if (!PN_TAB_FLUSH_BUFFERS.has(tabId)) {
    PN_TAB_FLUSH_BUFFERS.set(tabId, { logs: [], jobs: [], pendingDedupKeys: new Set() });
  }
  return PN_TAB_FLUSH_BUFFERS.get(tabId);
}

/**
 * @returns {boolean} true si mis en tampon (pas d’écriture immédiate).
 */
function pnBufferExtensionLogForTab(tabId, tabUrl, event, data, level) {
  const b = pnTabFlushBucket(tabId, tabUrl);
  if (!b) return false;
  while (b.logs.length >= PN_MAX_BUFFERED_LOGS_PER_TAB) b.logs.shift();
  b.logs.push({
    event: String(event || 'event').slice(0, 200),
    data: data && typeof data === 'object' ? data : {},
    level: level === 'warn' || level === 'error' ? level : 'info'
  });
  return true;
}

/**
 * @returns {boolean} true si mis en tampon.
 */
function pnBufferSaveJobOfferForTab(tabId, tabUrl, jobOffer, dedupKey) {
  const b = pnTabFlushBucket(tabId, tabUrl);
  if (!b) return false;
  const dk = dedupKey ? String(dedupKey).trim() : '';
  if (dk) b.pendingDedupKeys.add(dk);
  while (b.jobs.length >= PN_MAX_BUFFERED_JOBS_PER_TAB) {
    const dropped = b.jobs.shift();
    if (dropped?.dedupKey) b.pendingDedupKeys.delete(dropped.dedupKey);
  }
  b.jobs.push({ jobOffer, dedupKey: dk || null });
  return true;
}

/**
 * Marque comme « déjà présent » les offres encore seulement dans le tampon (évite re-clics auto).
 * @param {number} tabId
 * @param {string} tabUrl
 * @param {{ dedupKey?: string }[]} items
 * @param {Record<string, boolean>} present
 */
function pnMergeBufferedJobDedupKeys(tabId, tabUrl, items, present) {
  if (!pnIsLinkedInJobsTabUrl(tabUrl)) return present || {};
  const b = PN_TAB_FLUSH_BUFFERS.get(tabId);
  if (!b || !items?.length) return present || {};
  const merged = { ...(present || {}) };
  for (const it of items) {
    const k = it?.dedupKey;
    if (!k) continue;
    if (b.pendingDedupKeys.has(k)) merged[k] = true;
  }
  return merged;
}

async function pnFlushTabBuffer(tabId) {
  if (typeof tabId !== 'number') return;
  const b = PN_TAB_FLUSH_BUFFERS.get(tabId);
  if (!b) return;
  const logs = b.logs.slice();
  const jobs = b.jobs.slice();
  PN_TAB_FLUSH_BUFFERS.delete(tabId);
  for (const row of logs) {
    await postExtensionLog(row.event, row.data, row.level).catch(() => {});
  }
  for (const row of jobs) {
    try {
      await swSaveJobOffer(row.jobOffer);
    } catch (_) {}
  }
}
