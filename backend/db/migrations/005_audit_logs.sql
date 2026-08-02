-- 005_audit_logs.sql
-- Purpose: append-only activity log. Every module writes here.
-- Phase: 1
--
-- performed_by_name and performed_by_role are DENORMALISED SNAPSHOTS, not
-- joins: history must survive a user being renamed, disabled, or deleted.

CREATE TABLE IF NOT EXISTS audit_logs (
    id                CHAR(36) PRIMARY KEY,

    organization_id   CHAR(36) NOT NULL
                      REFERENCES organizations(id) ON DELETE CASCADE,

    module            VARCHAR(50)  NOT NULL,   -- 'users', 'assignments'
    action            VARCHAR(100) NOT NULL,   -- 'Added User', 'Disabled User'
    entity_type       VARCHAR(100) NOT NULL,
    entity_id         VARCHAR(100) DEFAULT NULL,
    entity_name       VARCHAR(255) DEFAULT NULL,

    performed_by      CHAR(36)     NOT NULL,
    performed_by_name VARCHAR(255) DEFAULT NULL,
    performed_by_role VARCHAR(50)  DEFAULT NULL,

    description       TEXT         DEFAULT NULL,
    ip_address        VARCHAR(64)  DEFAULT NULL,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_org_module ON audit_logs (organization_id, module);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_entity ON audit_logs (organization_id, entity_type, entity_id);

-- ── Append-only enforcement ───────────────────────────────────────────
-- Two independent layers, so the guarantee survives a code bug:
--   1. a trigger that refuses UPDATE/DELETE no matter who is asking
--   2. revoking the privilege from the runtime role entirely

CREATE OR REPLACE FUNCTION audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_role';
        EXECUTE 'GRANT  INSERT, SELECT                ON audit_logs TO   app_role';
    END IF;
END $$;
