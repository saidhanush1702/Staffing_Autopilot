-- 058_ats_mirror.sql
-- Purpose: the ATS LIVE MIRROR — a fourth ingestion door that reads employers'
--          own career systems (Greenhouse, Lever, Ashby, Workday,
--          SmartRecruiters) directly, minutes after a job is published.
-- Phase: 5d (parallel module, branch feat/atsfetchingjobsfaster)
--
-- ── WHAT THIS DOES NOT TOUCH ──────────────────────────────────────────
--
-- Nothing that exists. The SerpApi cycle, the JobsPipe webhook and the
-- JobsPipe poller keep their tables, their schedules and their source rows.
-- This migration only ADDS tables and ONE source row, and widens a CHECK
-- constraint the same way 043 and 045 did.
--
-- ── WHY A MIRROR, NOT A SEARCH ────────────────────────────────────────
--
-- SerpApi and JobsPipe both ask a third party "what jobs match this
-- consultant?", and so inherit that party's index lag and per-request price.
-- An ATS publishes a free, unauthenticated JSON endpoint listing EVERY open job
-- for one employer, with ETag support, so an unchanged board answers
-- "304 Not Modified" with an empty body.
--
-- So instead of searching per consultant we keep a registry of employer boards
-- and DIFF each board against what we saw last time. A job that appears is new
-- by construction — straight from the origin, with its real apply URL and its
-- portal type known before we ever fetch the page. Matching against consultants
-- then happens locally, through the existing evaluate() — cost scales with the
-- number of boards, not the number of consultants.
--
-- ── WHERE THE JOBS GO ─────────────────────────────────────────────────
--
-- Into job_postings through the EXISTING upsertPosting/ingestAdapted path, so
-- the org-wide UNIQUE (organization_id, fingerprint) index (R-15) still
-- collapses a job found here and the same job found by SerpApi/JobsPipe onto
-- ONE row. Nobody applies twice because two doors saw the same role.

/* ── 1. the families we know how to read ─────────────────────────────── */
--
-- A lookup, not a constant in code: the minimum polite interval for a system
-- is a property of that system, and changing it should be a row update.
CREATE TABLE IF NOT EXISTS lkp_ats_families (
    id              INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(30) NOT NULL UNIQUE,
    label           VARCHAR(80) NOT NULL,

    -- lkp_portal_types.name of the form a job on this system is applied through.
    -- Known BEFORE we fetch anything, which is the whole point.
    portal_type     VARCHAR(40) NOT NULL,

    -- Floor under every board of this family, in seconds. Ashby serves its
    -- board from a CDN with max-age=60 (polling faster re-reads the same cached
    -- bytes); Workday sends no-store and has no ETag, so every poll is a full
    -- request and is held to five minutes.
    min_interval_s  INT NOT NULL DEFAULT 60 CHECK (min_interval_s >= 30),

    -- Does the list endpoint honour If-None-Match? Measured live (HTTP 304, 0
    -- bytes) for Greenhouse, Lever, Ashby and SmartRecruiters; Workday is a
    -- POST with Cache-Control: no-store.
    supports_etag   BOOLEAN NOT NULL DEFAULT TRUE,

    -- Does the LIST carry the full description? Where it does not (Greenhouse,
    -- Workday, SmartRecruiters), a second request is made for NEW jobs only.
    list_has_detail BOOLEAN NOT NULL DEFAULT TRUE,

    sort_order      INT NOT NULL DEFAULT 0
);

INSERT INTO lkp_ats_families
    (name, label, portal_type, min_interval_s, supports_etag, list_has_detail, sort_order)
VALUES
    ('GREENHOUSE',      'Greenhouse',      'GREENHOUSE',      60,  TRUE,  FALSE, 1),
    ('LEVER',           'Lever',           'LEVER',           60,  TRUE,  TRUE,  2),
    ('ASHBY',           'Ashby',           'ASHBY',           60,  TRUE,  TRUE,  3),
    ('WORKDAY',         'Workday',         'WORKDAY',         300, FALSE, FALSE, 4),
    ('SMARTRECRUITERS', 'SmartRecruiters', 'SMARTRECRUITERS', 120, TRUE,  FALSE, 5)
ON CONFLICT (name) DO UPDATE
    SET label = EXCLUDED.label,
        portal_type = EXCLUDED.portal_type,
        min_interval_s = EXCLUDED.min_interval_s,
        supports_etag = EXCLUDED.supports_etag,
        list_has_detail = EXCLUDED.list_has_detail,
        sort_order = EXCLUDED.sort_order;


