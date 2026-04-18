-- Requêtes utiles pour lire les logs émis par l’extension (table extension_logs).
-- À exécuter dans Supabase : SQL Editor → New query → Run

-- 1) Dernières entrées (toutes sources)
SELECT id, source, level, event, page_url, tab_id, client_ts, created_at, data
FROM extension_logs
ORDER BY created_at DESC
LIMIT 100;

-- 2) Uniquement cette extension (source = extension-prospection-next)
SELECT id, level, event, page_url, client_ts, created_at, data
FROM extension_logs
WHERE source = 'extension-prospection-next'
ORDER BY created_at DESC
LIMIT 200;

-- 3) Par type d’événement
SELECT event, level, COUNT(*) AS n
FROM extension_logs
WHERE source = 'extension-prospection-next'
  AND created_at > now() - interval '7 days'
GROUP BY event, level
ORDER BY n DESC;

-- 4) Heartbeats page Jobs (aperçu activité liste)
SELECT created_at, page_url, data->>'cardCount' AS cards, data->>'companyCount' AS companies
FROM extension_logs
WHERE source = 'extension-prospection-next'
  AND event = 'jobs_page_heartbeat'
ORDER BY created_at DESC
LIMIT 50;

-- 5) Classifications (Gemini ou première lecture Supabase)
SELECT created_at, data->>'company_name' AS company, data->>'type' AS type, data->>'via' AS via
FROM extension_logs
WHERE source = 'extension-prospection-next'
  AND event = 'company_classified'
ORDER BY created_at DESC
LIMIT 100;

-- 6) Échecs classification
SELECT created_at, data->>'company_name' AS company, data->>'error' AS err
FROM extension_logs
WHERE source = 'extension-prospection-next'
  AND event = 'classification_failed'
ORDER BY created_at DESC
LIMIT 50;
