-- Première aspiration (figée) vs dernière vue LinkedIn (rafraîchie au scroll liste).
-- Exécuter dans Supabase : SQL Editor → Run

ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS first_scraped_at TIMESTAMPTZ;

COMMENT ON COLUMN saved_jobs.first_scraped_at IS
  'Premier scrape détail réussi (description). Jamais écrasé — début de la fenêtre « offre postée » observée.';

COMMENT ON COLUMN saved_jobs.last_seen_at IS
  'Dernière fois où l’offre était visible sur une liste LinkedIn Jobs (ou scrape détail). Fin de la fenêtre observée.';

-- Rétrocompat : reprendre la date du premier scrape détail déjà connu
UPDATE saved_jobs
SET first_scraped_at = details_scraped_at
WHERE first_scraped_at IS NULL
  AND details_scraped_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_jobs_first_scraped_at
  ON saved_jobs (first_scraped_at DESC)
  WHERE first_scraped_at IS NOT NULL;
