-- Légitimité employeur (Gemini + Google Search) — pastille Jobdesk / filtres hub.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS legitimacy_verdict TEXT
    CHECK (legitimacy_verdict IS NULL OR legitimacy_verdict IN ('real', 'recruiter', 'shell', 'uncertain')),
  ADD COLUMN IF NOT EXISTS legitimacy_india_bodyshop BOOLEAN,
  ADD COLUMN IF NOT EXISTS legitimacy_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS legitimacy_payload JSONB,
  ADD COLUMN IF NOT EXISTS legitimacy_at TIMESTAMPTZ;

COMMENT ON COLUMN companies.legitimacy_verdict IS
  'Gemini+Search: real | recruiter | shell | uncertain.';
COMMENT ON COLUMN companies.legitimacy_india_bodyshop IS
  'True if India bodyshop pattern (not large listed Indian IT).';
COMMENT ON COLUMN companies.legitimacy_confidence IS
  'Model confidence 0-100.';
COMMENT ON COLUMN companies.legitimacy_payload IS
  'Full legitimacy JSON: reasons, hq_country, website, legal_page_quality, model, searchQueries…';
COMMENT ON COLUMN companies.legitimacy_at IS
  'When legitimacy_* was last written.';

CREATE INDEX IF NOT EXISTS idx_companies_legitimacy_verdict
  ON companies (legitimacy_verdict)
  WHERE legitimacy_verdict IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_legitimacy_verdict_india
  ON companies (legitimacy_verdict, legitimacy_india_bodyshop)
  WHERE legitimacy_verdict IS NOT NULL;
