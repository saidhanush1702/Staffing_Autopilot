-- 024_job_queue.sql
-- Purpose: which job goes to which consultant, and the record of each run.
-- Phase: 5
--
-- Scope note: this phase stops at FINDING and MATCHING. Filling and submitting
-- are a later phase, so the queue's later states exist in the vocabulary but
-- nothing drives an item past QUEUED yet. The state machine is declared now
-- (config/queueStates.js) so the states it will pass through are already
-- constrained when something starts moving them.

CREATE TABLE IF NOT EXISTS discovery_runs (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- SCHEDULED the 4-hour cycle
    -- MANUAL    somebody pressed the button
    trigger         VARCHAR(10) NOT NULL DEFAULT 'MANUAL'
                    CHECK (trigger IN ('SCHEDULED', 'MANUAL')),
    triggered_by    CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,

    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ DEFAULT NULL,

    -- Per-stage counts. These are the only way to tell a run that found nothing
    -- because there was nothing from a run that found nothing because a parser
    -- broke — a distinction a bare success flag destroys.
    sources_attempted   INT NOT NULL DEFAULT 0,
    sources_failed      INT NOT NULL DEFAULT 0,
    raw_items           INT NOT NULL DEFAULT 0,
    parsed_ok           INT NOT NULL DEFAULT 0,
    quarantined         INT NOT NULL DEFAULT 0,
    postings_new        INT NOT NULL DEFAULT 0,
    postings_duplicate  INT NOT NULL DEFAULT 0,
    prefilter_in        INT NOT NULL DEFAULT 0,
    prefilter_out       INT NOT NULL DEFAULT 0,
    matches_found       INT NOT NULL DEFAULT 0,
    queued              INT NOT NULL DEFAULT 0,
    held_by_cap         INT NOT NULL DEFAULT 0,

    error           VARCHAR(1000) DEFAULT NULL,
    notes           TEXT DEFAULT NULL
);

-- Two runs must never overlap for one organisation (spec feature 27). A partial
-- unique index makes a concurrent start impossible rather than unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_running_discovery
    ON discovery_runs (organization_id) WHERE finished_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_runs_org_started
    ON discovery_runs (organization_id, started_at DESC);


-- ── matches: every posting that suits a consultant ────────────────────
--
-- Separate from queue_items because a match and a queue slot are different
-- things. R-17 stops ASSIGNMENT at the daily cap; it does not say the surplus
-- is thrown away. A match found on a busy day is HELD here and reconsidered
-- tomorrow, so a good job is not lost to the hour it arrived.
CREATE TABLE IF NOT EXISTS job_matches (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    posting_id      CHAR(36) NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,

    -- Phase 3 made versions immutable for exactly this. Six months from now,
    -- "why was this job sent to this person?" resolves to a criteria version
    -- that still exists verbatim.
    criteria_version_id CHAR(36) DEFAULT NULL
                        REFERENCES search_criteria_versions(id) ON DELETE SET NULL,

    score           INT NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
    reason          VARCHAR(500) DEFAULT NULL,

    -- PENDING  matched, waiting for a queue slot
    -- QUEUED   promoted into the queue
    -- HELD     cap reached today, try again next run
    -- DISCARDED  no longer relevant (posting closed, criteria changed)
    status          VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'QUEUED', 'HELD', 'DISCARDED')),

    matched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    run_id          CHAR(36) DEFAULT NULL REFERENCES discovery_runs(id) ON DELETE SET NULL,

    CONSTRAINT uq_match_per_consultant_posting UNIQUE (consultant_id, posting_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_pending
    ON job_matches (organization_id, consultant_id, status, score DESC)
    WHERE status IN ('PENDING', 'HELD');


-- ── the queue ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_items (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    posting_id      CHAR(36) NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
    match_id        CHAR(36) DEFAULT NULL REFERENCES job_matches(id) ON DELETE SET NULL,

    status_id       INT NOT NULL REFERENCES lkp_queue_statuses(id) ON DELETE RESTRICT,

    -- R-01 / R-03. One job legitimately reaches several consultants; each
    -- applies under their own name. The flag exists so a dashboard can SHOW it,
    -- never so the system can prevent it. Nothing anywhere moves a queue item
    -- to a different consultant.
    is_overlap      BOOLEAN NOT NULL DEFAULT FALSE,

    skip_reason     VARCHAR(500) DEFAULT NULL,
    park_reason     VARCHAR(500) DEFAULT NULL,

    -- Populated by later phases. Declared now so their foreign keys are not a
    -- migration against a live table.
    tailored_resume_artifact_id CHAR(36) DEFAULT NULL
                    REFERENCES resume_artifacts(id) ON DELETE SET NULL,

    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    run_id          CHAR(36)    DEFAULT NULL REFERENCES discovery_runs(id) ON DELETE SET NULL,
    updated_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_queue_item_per_consultant_posting UNIQUE (consultant_id, posting_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_org_consultant
    ON queue_items (organization_id, consultant_id, status_id);
CREATE INDEX IF NOT EXISTS idx_queue_posting ON queue_items (posting_id);

DROP TRIGGER IF EXISTS trg_queue_items_updated_at ON queue_items;
CREATE TRIGGER trg_queue_items_updated_at
    BEFORE UPDATE ON queue_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── every move, kept ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_item_transitions (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    queue_item_id   CHAR(36) NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,

    from_status_id  INT DEFAULT NULL REFERENCES lkp_queue_statuses(id) ON DELETE SET NULL,
    to_status_id    INT NOT NULL     REFERENCES lkp_queue_statuses(id) ON DELETE RESTRICT,

    reason          VARCHAR(500) DEFAULT NULL,
    performed_by    CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transitions_item
    ON queue_item_transitions (queue_item_id, created_at);
