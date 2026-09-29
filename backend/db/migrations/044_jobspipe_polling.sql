-- 044_jobspipe_polling.sql
-- Purpose: the PULL half of JobsPipe — scheduled polling of /v1/jobs/search,
--          in parallel with both the SerpApi cycle and the JobsPipe webhook.
-- Phase: 5c (parallel testing module)
--
-- ── WHY A THIRD DOOR ──────────────────────────────────────────────────
--
-- Migration 043 built the webhook. It turns out the push feed needs a PAID
-- plan, so it cannot be trialled at all — which leaves the question that
-- started this unanswered: SerpApi finds what Google Jobs has INDEXED, and
-- indexing lags publication, so recently-posted roles are not turning up.
--
-- The search API works on the Free Tier. So this is the door that can actually
-- be measured, and the measurement is the deliverable: how old is a JobsPipe
-- job when we first see it, compared with a SerpApi one.
--
-- ── WHAT THIS DOES NOT TOUCH ──────────────────────────────────────────
--
-- No change to the SerpApi cycle, the webhook, the fingerprint, the matcher or
-- the preparation gate. It reuses the SAME `JOBSPIPE` source row 043 created,
-- deliberately: a job is from JobsPipe whether it was pushed or polled, and
-- giving the two doors separate source rows would let the same posting land on
-- two rows with two fingerprints — the one failure R-15 exists to prevent.

/* ── 1. the pull path's own settings, on the existing table ───────────── */
--
-- `organization_providers` (migration 031) already models exactly this: a
-- per-agency enable flag, a monthly quota, and — the column that was clearly
-- built for a day like today — `credential_env`, naming the environment
-- variable that holds the key rather than storing the key.
--
-- So the pull path needs no settings table of its own. It needs a row.
--
-- NOTE ON fetch_mode. The source row stays 'WEBHOOK'. The column answers "how
-- do we GET postings from here" for the SCHEDULED CYCLE's reporting, and the
-- cycle still never fetches from JobsPipe — this poller is its own job with its
-- own ledger below. Enablement for the pull path is read from the row this
-- creates, never from lkp_job_sources.is_enabled, so the two cannot disagree.
--
-- monthly_budget is 100 because that is the Free Tier: 100 credits a MONTH,
-- where 1 credit = 1 REQUEST regardless of how many jobs come back. That is
-- roughly three calls a day, which is why the poller defaults to six-hourly
-- and why the ceiling below is enforced before a call, not after it.
INSERT INTO organization_providers
    (id, organization_id, source_id, is_enabled, monthly_budget,
     max_pages, rate_limit_ms, credential_env)
SELECT gen_random_uuid()::text, o.id, s.id,
       FALSE,      -- off until somebody turns it on, like every other source
       100,        -- the Free Tier's monthly credit allowance
       1,          -- one page per poll; pagination is extra credits, not extra rows
       1000,
       'JOBSPIPE_API_KEY'
  FROM organizations o
 CROSS JOIN lkp_job_sources s
 WHERE s.name = 'JOBSPIPE'
ON CONFLICT (organization_id, source_id) DO NOTHING;


/* ── 2. the credit ledger ─────────────────────────────────────────────── */
--
-- ── WHY NOT discovery_runs ────────────────────────────────────────────
--
-- Same reason the webhook does not write one: `uq_one_running_discovery`
-- permits exactly one open run per organisation, so a poller opening a run
-- would race the scheduler and could block the four-hourly cycle from
-- starting. Postings, matches and queue items created here carry
-- `run_id = NULL`, which is already that nullable column's meaning — this did
-- not come from a discovery run.
--
-- ── WHY A LEDGER AT ALL ───────────────────────────────────────────────
--
-- Because on a 100-a-month plan the spend has to be known BEFORE the call, not
-- reconstructed afterwards from logs. One row per poll, `credits_spent` being
-- the number of HTTP requests that poll actually made — retries included,
-- since a retried request is a second credit and the arithmetic has to say so.
--
-- The month-to-date sum of this column against organization_providers.
-- monthly_budget is the hard stop.
CREATE TABLE IF NOT EXISTS jobspipe_poll_runs (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ DEFAULT NULL,

    -- MANUAL   somebody pressed a button or ran the script
    -- SCHEDULED the cron fired
    trigger         VARCHAR(12) NOT NULL DEFAULT 'SCHEDULED'
                    CHECK (trigger IN ('MANUAL', 'SCHEDULED')),

    -- OK          the call was made and the results processed
    -- SKIPPED     nothing was spent — no key, disabled, or no bench to search for
    -- BUDGET_HIT  refused before spending, the month's allowance is gone
    -- ERROR       the call or the processing threw
    outcome         VARCHAR(12) NOT NULL
                    CHECK (outcome IN ('OK', 'SKIPPED', 'BUDGET_HIT', 'ERROR')),

    -- Exactly what was asked for, so a poll that returned nothing useful can be
    -- told apart from a poll that asked the wrong question.
    filters         TEXT DEFAULT NULL,

    -- ⚠ THE NUMBER THE PLAN IS BILLED ON. HTTP requests made, not jobs read.
    credits_spent   INT NOT NULL DEFAULT 0,

    -- The funnel, same shape the webhook's event log records.
    jobs_returned   INT NOT NULL DEFAULT 0,
    unusable        INT NOT NULL DEFAULT 0,
    new_postings    INT NOT NULL DEFAULT 0,
    duplicates      INT NOT NULL DEFAULT 0,
    matches_created INT NOT NULL DEFAULT 0,
    queued_count    INT NOT NULL DEFAULT 0,
    preparation_enqueued INT NOT NULL DEFAULT 0,

    -- ── the trial's actual answer ─────────────────────────────────────
    --
    -- Age of each returned posting at the moment we asked, in hours. THIS is
    -- what gets compared against the same figure for SerpApi postings; the
    -- funnel above only says whether the plumbing ran.
    age_hours_min   NUMERIC(10,2) DEFAULT NULL,
    age_hours_median NUMERIC(10,2) DEFAULT NULL,
    age_hours_max   NUMERIC(10,2) DEFAULT NULL,
    posted_last_24h INT NOT NULL DEFAULT 0,

    duration_ms     INT DEFAULT NULL,
    error           VARCHAR(500) DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobspipe_poll_org
    ON jobspipe_poll_runs (organization_id, started_at DESC);

-- The index the budget guard reads on every poll: month-to-date spend for one
-- organisation. Partial, because a run that spent nothing is not part of that sum.
CREATE INDEX IF NOT EXISTS idx_jobspipe_poll_spend
    ON jobspipe_poll_runs (organization_id, started_at)
    WHERE credits_spent > 0;

COMMENT ON TABLE jobspipe_poll_runs IS
    'One row per poll of the JobsPipe search API. credits_spent counts HTTP '
    'requests (1 credit = 1 request on their plan), and its month-to-date sum '
    'against organization_providers.monthly_budget is the hard stop. The '
    'age_hours_* columns are the freshness measurement the trial exists for.';

COMMENT ON COLUMN jobspipe_poll_runs.credits_spent IS
    'HTTP requests made by this poll, retries included. NOT jobs returned — '
    'a call costs the same whether it yields one job or a hundred.';
