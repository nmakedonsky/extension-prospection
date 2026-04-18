-- Migration : pipeline financier 100 % LLM (plus de colonnes FMP ni de stubs Brave dans le JSON).
-- À exécuter une fois dans Supabase : SQL Editor → Run.
-- Ordre recommandé : 1) ce script 2) déployer l’extension qui lit financial_pipeline_cache.

BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS financial_pipeline_cache JSONB,
  ADD COLUMN IF NOT EXISTS financial_pipeline_cache_at TIMESTAMPTZ;

-- Reprise des données depuis l’ancien cache FMP (même contenu sémantique : entrée pipeline complète).
UPDATE companies
SET
  financial_pipeline_cache = fmp_payload,
  financial_pipeline_cache_at = fmp_updated_at
WHERE fmp_payload IS NOT NULL;

-- Supprimer d’éventuels restes FMP dans le JSON de cache.
UPDATE companies
SET financial_pipeline_cache = financial_pipeline_cache #- '{raw,fmp_snapshot}'
WHERE financial_pipeline_cache IS NOT NULL
  AND financial_pipeline_cache ? 'raw'
  AND financial_pipeline_cache->'raw' ? 'fmp_snapshot';

-- Retirer les fournisseurs obsolètes du JSON financial_providers.
UPDATE companies
SET financial_providers = financial_providers - 'financialmodelingprep' - 'brave_search'
WHERE financial_providers IS NOT NULL;

ALTER TABLE companies
  DROP COLUMN IF EXISTS fmp_payload,
  DROP COLUMN IF EXISTS fmp_updated_at,
  DROP COLUMN IF EXISTS fmp_provider,
  DROP COLUMN IF EXISTS fmp_status;

COMMIT;
