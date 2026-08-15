-- Bouclier LinkedIn « Offre d’emploi vérifiée » (verified job).
ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS linkedin_verified BOOLEAN;

COMMENT ON COLUMN saved_jobs.linkedin_verified IS
  'true si le bouclier LinkedIn « Offre d’emploi vérifiée » / Verified job est présent (liste ou détail).';

CREATE INDEX IF NOT EXISTS idx_saved_jobs_linkedin_verified
  ON saved_jobs (linkedin_verified)
  WHERE linkedin_verified IS NOT NULL;
