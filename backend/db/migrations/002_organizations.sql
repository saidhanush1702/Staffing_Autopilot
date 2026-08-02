-- 002_organizations.sql
-- Purpose: tenant root. One row per staffing agency.
-- Phase: 1

CREATE TABLE IF NOT EXISTS organizations (
    id          CHAR(36) PRIMARY KEY,
    lookup_id   INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    name        VARCHAR(255) NOT NULL,
    slug        CITEXT       NOT NULL UNIQUE,
    contact_email CITEXT     DEFAULT NULL,
    contact_phone VARCHAR(30) DEFAULT NULL,
    timezone    VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',

    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,

    -- audit columns (FKs to users added in 003, after users exists)
    created_by  CHAR(36)     DEFAULT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by  CHAR(36)     DEFAULT NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organizations_active ON organizations (is_active);

DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
