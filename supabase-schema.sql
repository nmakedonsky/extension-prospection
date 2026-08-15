-- Exécuter ce script dans Supabase : SQL Editor → New query → coller → Run

-- Table des entreprises (cache + caractéristiques pour éviter de re-requêter le LLM)
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('Client', 'SS2I')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index pour les recherches par nom
CREATE INDEX IF NOT EXISTS idx_companies_company_name ON companies (company_name);

CREATE TABLE IF NOT EXISTS saved_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  company_type TEXT CHECK (company_type IN ('Client', 'SS2I')),
  linkedin_job_id TEXT UNIQUE,
  job_title TEXT,
  job_url TEXT,
  location TEXT,
  description_text TEXT,
  source TEXT NOT NULL DEFAULT 'linkedin_jobs',
  linkedin_data JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_scraped_at TIMESTAMPTZ,
  details_scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS company_name TEXT,
  ADD COLUMN IF NOT EXISTS company_type TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_job_id TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS job_url TEXT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS description_text TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'linkedin_jobs',
  ADD COLUMN IF NOT EXISTS linkedin_data JSONB,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS first_scraped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS details_scraped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_jobs_job_url_unique
  ON saved_jobs (job_url)
  WHERE job_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_jobs_company_name ON saved_jobs (company_name);
CREATE INDEX IF NOT EXISTS idx_saved_jobs_last_seen_at ON saved_jobs (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_saved_jobs_first_scraped_at
  ON saved_jobs (first_scraped_at DESC)
  WHERE first_scraped_at IS NOT NULL;

COMMENT ON COLUMN saved_jobs.first_scraped_at IS
  'Premier scrape détail réussi. Figé — proxy du début de publication observé.';

COMMENT ON COLUMN saved_jobs.last_seen_at IS
  'Dernière visibilité sur une liste LinkedIn Jobs (scroll) ou scrape détail.';

COMMENT ON COLUMN saved_jobs.first_seen_at IS
  'Première apparition en liste (carte), avant aspiration complète.';

COMMENT ON COLUMN saved_jobs.details_scraped_at IS
  'Date du dernier scrape détail réussi (description à jour).';

-- RLS (Row Level Security) : autoriser lecture/écriture avec la clé anon
-- À activer si tu veux restreindre l’accès plus tard
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon read and insert companies" ON companies;
CREATE POLICY "Allow anon read and insert companies"
  ON companies
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

ALTER TABLE saved_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon read and write saved_jobs" ON saved_jobs;
CREATE POLICY "Allow anon read and write saved_jobs"
  ON saved_jobs
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- Colonnes d'enrichissement financier (pipeline LLM uniquement)
-- financial_pipeline_cache : entrée complète du pipeline (data, unified, raw llm, companySummary…)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS financial_pipeline_cache JSONB,
  ADD COLUMN IF NOT EXISTS financial_pipeline_cache_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS llm_payload JSONB,
  ADD COLUMN IF NOT EXISTS llm_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS llm_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS llm_sources_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mode TEXT,
  ADD COLUMN IF NOT EXISTS unified_payload JSONB,
  ADD COLUMN IF NOT EXISTS score NUMERIC,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS sources_count INTEGER DEFAULT 0;

-- Brut par fournisseur (extensible : ajouter une clé sans migration de colonnes)
-- Convention JSON (financial_providers) :
--   _schema_version: entier (incrémenter si la forme des blocs change)
--   gemini_financial_extraction: { provider_id, label, fetched_at, status, data }
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS financial_providers JSONB;

-- URL LinkedIn canonique : écrite une seule fois à la création / premier scrape, puis figée.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS linkedin_company_url TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_company_slug TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_company_url_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS linkedin_company_url_source TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_linkedin_company_slug
  ON companies (linkedin_company_slug)
  WHERE linkedin_company_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_linkedin_company_url
  ON companies (linkedin_company_url)
  WHERE linkedin_company_url IS NOT NULL;

-- Insights LinkedIn Premium (Jobdesk) : priorités, recrutements, tendance, concurrents.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS linkedin_premium_insights JSONB,
  ADD COLUMN IF NOT EXISTS linkedin_premium_insights_at TIMESTAMPTZ;

COMMENT ON COLUMN companies.linkedin_premium_insights IS
  'Snapshot Jobdesk Premium : priorities, hiring/headcount, hiringTrend, competitors.';

COMMENT ON COLUMN companies.linkedin_premium_insights_at IS
  'Dernière mise à jour de linkedin_premium_insights.';

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

-- Flag re-scrape Jobdesk : si true, l’auto-open Client ne considère pas la fiche comme « complète » (même avec description + details_scraped_at).
ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS needs_rescrape BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN saved_jobs.needs_rescrape IS
  'true = à re-scraper (détail LinkedIn). Remis à false après un enregistrement stage=detail réussi.';

-- À exécuter une fois après ajout de la colonne : marquer toutes les lignes déjà en base pour un passage auto.
-- UPDATE saved_jobs SET needs_rescrape = true;

-- Filtres Jobdesk : contrat / modalité / date dépôt / candidats
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

-- Bouclier LinkedIn « Offre d’emploi vérifiée »
ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS linkedin_verified BOOLEAN;

COMMENT ON COLUMN saved_jobs.linkedin_verified IS
  'true si le bouclier LinkedIn « Offre d’emploi vérifiée » / Verified job est présent (liste ou détail).';

CREATE INDEX IF NOT EXISTS idx_saved_jobs_linkedin_verified
  ON saved_jobs (linkedin_verified)
  WHERE linkedin_verified IS NOT NULL;

-- Logs extension (diagnostic temps réel)
CREATE TABLE IF NOT EXISTS extension_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'linkedin-prospection-helper',
  level TEXT NOT NULL DEFAULT 'info',
  event TEXT NOT NULL,
  data JSONB,
  sender JSONB,
  page_url TEXT,
  tab_id INTEGER,
  frame_id INTEGER,
  client_ts TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extension_logs_created_at_desc ON extension_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extension_logs_event ON extension_logs (event);
CREATE INDEX IF NOT EXISTS idx_extension_logs_level ON extension_logs (level);

ALTER TABLE extension_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon read and write extension_logs" ON extension_logs;
CREATE POLICY "Allow anon read and write extension_logs"
  ON extension_logs
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);
