-- Requêtes utiles pour lire les logs émis par l’extension (table extension_logs).
-- À exécuter dans Supabase : SQL Editor → New query → Run
--
-- Affichage des timestamps (created_at, etc.) en heure de Paris pour cette session :
SET timezone = 'Europe/Paris';

-- 1) Dernières entrées (toutes sources)
SELECT id, source, level, event, page_url, tab_id, client_ts, created_at, data
FROM extension_logs
ORDER BY created_at DESC
LIMIT 100;

-- 2) Uniquement cette extension (inclut l’historique sous l’ancien nom extension-prospection-next)
SELECT id, level, event, page_url, client_ts, created_at, data
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
ORDER BY created_at DESC
LIMIT 200;

-- 3) Par type d’événement
SELECT event, level, COUNT(*) AS n
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
  AND created_at > now() - interval '7 days'
GROUP BY event, level
ORDER BY n DESC;

-- 4) Heartbeats page Jobs (aperçu activité liste)
SELECT created_at, page_url, data->>'cardCount' AS cards, data->>'companyCount' AS companies
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
  AND event = 'jobs_page_heartbeat'
ORDER BY created_at DESC
LIMIT 50;

-- 5) Classifications (Gemini ou première lecture Supabase)
SELECT created_at, data->>'company_name' AS company, data->>'type' AS type, data->>'via' AS via
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
  AND event = 'company_classified'
ORDER BY created_at DESC
LIMIT 100;

-- 6) Échecs classification
SELECT created_at, data->>'company_name' AS company, data->>'error' AS err
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
  AND event = 'classification_failed'
ORDER BY created_at DESC
LIMIT 50;

-- 7) Jobdesk auto-open / scrape (événements jd_* — payloads courts)
SELECT created_at, event, page_url, data
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
  AND event LIKE 'jd_%'
ORDER BY created_at DESC
LIMIT 200;

-- 8) Résumé jd_* sur 48h (comparer clics vs scrapes)
SELECT event, COUNT(*) AS n
FROM extension_logs
WHERE source IN ('extension-prospection', 'extension-prospection-next')
  AND event LIKE 'jd_%'
  AND created_at > now() - interval '48 hours'
GROUP BY event
ORDER BY n DESC;
