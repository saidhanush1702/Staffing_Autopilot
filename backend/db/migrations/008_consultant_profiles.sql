-- 008_consultant_profiles.sql
-- Purpose: the LIVE (approved) consultant profile. One row per CONSULTANT user.
-- Phase: 2
--
-- These are the values the system actually uses. A consultant's proposed edits
-- never land here directly — they go through profile_change_requests (009) and
-- are copied in only on approval.
--
-- EXTENSIBILITY: to add a new profile field later ->
--   1. add the column here in a NEW migration
--   2. add one entry to backend/config/profileFields.js
-- The consultant form, diff engine, approval screen and completeness badge all
-- read that registry, so nothing else needs changing.

CREATE TABLE IF NOT EXISTS consultant_profiles (
    user_id         CHAR(36) PRIMARY KEY
                    REFERENCES users(id) ON DELETE CASCADE,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- ── consultant-editable (via approval) ────────────────────────────
    phone               VARCHAR(30)  DEFAULT NULL,
    city                VARCHAR(120) DEFAULT NULL,
    state               VARCHAR(120) DEFAULT NULL,
    work_auth_status_id INT          DEFAULT NULL
                        REFERENCES lkp_work_auth_statuses(id) ON DELETE SET NULL,
    work_auth_notes     VARCHAR(500) DEFAULT NULL,
    linkedin_url        VARCHAR(255) DEFAULT NULL,
    base_resume_artifact_id CHAR(36) DEFAULT NULL
                        REFERENCES resume_artifacts(id) ON DELETE SET NULL,

    -- ── admin-only, never proposed by the consultant ──────────────────
    daily_cap        INT         NOT NULL DEFAULT 5 CHECK (daily_cap BETWEEN 0 AND 100),
    consent_on_file  BOOLEAN     NOT NULL DEFAULT FALSE,
    consent_signed_at DATE       DEFAULT NULL,
    is_paused        BOOLEAN     NOT NULL DEFAULT FALSE,
    notes            TEXT        DEFAULT NULL,

    created_by      CHAR(36)     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by      CHAR(36)     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_org        ON consultant_profiles (organization_id);
CREATE INDEX IF NOT EXISTS idx_profiles_org_paused ON consultant_profiles (organization_id, is_paused);

DROP TRIGGER IF EXISTS trg_consultant_profiles_updated_at ON consultant_profiles;
CREATE TRIGGER trg_consultant_profiles_updated_at
    BEFORE UPDATE ON consultant_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
