-- 017_search_criteria.sql
-- Purpose: WHAT a consultant is looking for. The input the job discovery
--          engine (Phase 5) will consume.
-- Phase: 3
--
-- Two tables here, and the split matters:
--
--   search_criteria           ONE row per consultant. MUTABLE. Holds the
--                             operational state — is discovery on or off —
--                             and a pointer to the version in force.
--
--   search_criteria_versions  APPEND-ONLY snapshots. Every save writes a new
--                             one; nothing is ever updated in place except
--                             the `is_current` flag.
--
-- WHY IMMUTABLE VERSIONS. Months from now the question "why did this job
-- match?" has exactly one honest answer: because of the criteria in force at
-- match time. That only works if that version still exists verbatim. A change
-- log that has to be replayed will eventually disagree with what actually
-- happened. Phase 5 queue items will carry a foreign key to the version that
-- matched them.
--
-- WHY PAUSE LIVES ON THE PARENT. Pausing is not an edit to the criteria, it is
-- an operational state. If it forked a version, the history would fill with
-- entries that say nothing about what is being searched for.
--
-- Cost of the snapshot approach: a criteria set is on the order of 30 rows and
-- saves are a human action a few times a month per consultant. Storage is not
-- the constraint; answerability is.

CREATE TABLE IF NOT EXISTS search_criteria (
    consultant_id      CHAR(36) PRIMARY KEY
                       REFERENCES users(id) ON DELETE CASCADE,
    lookup_id          INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id    CHAR(36) NOT NULL
                       REFERENCES organizations(id) ON DELETE CASCADE,

    -- FALSE by default, and deliberately so. A consultant with no criteria
    -- set up must never receive every job on the internet — the system fails
    -- closed. Downstream phases treat an active-but-empty set the same way.
    is_active          BOOLEAN NOT NULL DEFAULT FALSE,

    paused_at          TIMESTAMPTZ DEFAULT NULL,
    paused_by          CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,

    -- Set after the first save. NULL means "never configured", which the UI
    -- shows as `Not set up` — a different thing from `Paused`.
    current_version_id CHAR(36)    DEFAULT NULL,

    created_by         CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by         CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_criteria_org        ON search_criteria (organization_id);
CREATE INDEX IF NOT EXISTS idx_criteria_org_active ON search_criteria (organization_id, is_active);

DROP TRIGGER IF EXISTS trg_search_criteria_updated_at ON search_criteria;
CREATE TRIGGER trg_search_criteria_updated_at
    BEFORE UPDATE ON search_criteria
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── immutable snapshots ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_criteria_versions (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,

    -- 1, 2, 3 … per consultant. Shown to people; never reused.
    version_no      INT NOT NULL CHECK (version_no > 0),

    -- Exactly one version per consultant is current at a time.
    is_current      BOOLEAN NOT NULL DEFAULT TRUE,

    -- ── minimum pay ───────────────────────────────────────────────────
    -- Amount and unit travel together or not at all: "60" alone is either an
    -- hourly rate or a catastrophic salary expectation. The CHECK makes a
    -- half-filled pair impossible to store, so no reader has to guess.
    min_pay_amount  NUMERIC(12,2) DEFAULT NULL CHECK (min_pay_amount IS NULL OR min_pay_amount >= 0),
    min_pay_unit    VARCHAR(10)   DEFAULT NULL CHECK (min_pay_unit IN ('HOURLY','ANNUAL')),
    min_pay_currency CHAR(3)      NOT NULL DEFAULT 'USD',

    CONSTRAINT chk_pay_amount_needs_unit
        CHECK ((min_pay_amount IS NULL) = (min_pay_unit IS NULL)),

    -- Why this version exists, in the editor's own words.
    change_note     VARCHAR(500) DEFAULT NULL,

    created_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_version_no_per_consultant UNIQUE (consultant_id, version_no)
);

-- At most ONE current version per consultant, enforced by the database rather
-- than by careful controller code — the same guarantee, and the same partial
-- index shape, as uq_one_pending_request_per_consultant in migration 009.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_current_version_per_consultant
    ON search_criteria_versions (consultant_id) WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_scv_org_consultant
    ON search_criteria_versions (organization_id, consultant_id);

-- Deferred to here rather than declared inline: search_criteria is created
-- first, so the FK to versions cannot exist until the versions table does.
ALTER TABLE search_criteria
    DROP CONSTRAINT IF EXISTS fk_criteria_current_version;
ALTER TABLE search_criteria
    ADD CONSTRAINT fk_criteria_current_version
    FOREIGN KEY (current_version_id)
    REFERENCES search_criteria_versions(id) ON DELETE SET NULL;
