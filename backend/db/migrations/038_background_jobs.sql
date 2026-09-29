-- 038_background_jobs.sql
-- Purpose: durable work that happens outside a request, and the money ceiling
--          that bounds it.
-- Phase: 7
--
-- ── WHY A TABLE AND NOT AN IN-MEMORY QUEUE ───────────────────────────────
--
-- Both of the things this queue will carry — tailoring a resume through a paid
-- model, and buying a contact from a paid provider — cost real money and take
-- seconds to minutes. An in-process array loses all of it on the next deploy,
-- and there is no way afterwards to answer "did that job run, and what did it
-- cost?". A row survives a restart, records its own failures, and can be
-- counted.
--
-- ── THE TWO THINGS THAT MAKE A JOB QUEUE SURVIVABLE ──────────────────────
--
--   SKIP LOCKED   two workers must never take the same row. Doing this with a
--                 status flag alone is a race: both read PENDING, both write
--                 RUNNING, the job runs twice and is paid for twice.
--
--   A LEASE       `locked_until` is an expiry, not a flag. A worker killed
--                 mid-job leaves its row RUNNING forever, and a plain flag has
--                 no way back. This is the same lesson queue_items.leased_until
--                 already encodes for the desktop app.
--
-- ── WHY ATTEMPTS AND A DEAD LETTER ───────────────────────────────────────
--
-- A provider returning 500 for ten minutes is normal and should be retried. A
-- resume that will never parse is not, and retrying it forever is how a queue
-- fills with work that can never succeed. DEAD is the state that says "stop
-- trying, and let a person look".

CREATE TABLE IF NOT EXISTS background_jobs (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- Which handler runs this. Deliberately free text rather than a lookup
    -- table: a handler is a file in jobs/handlers/, and adding one should be
    -- adding a file, not a migration.
    kind            VARCHAR(60) NOT NULL,

    -- Everything the handler needs to do its work, and nothing it can look up
    -- for itself. Kept small on purpose — a payload carrying a copy of the
    -- resume would be stale by the time the job ran.
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- PENDING  waiting, or waiting to be retried after a failure
    -- RUNNING  a worker holds the lease
    -- DONE     succeeded
    -- FAILED   failed, and will be retried (attempts < max_attempts)
    -- DEAD     out of attempts. Nothing will pick this up again.
    status          VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','RUNNING','DONE','FAILED','DEAD')),

    attempts        INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts    INT NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),

    -- Exponential backoff lives here rather than in a sleeping worker: the
    -- delay has to survive a restart, and a process that sleeps holds a
    -- database connection for no reason.
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The lease. `locked_by` is text rather than a foreign key for the same
    -- reason as queue_items.leased_by: it names a PROCESS, not a user.
    locked_by       VARCHAR(64)  DEFAULT NULL,
    locked_until    TIMESTAMPTZ  DEFAULT NULL,

    last_error      VARCHAR(2000) DEFAULT NULL,

    -- Set by the handler when it wants to say something about a success that
    -- is not a failure — "skipped, no base resume on file", for instance.
    result          JSONB DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ DEFAULT NULL,
    finished_at     TIMESTAMPTZ DEFAULT NULL
);

-- The claim query's index. Partial, because a queue is mostly finished work and
-- an index over DONE rows is dead weight that grows forever.
CREATE INDEX IF NOT EXISTS idx_bg_jobs_claimable
    ON background_jobs (next_attempt_at, created_at)
    WHERE status = 'PENDING';

-- The sweep that reclaims abandoned leases.
CREATE INDEX IF NOT EXISTS idx_bg_jobs_running
    ON background_jobs (locked_until)
    WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS idx_bg_jobs_org_kind
    ON background_jobs (organization_id, kind, created_at DESC);

-- A dashboard's "what is stuck" query.
CREATE INDEX IF NOT EXISTS idx_bg_jobs_dead
    ON background_jobs (organization_id, finished_at DESC)
    WHERE status = 'DEAD';

COMMENT ON TABLE background_jobs IS
    'Durable out-of-request work. Claimed with FOR UPDATE SKIP LOCKED and held '
    'on an expiring lease, so a crashed worker releases its job instead of '
    'keeping it forever.';


-- ── the money ceiling ────────────────────────────────────────────────────
--
-- There is no longer a daily application cap anywhere in this system — it was
-- removed deliberately. That leaves NOTHING bounding how many jobs reach the
-- preparation stage, and every one of them is a paid model call.
--
-- So the bound moves to where the money is. This is a ceiling on spend, not on
-- work: reaching it never stops an application going out. The item still
-- becomes READY, carrying the consultant's base resume, marked so that anyone
-- looking at it can see it was not tailored and why (see migration 039's
-- queue_items.tailoring_state).
--
-- Deliberately per organisation and not an environment variable: two agencies
-- sharing an installation do not share a budget, for the same reason they no
-- longer share provider health.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS ai_monthly_budget_usd NUMERIC(10,2) NOT NULL DEFAULT 50.00,
    -- Which day of the month the spend window restarts on, so a budget can be
    -- aligned to a billing cycle that is not the 1st.
    ADD COLUMN IF NOT EXISTS ai_spend_reset_day INT NOT NULL DEFAULT 1;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_ai_budget;
ALTER TABLE organizations
    ADD CONSTRAINT chk_org_ai_budget CHECK (
        ai_monthly_budget_usd >= 0
    AND ai_spend_reset_day BETWEEN 1 AND 28   -- 28, so every month has the day
    );
