-- 035_backfill_org_providers.sql
-- Purpose: give every organisation its provider rows, including ones created
--          after migration 031 ran.
-- Phase: 6

-- ── WHY THIS IS NEEDED TWICE ─────────────────────────────────────────────
--
-- 031 created organization_providers and backfilled a row for every agency that
-- existed at that moment. What it could not do is cover agencies created later,
-- and createOrganization was never taught to insert one — so any agency made
-- after 031 had no row, and the provider toggle refused it with "This provider
-- is not set up for your organisation." Discovery could never be switched on for
-- them at all.
--
-- The controller is fixed, so new agencies get their rows on creation. This
-- covers the ones already stranded in between.
--
-- Idempotent by the unique constraint, and it deliberately does NOT touch
-- existing rows: an agency that has already tuned its budget or turned a
-- provider off must not have that quietly reset by a migration.

INSERT INTO organization_providers
    (id, organization_id, source_id, is_enabled,
     monthly_budget, max_pages, rate_limit_ms, credential_env)
SELECT gen_random_uuid()::text, o.id, s.id,
       -- Off by default. Enabling a provider spends real money, so it is a
       -- decision an admin makes, never one a migration makes for them.
       FALSE,
       250,
       s.max_pages,
       s.rate_limit_ms,
       'SERPAPI_KEY'
  FROM organizations o
 CROSS JOIN lkp_job_sources s
 WHERE s.fetch_mode = 'PROVIDER'
ON CONFLICT (organization_id, source_id) DO NOTHING;