/* ── 2. the source row ───────────────────────────────────────────────── */
--
-- ONE row for every family, exactly as JobsPipe uses one row for nine boards:
-- first_source_id answers "which DOOR", job_postings.origin_board (046) answers
-- "which board" — and the family is written there, in lower case, matching the
-- values JobsPipe already writes ('greenhouse', 'lever', 'ashby', ...).
--
-- fetch_mode 'ATS' is new. The discovery cycle selects only 'PROVIDER' rows
-- (discoveryController), so this row can never be picked up as a search
-- provider.
ALTER TABLE lkp_job_sources
    DROP CONSTRAINT IF EXISTS lkp_job_sources_fetch_mode_check;

ALTER TABLE lkp_job_sources
    ADD CONSTRAINT lkp_job_sources_fetch_mode_check
    CHECK (fetch_mode IN ('PROVIDER', 'PORTAL', 'MANUAL', 'CSV', 'WEBHOOK', 'ENRICHMENT', 'ATS'));

INSERT INTO lkp_job_sources
    (name, label, fetch_mode, is_enabled, is_priority, max_pages, rate_limit_ms, notes)
VALUES
    ('ATS_DIRECT', 'Employer career systems (live mirror)', 'ATS', FALSE, FALSE, 1, 1000,
     'Read straight from each employer''s Greenhouse / Lever / Ashby / Workday / '
     'SmartRecruiters board. Enablement lives in ats_org_settings, not here.')
ON CONFLICT (name) DO UPDATE
    SET label = EXCLUDED.label,
        fetch_mode = EXCLUDED.fetch_mode,
        notes = EXCLUDED.notes;


/* ── 3. per-agency settings ──────────────────────────────────────────── */
--
-- One row per agency, created lazily by the API the first time the screen is
-- opened. Absent row == feature off, which is what a fresh checkout wants.
CREATE TABLE IF NOT EXISTS ats_org_settings (
    organization_id CHAR(36) PRIMARY KEY
                    REFERENCES organizations(id) ON DELETE CASCADE,

    is_enabled      BOOLEAN NOT NULL DEFAULT FALSE,

    -- OBSERVE  boards are polled and new jobs are detected and RECORDED with
    --          their detection latency, but nothing enters job_postings. No
    --          queue item, no AI preparation, no spend. This is the safe way to
    --          find out whether the mirror is worth having.
    -- LIVE     new jobs go through the full pipeline.
    mode            VARCHAR(8) NOT NULL DEFAULT 'OBSERVE'
                    CHECK (mode IN ('OBSERVE', 'LIVE')),

    -- Adaptive polling is clamped between these. A board that keeps changing
    -- drops towards min; a quiet one drifts towards max.
    min_interval_s  INT NOT NULL DEFAULT 120   CHECK (min_interval_s BETWEEN 60 AND 86400),
    max_interval_s  INT NOT NULL DEFAULT 21600 CHECK (max_interval_s BETWEEN 300 AND 604800),

    -- On first contact a board lists everything it has ever opened (Stripe: 725).
    -- Those are baseline, not news. Only jobs PROVABLY published inside this
    -- window are ingested on that first poll.
    bootstrap_age_hours INT NOT NULL DEFAULT 48 CHECK (bootstrap_age_hours BETWEEN 0 AND 720),

    -- Bounds on one poll: a runaway board cannot flood the queue or the host.
    max_ingest_per_poll INT NOT NULL DEFAULT 50 CHECK (max_ingest_per_poll BETWEEN 1 AND 500),
    detail_cap_per_poll INT NOT NULL DEFAULT 25 CHECK (detail_cap_per_poll BETWEEN 1 AND 200),

    -- When a job vanishes from its board, also set job_postings.is_active =
    -- FALSE. Off by default: it reaches rows other doors created.
    close_on_removal BOOLEAN NOT NULL DEFAULT FALSE,

    updated_by      CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_ats_interval_order CHECK (min_interval_s <= max_interval_s)
);

DROP TRIGGER IF EXISTS trg_ats_org_settings_updated_at ON ats_org_settings;
CREATE TRIGGER trg_ats_org_settings_updated_at
    BEFORE UPDATE ON ats_org_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


