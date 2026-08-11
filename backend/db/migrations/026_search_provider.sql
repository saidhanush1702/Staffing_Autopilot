-- 026_search_provider.sql
-- Purpose: replace the direct-scraping acquisition model with a search provider.
-- Phase: 5 (v2)
--
-- ── WHY ───────────────────────────────────────────────────────────────
--
-- Phase 5 v1 crawled five job boards directly. Probed against the live sites,
-- four of five returned nothing and always would:
--
--   LinkedIn    robots.txt is a site-wide "Disallow: /" for every crawler
--   Wellfound   Cloudflare 403 to every HTTP client, including their own sitemap
--   TheLadders  Cloudflare 403 to everything, including robots.txt itself
--   Built In    partial, via a sitemap, because ?search= is disallowed
--   CrunchBoard RSS only, a handful of jobs, no search
--
-- Acquisition now goes through Google Jobs via a paid SERP API. Google already
-- indexes all five boards and attributes each posting to the one that listed
-- it, so the boards remain first-class in the product — they stop being things
-- we crawl and become attribution plus an operator switch.
--
-- Nothing downstream of acquisition changes: fingerprinting, matching, caps,
-- the queue and its state machine are untouched by this migration.

-- ── lkp_job_sources: crawl configuration out, provider semantics in ───

ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS respect_robots;
ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS search_template;

-- fetch_mode gains two meanings and loses one:
--   PROVIDER  the thing actually fetched (GOOGLE_JOBS). Carries provider health.
--   PORTAL    a board Google attributes postings to. Never fetched.
--   MANUAL / CSV  unchanged.
--
-- The old constraint was declared inline, so its name was generated rather than
-- chosen. Dropping it by the name Postgres usually picks would silently do
-- nothing on a database where it picked another, and the UPDATE below would
-- then fail against a constraint that no longer matches reality. So it is found
-- by what it constrains, not by what it is called.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
         WHERE rel.relname = 'lkp_job_sources'
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) ILIKE '%fetch_mode%'
    LOOP
        EXECUTE format('ALTER TABLE lkp_job_sources DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END $$;

UPDATE lkp_job_sources SET fetch_mode = 'PORTAL' WHERE fetch_mode = 'HTTP';

ALTER TABLE lkp_job_sources
    ADD CONSTRAINT lkp_job_sources_fetch_mode_check
    CHECK (fetch_mode IN ('PROVIDER', 'PORTAL', 'MANUAL', 'CSV'));

-- The five boards named in the specification. They are the priority set, NOT a
-- filter: everything Google returns is kept. This flag only drives ordering and
-- grouping on the discovery screen, so the boards that matter read first.
ALTER TABLE lkp_job_sources
    ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT FALSE;

-- ── the semantic flip on is_enabled ───────────────────────────────────
--
-- Under v1 this meant "crawl this website", and shipping it FALSE was right:
-- the first outbound request should be somebody's decision, not a side effect
-- of running a migration.
--
-- Under v2 it means "keep postings attributed to this board", which contacts
-- nobody. Carrying the old value forward would leave every board silently
-- discarding its postings, so the migration sets the new meaning explicitly.
--
-- The switch that still gates ALL outbound traffic is the GOOGLE_JOBS provider
-- row, and the seed inserts that one disabled.
UPDATE lkp_job_sources SET is_enabled = TRUE WHERE fetch_mode = 'PORTAL';

-- rate_limit_ms and max_pages survive with new meanings — pacing between API
-- calls, and result pages per search term. Both still belong in a row an
-- operator can edit at 2am rather than in a redeploy.
COMMENT ON COLUMN lkp_job_sources.rate_limit_ms IS
    'Pause between successive provider API calls, in milliseconds.';
COMMENT ON COLUMN lkp_job_sources.max_pages IS
    'Result pages fetched per search term. Each page is one API credit.';


-- ── job_postings: the provider''s stable handle ───────────────────────
--
-- Google''s own job id. Not part of the R-15 fingerprint, which stays company +
-- title + location per the specification — this is the key for re-fetching a
-- posting''s full detail from the provider later, which is otherwise impossible
-- to reconstruct once the search response has aged out.
ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS provider_job_id VARCHAR(512) DEFAULT NULL;


-- ── discovery_runs: counters that describe what a run now does ────────
--
-- Not cosmetic. "sources_attempted" counted boards crawled, which is now always
-- one; leaving a column named for sources while it holds a query count is how a
-- dashboard ends up quietly lying a year from now.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'discovery_runs' AND column_name = 'sources_attempted') THEN
        ALTER TABLE discovery_runs RENAME COLUMN sources_attempted TO queries_sent;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'discovery_runs' AND column_name = 'sources_failed') THEN
        ALTER TABLE discovery_runs RENAME COLUMN sources_failed TO queries_failed;
    END IF;
END $$;

-- One credit per call. Recorded per run so spend is visible here rather than
-- discovered on an invoice at the end of the month.
ALTER TABLE discovery_runs
    ADD COLUMN IF NOT EXISTS provider_calls INT NOT NULL DEFAULT 0;

-- Postings rejected because their board was switched off. Counted so that "we
-- found nothing" and "you filtered everything out" are never the same number.
ALTER TABLE discovery_runs
    ADD COLUMN IF NOT EXISTS filtered_by_portal INT NOT NULL DEFAULT 0;
