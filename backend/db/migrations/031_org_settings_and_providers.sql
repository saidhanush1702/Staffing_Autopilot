-- 031_org_settings_and_providers.sql
-- Purpose: per-agency timings and timezone, and provider settings that support
--          more than one provider.
-- Phase: 5 → 6
--
-- ── A MULTI-TENANCY LEAK THIS ALSO CLOSES ─────────────────────────────
--
-- Provider health — last_success_at, last_error, consecutive_failures — has
-- been living on `lkp_job_sources`, which is a GLOBAL lookup table with no
-- organisation column. So two agencies sharing an installation have been
-- sharing one health record: agency A's failed search marks the provider
-- broken on agency B's dashboard, and A's success clears B's genuine failure.
--
-- Health, budget and enablement are properties of "this agency's relationship
-- with this provider", not of the provider itself. They move here.

-- ── agency clock and housekeeping intervals ───────────────────────────

ALTER TABLE organizations
    -- The daily application cap resets on the agency's own clock. Staffing
    -- benches are frequently offshore, so the server's date is the wrong
    -- boundary. NULL falls back to APP_TIMEZONE.
    ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT NULL,

    -- How long the desktop app may hold an item before the lease is considered
    -- abandoned. This is what stops a crashed app locking a job forever.
    ADD COLUMN IF NOT EXISTS lease_expiry_minutes INT NOT NULL DEFAULT 30,

    -- An item that never finishes preparation returns to the pool instead of
    -- sitting on a cap slot it is not using.
    ADD COLUMN IF NOT EXISTS unprepared_expiry_hours INT NOT NULL DEFAULT 4,

    -- A filled application nobody reviewed eventually releases its slot,
    -- otherwise a fortnight off work fills the queue with stale drafts.
    ADD COLUMN IF NOT EXISTS review_expiry_days INT NOT NULL DEFAULT 7,

    -- A posting not seen by any run for this long is treated as gone. Nothing
    -- else ever set is_active back to false, so queues accumulated jobs that
    -- had long since been filled.
    ADD COLUMN IF NOT EXISTS posting_stale_days INT NOT NULL DEFAULT 30;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_housekeeping;
ALTER TABLE organizations
    ADD CONSTRAINT chk_org_housekeeping CHECK (
        lease_expiry_minutes    BETWEEN 5  AND 1440
    AND unprepared_expiry_hours BETWEEN 1  AND 168
    AND review_expiry_days      BETWEEN 1  AND 90
    AND posting_stale_days      BETWEEN 1  AND 365
    );


-- ── this agency's relationship with each provider ─────────────────────
--
-- One row per agency per provider. Adding a second provider is a row, not a
-- schema change and not a redeploy — which is the point, because the plan a
-- provider is on and even which provider is used will change.
--
-- Credentials deliberately do NOT live here. The row names the environment
-- variable that holds the key; the key itself stays in the server environment.
-- A secret in a table that operators can read through a UI is a secret that has
-- already leaked, and this system already redacts keys out of stored URLs for
-- exactly that reason.
CREATE TABLE IF NOT EXISTS organization_providers (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    source_id       INT NOT NULL
                    REFERENCES lkp_job_sources(id) ON DELETE CASCADE,

    is_enabled      BOOLEAN NOT NULL DEFAULT FALSE,

    -- The plan's monthly search quota. Moving from free to a paid tier is this
    -- one number.
    monthly_budget  INT NOT NULL DEFAULT 250 CHECK (monthly_budget >= 0),
    -- Result pages per search term. Each page is one credit.
    max_pages       INT NOT NULL DEFAULT 2 CHECK (max_pages BETWEEN 1 AND 10),
    -- Pause between successive calls, in milliseconds.
    rate_limit_ms   INT NOT NULL DEFAULT 1000 CHECK (rate_limit_ms >= 0),

    credential_env  VARCHAR(64) NOT NULL DEFAULT 'SERPAPI_KEY',

    -- Health, now per agency rather than shared across the installation.
    last_success_at TIMESTAMPTZ  DEFAULT NULL,
    last_error      VARCHAR(500) DEFAULT NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_provider_per_org UNIQUE (organization_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_org_providers_enabled
    ON organization_providers (organization_id, is_enabled);

DROP TRIGGER IF EXISTS trg_org_providers_updated_at ON organization_providers;
CREATE TRIGGER trg_org_providers_updated_at
    BEFORE UPDATE ON organization_providers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── carry the existing settings across ────────────────────────────────
--
-- Every organisation gets a row for every provider-mode source, seeded from
-- whatever it already had. Enablement is carried from the global flag so an
-- agency that had switched the provider on does not silently lose it.
INSERT INTO organization_providers
    (id, organization_id, source_id, is_enabled, monthly_budget, max_pages, rate_limit_ms)
SELECT gen_random_uuid()::text, o.id, s.id,
       s.is_enabled,
       COALESCE(o.discovery_monthly_budget, 250),
       s.max_pages,
       s.rate_limit_ms
  FROM organizations o
 CROSS JOIN lkp_job_sources s
 WHERE s.fetch_mode = 'PROVIDER'
ON CONFLICT (organization_id, source_id) DO NOTHING;

-- The budget now belongs to the agency-provider pair, not the agency, because
-- an agency running two providers has two quotas.
ALTER TABLE organizations DROP COLUMN IF EXISTS discovery_monthly_budget;

-- Health is per agency now; leaving copies on the shared lookup would
-- guarantee the two disagree.
ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS last_success_at;
ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS last_error;
ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS consecutive_failures;
