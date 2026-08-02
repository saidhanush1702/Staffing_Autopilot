-- 004_assignments.sql
-- Purpose: which consultant belongs to which recruiter, with history.
-- Phase: 1
--
-- This is what makes RECRUITER scoping real: a recruiter sees a consultant
-- only if a current assignment row links them. Reassignment closes the old
-- row (effective_to = today) and inserts a new one — history is never
-- overwritten, so "who moved whom, when" is always answerable.

CREATE TABLE IF NOT EXISTS assignments (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recruiter_id    CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    effective_from  DATE     NOT NULL DEFAULT CURRENT_DATE,
    effective_to    DATE     DEFAULT NULL,      -- NULL = currently active
    reason          VARCHAR(255) DEFAULT NULL,

    created_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_assignment_dates
        CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- A consultant may have at most ONE current recruiter.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignments_one_current
    ON assignments (consultant_id) WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_assignments_org_recruiter
    ON assignments (organization_id, recruiter_id);
CREATE INDEX IF NOT EXISTS idx_assignments_org_consultant
    ON assignments (organization_id, consultant_id);

DROP TRIGGER IF EXISTS trg_assignments_updated_at ON assignments;
CREATE TRIGGER trg_assignments_updated_at
    BEFORE UPDATE ON assignments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
