-- Champs filtrables issus du panneau Jobdesk LinkedIn
ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS employment_type TEXT,
  ADD COLUMN IF NOT EXISTS workplace_type TEXT,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_text TEXT,
  ADD COLUMN IF NOT EXISTS applicants_count INTEGER;

COMMENT ON COLUMN saved_jobs.employment_type IS
  'Type de contrat normalisé: cdi | cdd | freelance | internship | apprenticeship | temporary | part_time | full_time | other';
COMMENT ON COLUMN saved_jobs.workplace_type IS
  'Modalité normalisée: remote | hybrid | onsite | other';
COMMENT ON COLUMN saved_jobs.posted_at IS
  'Estimation date de publication LinkedIn (depuis « il y a X jours » / posted on).';
COMMENT ON COLUMN saved_jobs.posted_text IS
  'Libellé brut LinkedIn de la date de dépôt (ex. « il y a 5 jours »).';
COMMENT ON COLUMN saved_jobs.applicants_count IS
  'Nombre de candidats affiché (NULL si inconnu). « Moins de 10 » → 9 ; premiers candidats → 0.';

CREATE INDEX IF NOT EXISTS idx_saved_jobs_employment_type
  ON saved_jobs (employment_type)
  WHERE employment_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_jobs_workplace_type
  ON saved_jobs (workplace_type)
  WHERE workplace_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_jobs_posted_at
  ON saved_jobs (posted_at DESC)
  WHERE posted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_jobs_applicants_count
  ON saved_jobs (applicants_count)
  WHERE applicants_count IS NOT NULL;
