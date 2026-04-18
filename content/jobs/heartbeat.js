/** Heartbeat vers le background (optionnellement log Supabase). */

let lastLogAt = 0;
const LOG_INTERVAL_MS = 45000;

function sendHeartbeat(payload, forceLog) {
  const now = Date.now();
  const shouldLog = forceLog || now - lastLogAt >= LOG_INTERVAL_MS;
  if (shouldLog) lastLogAt = now;
  try {
    chrome.runtime.sendMessage({
      type: 'JOBS_PAGE_HEARTBEAT',
      payload: {
        ...payload,
        pageUrl: String(location.href || '').slice(0, 800),
        logToSupabase: shouldLog
      }
    });
  } catch (_) {}
}