/* ── 4. the registry: one row per employer board ─────────────────────── */
CREATE TABLE IF NOT EXISTS ats_boards (
    id              CHAR(36) PRIMARY KEY,
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    family_id       INT NOT NULL REFERENCES lkp_ats_families(id),

    -- How the family addresses this employer: the Greenhouse board token, the
    -- Lever slug, the Ashby name, the SmartRecruiters company identifier, or
    -- for Workday 'tenant.wdN/site'. Lower-cased where the family is
    -- case-insensitive; stored as given where it is not.
    board_key       VARCHAR(200) NOT NULL CHECK (length(btrim(board_key)) > 0),

    -- Family-specific parameters that do not fit board_key (Workday's shard).
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,

    company_name    VARCHAR(255) DEFAULT NULL,
    careers_url     VARCHAR(500) DEFAULT NULL,

    is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    -- Held at the minimum interval regardless of how quiet the board is.
    is_priority     BOOLEAN NOT NULL DEFAULT FALSE,

    -- PENDING   registered, not yet read
    -- ACTIVE    baselined and being polled
    -- FAILING   recent polls erroring; still retried, with backoff
    -- NOT_FOUND the employer no longer has a board at this address
    status          VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'ACTIVE', 'FAILING', 'NOT_FOUND')),

    -- ── polling state ────────────────────────────────────────────────
    etag            VARCHAR(300) DEFAULT NULL,
    list_hash       CHAR(64)     DEFAULT NULL,
    interval_s      INT NOT NULL DEFAULT 300 CHECK (interval_s >= 30),
    next_poll_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A claim, not a lock: set when a worker takes the board and lapses by
    -- itself, so a crashed worker cannot strand a board.
    claimed_until   TIMESTAMPTZ DEFAULT NULL,

    baselined_at    TIMESTAMPTZ DEFAULT NULL,
    last_polled_at  TIMESTAMPTZ DEFAULT NULL,
    last_success_at TIMESTAMPTZ DEFAULT NULL,
    last_changed_at TIMESTAMPTZ DEFAULT NULL,
    last_error      VARCHAR(500) DEFAULT NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,
    consecutive_not_found INT NOT NULL DEFAULT 0,

    -- ── running totals, for the screen ───────────────────────────────
    jobs_open       INT NOT NULL DEFAULT 0,
    jobs_detected   INT NOT NULL DEFAULT 0,
    jobs_ingested   INT NOT NULL DEFAULT 0,
    jobs_queued     INT NOT NULL DEFAULT 0,

    created_by      CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_ats_board_per_org UNIQUE (organization_id, family_id, board_key)
);

-- The query the scheduler runs every tick: what is due, oldest first.
CREATE INDEX IF NOT EXISTS idx_ats_boards_due
    ON ats_boards (next_poll_at)
    WHERE is_enabled AND status <> 'NOT_FOUND';

CREATE INDEX IF NOT EXISTS idx_ats_boards_org
    ON ats_boards (organization_id, status);

DROP TRIGGER IF EXISTS trg_ats_boards_updated_at ON ats_boards;
CREATE TRIGGER trg_ats_boards_updated_at
    BEFORE UPDATE ON ats_boards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


/* ── 5. what each board currently lists ──────────────────────────────── */
--
-- The memory the diff runs against. A job id present now and absent from this
-- table is NEW; an id in this table and absent from the board has been taken
-- down. One row per (board, job), never deleted — closed_at is the record of
-- removal, and the row is what stops a re-listed job being treated as new.
CREATE TABLE IF NOT EXISTS ats_board_jobs (
    board_id        CHAR(36) NOT NULL REFERENCES ats_boards(id) ON DELETE CASCADE,
    ext_id          VARCHAR(160) NOT NULL,

    -- Denormalised so the live feed can be read without joining boards.
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    title           VARCHAR(255) DEFAULT NULL,
    location_text   VARCHAR(255) DEFAULT NULL,

    -- BASELINE   already open when we first read the board; never ingested
    -- DETECTED   new, waiting for its detail request (capped per poll)
    -- OBSERVED   new, recorded only — the org is in OBSERVE mode
    -- INGESTED   handed to the pipeline and stored as a new posting
    -- DUPLICATE  handed to the pipeline; it already held this job (R-15)
    -- FAILED     detail or normalisation failed; retried a bounded number of times
    state           VARCHAR(10) NOT NULL
                    CHECK (state IN ('BASELINE', 'DETECTED', 'OBSERVED',
                                     'INGESTED', 'DUPLICATE', 'FAILED')),

    -- When the employer says it was published, if the family says. NULL is
    -- honest; a guessed date would corrupt the latency figure below.
    published_at    TIMESTAMPTZ DEFAULT NULL,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Seconds from publication to our first sight of it: THE number this
    -- feature exists to shrink. NULL where published_at is unknown.
    latency_s       INT DEFAULT NULL,

    -- Consecutive successful polls in which the job was missing. Two, not one,
    -- before it counts as closed, so one truncated response closes nothing.
    missed_polls    INT NOT NULL DEFAULT 0,
    closed_at       TIMESTAMPTZ DEFAULT NULL,

    content_hash    CHAR(64) DEFAULT NULL,
    apply_url       VARCHAR(1000) DEFAULT NULL,
    source_url      VARCHAR(1000) DEFAULT NULL,

    posting_id      CHAR(36) DEFAULT NULL REFERENCES job_postings(id) ON DELETE SET NULL,
    matches         INT NOT NULL DEFAULT 0,
    queued          INT NOT NULL DEFAULT 0,
    detail_attempts INT NOT NULL DEFAULT 0,

    -- The family's own payload for this job. Kept ONLY for jobs that were
    -- detected after baseline, so a parser fix can be replayed over them (the
    -- reason job_source_payloads exists) without storing a million baselines.
    raw             JSONB DEFAULT NULL,

    PRIMARY KEY (board_id, ext_id)
);

