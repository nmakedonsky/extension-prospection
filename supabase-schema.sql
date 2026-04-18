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
  ADD COLUMN IF NOT EXISTS details_scraped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_jobs_job_url_unique
  ON saved_jobs (job_url)
  WHERE job_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_jobs_company_name ON saved_jobs (company_name);
CREATE INDEX IF NOT EXISTS idx_saved_jobs_last_seen_at ON saved_jobs (last_seen_at DESC);

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

-- Flag re-scrape Jobdesk : si true, l’auto-open Client ne considère pas la fiche comme « complète » (même avec description + details_scraped_at).
ALTER TABLE saved_jobs
  ADD COLUMN IF NOT EXISTS needs_rescrape BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN saved_jobs.needs_rescrape IS
  'true = à re-scraper (détail LinkedIn). Remis à false après un enregistrement stage=detail réussi.';

-- À exécuter une fois après ajout de la colonne : marquer toutes les lignes déjà en base pour un passage auto.
-- UPDATE saved_jobs SET needs_rescrape = true;

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
