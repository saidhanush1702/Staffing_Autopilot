-- 045_apollo_is_not_a_job_source.sql
-- Purpose: stop Apollo appearing as — and being selected as — the job SEARCH
--          provider on the Job Discovery screen.
-- Phase: fix
--
-- ── WHAT WENT WRONG ───────────────────────────────────────────────────
--
-- Migration 041 registered Apollo in `lkp_job_sources` with
-- `fetch_mode = 'PROVIDER'`. The reasoning was sound — it let Apollo reuse the
-- `organization_providers` machinery for per-agency enablement, monthly budget,
-- rate limit, health, and the NAME of the env var holding its key, none of
-- which was worth duplicating.
--
-- The cost was not noticed: `fetch_mode = 'PROVIDER'` is exactly the predicate
-- the DISCOVERY path uses to find its search providers. So Apollo — which
-- fetches CONTACTS and has never fetched a job in its life — became a
-- candidate search provider.
--
-- Then, in discoveryController.js:
--
--     const orgProvider = orgProviders.find((p) => p.is_enabled)
--                         ?? orgProviders[0] ?? null;
--
-- `loadProviders` orders `BY s.label`, and "Apollo (contact enrichment)" sorts
-- before "Google Jobs (via SerpApi)". So in any organisation where NO search
-- provider is switched on, that fallback selects APOLLO, and the screen
-- reports Apollo as the search provider — with Apollo's 500-credit budget and
-- APOLLO_API_KEY — while SerpApi sits switched off and invisible.
--
-- Observed in this database: Molina Staffing, Apex Staffing and test_new all
-- had GOOGLE_JOBS disabled, so all three displayed Apollo. Only
-- newtestorgmnl, which had GOOGLE_JOBS enabled, showed the truth.
--
-- Before migration 041 the same disabled state displayed correctly, because
-- the fallback had only one candidate to pick. That is why this looked like a
-- working setup two weeks ago and a broken one now: nothing about SerpApi
-- changed, the set it is chosen FROM did.
--
-- ── THE FIX, AND WHY IT IS A NEW fetch_mode ───────────────────────────
--
-- `fetch_mode` answers "how do postings get here from this source". For Apollo
-- the honest answer is "they do not" — it is a different kind of provider
-- entirely. Giving it its own mode fixes the problem at the definition rather
-- than by adding `AND s.name <> 'APOLLO'` to every query that reads the table,
-- which is the version that rots the moment a second enrichment provider is
-- added.
--
-- ── WHY THIS IS SAFE FOR CONTACT DISCOVERY ────────────────────────────
--
-- Verified before writing: `services/contactDiscovery.js` resolves Apollo by
-- NAME, not by fetch_mode —
--
--     WHERE op.organization_id = $1 AND s.name = 'APOLLO'
--
-- so nothing in the contacts path reads the column this changes. The
-- `organization_providers` row, the budget, the credential_env and the health
-- columns are all untouched, and the Contacts screen keeps rendering Apollo's
-- used/budget/remaining exactly as before. Apollo is not being removed or
-- disabled — only reclassified out of the job-search set.

/* ── 1. a mode for providers that enrich rather than fetch ────────────── */

ALTER TABLE lkp_job_sources
    DROP CONSTRAINT IF EXISTS lkp_job_sources_fetch_mode_check;

ALTER TABLE lkp_job_sources
    ADD CONSTRAINT lkp_job_sources_fetch_mode_check
    CHECK (fetch_mode IN ('PROVIDER', 'PORTAL', 'MANUAL', 'CSV', 'WEBHOOK', 'ENRICHMENT'));

/* ── 2. reclassify Apollo ─────────────────────────────────────────────── */

UPDATE lkp_job_sources
   SET fetch_mode = 'ENRICHMENT',
       label      = 'Apollo (contact enrichment)',
       notes      = 'Finds hiring CONTACTS for a posting. Never fetches jobs. '
                    'Managed from the Contacts screen, not Job Discovery — it is '
                    'ENRICHMENT rather than PROVIDER so the discovery provider '
                    'query cannot select it. See migration 045.'
 WHERE name = 'APOLLO';

COMMENT ON COLUMN lkp_job_sources.fetch_mode IS
    'How postings arrive from this source. PROVIDER = a paid search API we '
    'call. PORTAL = a board the desktop app applies on. MANUAL / CSV = entered '
    'by hand. WEBHOOK = pushed to us. ENRICHMENT = not a job source at all: a '
    'provider that adds data to postings we already hold (e.g. Apollo finding '
    'a hiring contact). Only PROVIDER rows are candidates for job discovery.';
