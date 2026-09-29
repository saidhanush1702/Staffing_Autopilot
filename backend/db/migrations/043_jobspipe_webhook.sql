-- 043_jobspipe_webhook.sql
-- Purpose: real-time job ingestion pushed to us by JobsPipe, in parallel with
--          the scheduled discovery cycle.
-- Phase: 5b (parallel testing module)
--
-- ── WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT TOUCH ───────────────
--
-- The scheduled cycle PULLS: it wakes on a heartbeat, asks the search provider
-- for pages of results, and pays a credit for each. This adds a second door
-- that PUSHES: JobsPipe posts a job to us the moment it sees one, and the cost
-- of a job we never wanted is a rejected HTTP request rather than a credit.
--
-- Nothing in the pull path changes. lkp_job_sources gains one row, and two new
-- tables appear. discovery_runs, job_matches, queue_items, the fingerprint and
-- the matcher are all reused exactly as they are — which is the point. A
-- parallel ingestion path that also reimplemented de-duplication would be two
-- de-duplication rules pretending to be one, and the second one would drift.
--
-- ── THE THREE THINGS THIS NEEDS ──────────────────────────────────────────
--
--   1. a source row, so a webhook posting is attributable like any other
--   2. a per-agency shared secret, so an unauthenticated public endpoint can
--      still tell which tenant a job belongs to and refuse everyone else
--   3. an event log, because this is a Free Tier trial and "did it work?" is
--      the entire question the trial exists to answer

/* ── 1. the source ────────────────────────────────────────────────────── */
--
-- fetch_mode has meant "how do we GET postings from here". WEBHOOK is the
-- inversion of that: we never fetch, we are delivered to. It is a distinct
-- mode rather than reusing MANUAL because the run reporting reads this column
-- to decide whether a source costs credits, and a webhook does not.
ALTER TABLE lkp_job_sources
    DROP CONSTRAINT IF EXISTS lkp_job_sources_fetch_mode_check;

ALTER TABLE lkp_job_sources
    ADD CONSTRAINT lkp_job_sources_fetch_mode_check
    CHECK (fetch_mode IN ('PROVIDER', 'PORTAL', 'MANUAL', 'CSV', 'WEBHOOK'));

INSERT INTO lkp_job_sources
    (name, label, fetch_mode, is_enabled, is_priority, max_pages, rate_limit_ms, notes)
VALUES
    ('JOBSPIPE', 'JobsPipe (real-time push)', 'WEBHOOK', FALSE, FALSE, 1, 1000,
     'Jobs pushed to /api/webhooks/jobspipe as they are published. Never fetched, '
     'so it spends no search credits. Runs alongside the scheduled cycle.')
ON CONFLICT (name) DO UPDATE
    SET label      = EXCLUDED.label,
        fetch_mode = EXCLUDED.fetch_mode,
        notes      = EXCLUDED.notes;
-- is_enabled is deliberately absent from the UPDATE, matching seed 005: a
-- re-run must never switch an ingestion path back on behind an operator.


