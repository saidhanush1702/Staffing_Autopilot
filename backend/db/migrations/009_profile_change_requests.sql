-- 009_profile_change_requests.sql
-- Purpose: the consultant self-service edit + approval workflow.
-- Phase: 2
--
-- Flow:
--   consultant edits profile -> only CHANGED fields become a request
--   -> live profile is untouched, still used for job matching
--   -> ORG_ADMIN or the assigned RECRUITER reviews EACH FIELD individually
--   -> approved fields are copied into consultant_profiles
--   -> rejected fields return to the consultant with a note
--
-- Same two-person principle as the answer bank in the spec: the person who
-- proposes a value is never the person who approves it.

CREATE TABLE IF NOT EXISTS profile_change_requests (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,

    -- PENDING            -> awaiting review
    -- APPROVED           -> every field accepted
    -- REJECTED           -> every field rejected
    -- PARTIALLY_APPROVED -> some accepted, some rejected
    -- WITHDRAWN          -> consultant cancelled before review
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','APPROVED','REJECTED','PARTIALLY_APPROVED','WITHDRAWN')),

    submitted_by    CHAR(36)    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    reviewed_by     CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ DEFAULT NULL,
    review_note     VARCHAR(500) DEFAULT NULL,

    created_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE pending request per consultant at a time. Enforced by the database, not
-- just the UI, so a double-submit or a stale tab cannot create a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_request_per_consultant
    ON profile_change_requests (consultant_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_pcr_org_status
    ON profile_change_requests (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_pcr_org_consultant
    ON profile_change_requests (organization_id, consultant_id);

DROP TRIGGER IF EXISTS trg_pcr_updated_at ON profile_change_requests;
CREATE TRIGGER trg_pcr_updated_at
    BEFORE UPDATE ON profile_change_requests
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── one row per changed field ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profile_change_request_fields (
    id                CHAR(36) PRIMARY KEY,

    change_request_id CHAR(36) NOT NULL
                      REFERENCES profile_change_requests(id) ON DELETE CASCADE,

    -- Matches a key in backend/config/profileFields.js
    field_name        VARCHAR(64)  NOT NULL,

    -- Snapshots taken at submit time, stored as text regardless of the
    -- column's real type. Keeping them here means the request stays readable
    -- even after the live profile moves on.
    old_value         TEXT         DEFAULT NULL,
    new_value         TEXT         DEFAULT NULL,

    -- Human-readable versions, so the approval screen can show
    -- "H1-B" rather than a lookup id.
    old_display       VARCHAR(255) DEFAULT NULL,
    new_display       VARCHAR(255) DEFAULT NULL,

    status            VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','APPROVED','REJECTED')),

    reviewed_by       CHAR(36)     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at       TIMESTAMPTZ  DEFAULT NULL,
    review_note       VARCHAR(500) DEFAULT NULL,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_field_per_request UNIQUE (change_request_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_pcrf_request ON profile_change_request_fields (change_request_id);