CREATE INDEX IF NOT EXISTS idx_ats_jobs_feed
    ON ats_board_jobs (organization_id, first_seen_at DESC)
    WHERE state <> 'BASELINE';

CREATE INDEX IF NOT EXISTS idx_ats_jobs_pending
    ON ats_board_jobs (board_id)
    WHERE state IN ('DETECTED', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_ats_jobs_open
    ON ats_board_jobs (board_id)
    WHERE closed_at IS NULL;


/* ── 6. the poll ledger ──────────────────────────────────────────────── */
--
-- One row per poll. Unlike jobspipe_poll_runs there is no credit column: the
-- endpoints are free. What is worth keeping is what makes the mirror
-- trustworthy — how many polls were 304s (cheap), how long they took, and what
-- each one found. Pruned by the scheduler after 14 days.
CREATE TABLE IF NOT EXISTS ats_poll_runs (
    id              CHAR(36) PRIMARY KEY,
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    board_id        CHAR(36) NOT NULL REFERENCES ats_boards(id) ON DELETE CASCADE,

    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms     INT DEFAULT NULL,
    trigger         VARCHAR(10) NOT NULL DEFAULT 'SCHEDULED'
                    CHECK (trigger IN ('SCHEDULED', 'MANUAL', 'ADD')),

    -- OK            read and diffed
    -- BASELINED     first successful read; existing jobs recorded silently
    -- NOT_MODIFIED  304, nothing to do
    -- NOT_FOUND     the family says this board does not exist
    -- ERROR         timeout, 5xx, unparseable
    outcome         VARCHAR(12) NOT NULL
                    CHECK (outcome IN ('OK', 'BASELINED', 'NOT_MODIFIED', 'NOT_FOUND', 'ERROR')),

    http_status     INT DEFAULT NULL,
    bytes           INT DEFAULT NULL,

    jobs_listed     INT NOT NULL DEFAULT 0,
    new_found       INT NOT NULL DEFAULT 0,
    detail_fetches  INT NOT NULL DEFAULT 0,
    ingested        INT NOT NULL DEFAULT 0,
    duplicates      INT NOT NULL DEFAULT 0,
    matches         INT NOT NULL DEFAULT 0,
    queued          INT NOT NULL DEFAULT 0,
    closed          INT NOT NULL DEFAULT 0,

    error           VARCHAR(500) DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_ats_runs_org
    ON ats_poll_runs (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ats_runs_board
    ON ats_poll_runs (board_id, started_at DESC);

COMMENT ON TABLE ats_boards IS
    'Registry of employer career-system boards read by the live mirror. One row '
    'per (agency, family, board). Polled adaptively; see config/atsSchedule.js.';
COMMENT ON TABLE ats_board_jobs IS
    'What each board listed last time. The diff target: an id absent here is a '
    'new job. state=BASELINE rows existed at first contact and are never ingested.';
COMMENT ON COLUMN ats_board_jobs.latency_s IS
    'Seconds from the employer''s published date to our first sight of the job. '
    'NULL when the family does not say when it was published.';
COMMENT ON COLUMN ats_org_settings.mode IS
    'OBSERVE records detections without creating postings; LIVE runs the full '
    'ingest pipeline. New agencies start in OBSERVE.';
