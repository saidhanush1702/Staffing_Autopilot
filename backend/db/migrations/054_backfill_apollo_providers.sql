-- 054_backfill_apollo_providers.sql
-- Purpose: give every organisation an Apollo row in organization_providers.
-- Phase: fix
--
-- ── WHAT WENT WRONG ───────────────────────────────────────────────────
--
-- Migration 041 backfilled Apollo for every organisation that existed at the
-- time. Every organisation created since then went through
-- createOrganization() instead, which only provisions rows for sources with
-- fetch_mode = 'PROVIDER'. Migration 045 reclassified Apollo to 'ENRICHMENT'
-- so it could not be picked as a search provider — a real fix for a real bug
-- — but nothing updated createOrganization() to match, so every agency
-- created after 045 landed got no Apollo row at all. Without a row, Apollo
-- can never be switched on for that agency: the toggle and
-- PATCH /api/management/contacts/provider both 404 on "no row to update".
--
-- createOrganization() is fixed in the same change as this migration. This
-- statement is the one-time repair for whichever agencies were created in
-- the gap between the two.
--
-- Same defaults as migration 041's original backfill and off by default,
-- for the same reason: switching a paid provider on is a decision an
-- ORG_ADMIN makes deliberately, not something a migration does for them.

INSERT INTO organization_providers
    (id, organization_id, source_id, is_enabled, monthly_budget, max_pages,
     rate_limit_ms, credential_env)
SELECT gen_random_uuid()::text, o.id, s.id, FALSE, 500, 1, 1000, 'APOLLO_API_KEY'
  FROM organizations o
 CROSS JOIN lkp_job_sources s
 WHERE s.name = 'APOLLO'
ON CONFLICT (organization_id, source_id) DO NOTHING;
