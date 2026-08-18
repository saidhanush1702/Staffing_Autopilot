-- 028_discovery_settings.sql
-- Purpose: move discovery pacing and spend from the environment into per-tenant
--          settings an ORG_ADMIN owns from the UI, and cache the provider's
--          recency filter handles.
-- Phase: 5 (v2)
--
-- ── WHY THESE LEFT .env ───────────────────────────────────────────────
--
-- Cycle interval, monthly budget and recency window were process-wide
-- environment variables. That is the wrong granularity for a multi-tenant
-- system: two agencies on different provider plans cannot share one budget, and
-- changing an interval should not need a redeploy and a restart.
--
-- DISCOVERY_ENABLED stays in the environment, because it answers a different
-- question — whether THIS PROCESS runs the cycle at all. A developer's laptop
-- must not start spending an agency's credits just because the database says
-- the cycle is on. Both still have to be true.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS discovery_cycle_hours INT NOT NULL DEFAULT 6;

-- 1 to 24. The UI shows the monthly credit cost of the chosen value, because
-- the interval is the single biggest lever on the bill: 1 hour is 24x the spend
-- of 24 hours for the same search terms.
ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS chk_discovery_cycle_hours;
ALTER TABLE organizations
    ADD CONSTRAINT chk_discovery_cycle_hours
    CHECK (discovery_cycle_hours BETWEEN 1 AND 24);

-- The provider plan's monthly search quota. Enforced as a hard stop: scheduled
-- runs stop FETCHING at the limit, but still complete and still re-match the
-- postings already in the pool, because that half costs nothing.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS discovery_monthly_budget INT NOT NULL DEFAULT 250;

ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS chk_discovery_monthly_budget;
ALTER TABLE organizations
    ADD CONSTRAINT chk_discovery_monthly_budget
    CHECK (discovery_monthly_budget >= 0);

-- How recently a job must have been posted to be worth asking for. These are
-- Google's own windows and there is nothing finer than a day at any price.
--   day    "Yesterday"    ~24 hours   (default)
--   3days  "Last 3 days"
--   week   "Last week"
--   month  "Last month"
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS discovery_date_posted VARCHAR(10) NOT NULL DEFAULT 'day';

ALTER TABLE organizations
    DROP CONSTRAINT IF EXISTS chk_discovery_date_posted;
ALTER TABLE organizations
    ADD CONSTRAINT chk_discovery_date_posted
    CHECK (discovery_date_posted IN ('day', '3days', 'week', 'month'));

COMMENT ON COLUMN organizations.discovery_cycle_hours IS
    'Hours between automatic discovery cycles, 1-24. Owned by ORG_ADMIN.';
COMMENT ON COLUMN organizations.discovery_monthly_budget IS
    'Provider search quota for the calendar month. Hard stop when reached.';
COMMENT ON COLUMN organizations.discovery_date_posted IS
    'Recency window sent to the provider: day | 3days | week | month.';


-- ── the provider''s recency filter handles ────────────────────────────
--
-- Google applies a date filter through an opaque `uds` string, and that string
-- encodes the SEARCH TERM as well as the filter — the same "last 3 days" filter
-- produces a different value for "react developer" than for "java developer".
-- So it cannot be hard-coded and must be discovered per search term.
--
-- Discovery is free: every ordinary search response carries a `filters` array
-- containing each available filter with its handle. The first call for a term
-- returns jobs AND the handle; every later call reuses the cached handle and
-- costs exactly the same one credit it would have cost anyway.
--
-- Google rotates these strings periodically, so rows carry a fetched_at for TTL
-- and a failure counter — a handle that stops working is dropped and
-- re-discovered rather than retried forever.
CREATE TABLE IF NOT EXISTS provider_filter_cache (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    query_text      VARCHAR(255) NOT NULL,
    -- Empty string rather than NULL so the unique index treats "no location"
    -- as one value instead of every row being distinct.
    location_text   VARCHAR(255) NOT NULL DEFAULT '',
    date_window     VARCHAR(10)  NOT NULL,

    uds             TEXT         NOT NULL,
    -- Google also rewrites the query alongside the filter
    -- ("react developer" -> "react developer in the last 3 days").
    q_override      VARCHAR(500) DEFAULT NULL,

    fetched_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ  DEFAULT NULL,
    failures        INT          NOT NULL DEFAULT 0,

    CONSTRAINT uq_filter_cache_per_query
        UNIQUE (organization_id, query_text, location_text, date_window)
);

CREATE INDEX IF NOT EXISTS idx_filter_cache_org
    ON provider_filter_cache (organization_id, date_window);