/* ── 2. the per-agency endpoint secret ────────────────────────────────── */
--
-- ── WHY A TOKEN AND NOT A SESSION ────────────────────────────────────────
--
-- Every other write route in this API is behind verifyToken and a cookie.
-- JobsPipe has no cookie and no user: it is a server posting to a public URL.
-- So the token IS the identity, and it answers both questions at once — is
-- this caller allowed in, and whose organisation is this job for. Resolving
-- the tenant from the secret rather than from a field in the payload is what
-- stops one agency's webhook writing postings into another's pool.
--
-- ── WHY BOTH A HASH AND A CIPHERTEXT ─────────────────────────────────────
--
-- Exactly the arrangement migration 034 settled on for device activation codes,
-- for the same reason and with the same trade:
--
--   token_hash  the ONLY thing an incoming request is ever checked against.
--               One-way, so verification cannot be weakened by the fact that
--               the secret is also readable.
--   token_enc   AES-256-GCM under PASSWORD_ENC_KEY, so an ORG_ADMIN can be
--               shown the secret again when they come to paste it into the
--               JobsPipe dashboard. A secret that can only be seen once is a
--               secret that gets rotated every time somebody closes a tab, and
--               each rotation breaks the live integration.
--
-- Someone holding a database backup still holds nothing usable: the key lives
-- in the environment, never in a table.
CREATE TABLE IF NOT EXISTS jobspipe_endpoints (
    id              CHAR(36) PRIMARY KEY,

    -- One endpoint per agency. A second would mean two secrets resolving to
    -- the same pool with no way to tell their traffic apart.
    organization_id CHAR(36) NOT NULL UNIQUE
                    REFERENCES organizations(id) ON DELETE CASCADE,

    token_hash      CHAR(64) NOT NULL UNIQUE,   -- sha256 hex, what we verify
    token_enc       TEXT         DEFAULT NULL,  -- base64 ciphertext, for reveal
    token_iv        VARCHAR(32)  DEFAULT NULL,  -- hex, 12 bytes
    token_tag       VARCHAR(32)  DEFAULT NULL,  -- hex GCM auth tag

    -- Off until an admin turns it on. A fresh checkout must not accept pushed
    -- jobs from anybody, and a tenant that has not opted in has not opted in.
    is_enabled      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Health, so the screen can distinguish "nothing has arrived" from
    -- "everything that arrives is being rejected".
    last_event_at   TIMESTAMPTZ DEFAULT NULL,
    last_error      VARCHAR(500) DEFAULT NULL,
    events_received INT NOT NULL DEFAULT 0,
    events_rejected INT NOT NULL DEFAULT 0,

    rotated_at      TIMESTAMPTZ DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The lookup every request makes, before it is known to be legitimate.
CREATE INDEX IF NOT EXISTS idx_jobspipe_endpoint_hash
    ON jobspipe_endpoints (token_hash);

DROP TRIGGER IF EXISTS trg_jobspipe_endpoints_updated_at ON jobspipe_endpoints;
CREATE TRIGGER trg_jobspipe_endpoints_updated_at
    BEFORE UPDATE ON jobspipe_endpoints
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


/* ── 3. the event log ─────────────────────────────────────────────────── */
--
-- ── WHY THIS IS HEAVIER THAN A CONSOLE LINE ──────────────────────────────
--
-- This is a Free Tier trial, and a trial is a measurement. The decision it
-- feeds is whether to pay for the tier above, and that decision needs numbers
-- nobody can produce after the fact from stdout: how many jobs arrive, how many
-- survive de-duplication, how many survive the pre-filter, how many actually
-- reach a consultant, and how long we spend per event.
--
-- A job that arrives and is dropped at the pre-filter is the NORMAL case, not a
-- failure — most postings suit nobody on a given bench. Recording the stage it
-- stopped at is what separates "the feed is full of jobs we do not want" from
-- "the feed is broken", and those two conclusions lead to opposite actions.
--
-- The raw payload is kept for the same reason job_source_payloads keeps one:
-- when the parser turns out to be wrong about a field, the only way to fix
-- history rather than lose it is to still have what arrived.
CREATE TABLE IF NOT EXISTS jobspipe_webhook_events (
    id              CHAR(36) PRIMARY KEY,

    -- Nullable: a request whose token we could not resolve has no organisation
    -- by definition, and that request is precisely the one worth logging.
    organization_id CHAR(36) DEFAULT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- ── how far it got ───────────────────────────────────────────────
    --
    -- UNAUTHORISED  no valid token; nothing was read
    -- DISABLED      valid token, but the tenant has the endpoint switched off
    -- INVALID       authorised, but the body is not a job we can normalise
    -- DUPLICATE     normalised onto a fingerprint already in the pool (R-15)
    -- FILTERED      new posting stored, but it suited no consultant
    -- QUEUED        new or repeat posting that reached at least one queue
    -- ERROR         something threw; last_error carries it
    outcome         VARCHAR(20) NOT NULL
                    CHECK (outcome IN ('UNAUTHORISED','DISABLED','INVALID',
                                       'DUPLICATE','FILTERED','QUEUED','ERROR')),

    -- What we made of it, denormalised so the screen needs no join to show a
    -- readable line. Null when it never parsed.
    posting_id      CHAR(36) DEFAULT NULL
                    REFERENCES job_postings(id) ON DELETE SET NULL,
    company         VARCHAR(255) DEFAULT NULL,
    title           VARCHAR(255) DEFAULT NULL,
    location_text   VARCHAR(255) DEFAULT NULL,

    -- The funnel, per event.
    is_new_posting  BOOLEAN NOT NULL DEFAULT FALSE,
    consultants_considered INT NOT NULL DEFAULT 0,
    prefiltered_out INT NOT NULL DEFAULT 0,
    matches_created INT NOT NULL DEFAULT 0,
    queued_count    INT NOT NULL DEFAULT 0,
    -- Whether the AI preparation stage was handed work for this posting. The
    -- webhook never calls a model itself; it enqueues, exactly as the cycle does.
    preparation_enqueued INT NOT NULL DEFAULT 0,

    -- End to end, in the endpoint. The number the Free Tier trial is judged on
    -- alongside volume: a push feed that takes eight seconds to answer will be
    -- retried by the sender and deliver everything twice.
    duration_ms     INT DEFAULT NULL,

    detail          VARCHAR(500) DEFAULT NULL,

    -- Truncated, like job_source_payloads.body — enough to re-parse, not
    -- enough to turn this table into a copy of JobsPipe.
    raw_payload     TEXT DEFAULT NULL,
    payload_bytes   INT DEFAULT NULL,

    -- For correlating a retry against the delivery it repeats, when the sender
    -- provides one.
    delivery_id     VARCHAR(120) DEFAULT NULL,
    remote_ip       VARCHAR(64)  DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobspipe_events_org
    ON jobspipe_webhook_events (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobspipe_events_outcome
    ON jobspipe_webhook_events (organization_id, outcome, received_at DESC);

COMMENT ON TABLE jobspipe_webhook_events IS
    'One row per POST to /api/webhooks/jobspipe, including rejected ones. The '
    'measurement the JobsPipe Free Tier trial is judged on: volume, funnel and '
    'latency. Rejected requests have a null organization_id by definition.';

COMMENT ON TABLE jobspipe_endpoints IS
    'Per-agency shared secret for the JobsPipe push endpoint. token_hash is the '
    'only thing verified; token_enc exists so an ORG_ADMIN can read the secret '
    'back to paste into JobsPipe, exactly as devices.activation_enc does.';
