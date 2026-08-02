-- 007_resume_artifacts.sql
-- Purpose: uploaded resume files. Base resumes now; tailored resumes later.
-- Phase: 2

CREATE TABLE IF NOT EXISTS resume_artifacts (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL
                    REFERENCES users(id) ON DELETE CASCADE,

    -- 'base'    = the consultant's source resume
    -- 'tailored'= generated per job (later phase)
    kind            VARCHAR(20)  NOT NULL DEFAULT 'base'
                    CHECK (kind IN ('base', 'tailored')),

    original_name   VARCHAR(255) NOT NULL,   -- what the user called it
    stored_name     VARCHAR(255) NOT NULL,   -- uuid on disk, never user input
    mime_type       VARCHAR(100) NOT NULL,
    size_bytes      INT          NOT NULL,
    sha256          CHAR(64)     NOT NULL,   -- integrity + duplicate detection

    uploaded_by     CHAR(36)     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,

    created_by      CHAR(36)     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by      CHAR(36)     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_resume_org_consultant
    ON resume_artifacts (organization_id, consultant_id);
CREATE INDEX IF NOT EXISTS idx_resume_org_kind
    ON resume_artifacts (organization_id, kind);

DROP TRIGGER IF EXISTS trg_resume_artifacts_updated_at ON resume_artifacts;
CREATE TRIGGER trg_resume_artifacts_updated_at
    BEFORE UPDATE ON resume_artifacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
