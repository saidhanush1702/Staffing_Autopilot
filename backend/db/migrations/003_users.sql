-- 003_users.sql
-- Purpose: all four roles in one table. Passwords stored AES-256-GCM encrypted.
-- Phase: 1

CREATE TABLE IF NOT EXISTS users (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    -- NULL only for SUPER_ADMIN, who sits above every tenant.
    organization_id CHAR(36)     DEFAULT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    name            VARCHAR(255) NOT NULL,
    email           CITEXT       NOT NULL UNIQUE,
    phone           VARCHAR(30)  DEFAULT NULL,

    -- A CHECK is used instead of a native ENUM type: adding a role later is a
    -- one-line ALTER here, whereas ALTER TYPE ... ADD VALUE has transaction
    -- restrictions that fight the migration runner.
    role            VARCHAR(30)  NOT NULL
                    CHECK (role IN ('SUPER_ADMIN', 'ORG_ADMIN', 'RECRUITER', 'CONSULTANT')),

    -- ── Password: reversible AES-256-GCM ──────────────────────────────
    -- WARNING: this is recoverable plaintext to anyone holding both the
    -- database and PASSWORD_ENC_KEY. Chosen deliberately by the product owner
    -- over one-way hashing. See backend/utils/crypto.js.
    password_enc    TEXT         NOT NULL,   -- base64 ciphertext
    password_iv     VARCHAR(32)  NOT NULL,   -- hex, 12 bytes
    password_tag    VARCHAR(32)  NOT NULL,   -- hex GCM auth tag

    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ  DEFAULT NULL,

    -- reserved for the Phase 2 reset flow; added now so no ALTER is needed
    reset_code      CHAR(6)      DEFAULT NULL,
    reset_expiry    TIMESTAMPTZ  DEFAULT NULL,

    created_by      CHAR(36)     DEFAULT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by      CHAR(36)     DEFAULT NULL,
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- Every role except SUPER_ADMIN must belong to exactly one organisation.
    CONSTRAINT chk_org_required CHECK (
        (role = 'SUPER_ADMIN' AND organization_id IS NULL)
        OR (role <> 'SUPER_ADMIN' AND organization_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_users_org_role   ON users (organization_id, role);
CREATE INDEX IF NOT EXISTS idx_users_org_active ON users (organization_id, is_active);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Now that users exists, close the audit FKs on organizations.
ALTER TABLE organizations
    ADD CONSTRAINT fk_organizations_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_organizations_updated_by
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE users
    ADD CONSTRAINT fk_users_created_by
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_users_updated_by
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
