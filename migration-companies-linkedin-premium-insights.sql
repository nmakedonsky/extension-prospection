-- Insights LinkedIn Premium (Jobdesk) : priorités, recrutements, tendance, concurrents.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS linkedin_premium_insights JSONB,
  ADD COLUMN IF NOT EXISTS linkedin_premium_insights_at TIMESTAMPTZ;

COMMENT ON COLUMN companies.linkedin_premium_insights IS
  'Snapshot Jobdesk Premium : priorities, hiring/headcount, hiringTrend, competitors. Mis à jour à chaque scrape détail avec encart Premium.';

COMMENT ON COLUMN companies.linkedin_premium_insights_at IS
  'Dernière mise à jour de linkedin_premium_insights.';
