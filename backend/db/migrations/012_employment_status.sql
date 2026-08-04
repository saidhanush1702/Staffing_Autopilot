-- 012_employment_status.sql
-- Purpose: replace the is_active boolean with a three-state employment model.
-- Phase: 2 (remediation)
--
-- WHY
--   `is_active = false` conflated two very different things: "temporarily
--   locked out" and "no longer works here". They need different rules —
--   one is reversible, the other is not — and the org admin needs to tell
--   them apart at a glance.
--
-- THE MODEL
--   ACTIVE      normal. Can sign in.
--   SUSPENDED   access removed, still an employee. REVERSIBLE.
--   TERMINATED  resigned or dismissed. Not an employee. IRREVERSIBLE.
--
--   ACTIVE  <-> SUSPENDED        both directions allowed
--   ACTIVE   -> TERMINATED       one way
--   SUSPENDED-> TERMINATED       one way
--   TERMINATED -> anything       BLOCKED (enforced in the controller)
--
-- is_active survives as a GENERATED column so every existing SELECT keeps
-- working. Being generated, it can no longer be written — which deliberately
-- breaks any old `UPDATE ... SET is_active` at development time rather than
-- letting two sources of truth drift apart the way `phone` did.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS employment_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
        CHECK (employment_status IN ('ACTIVE', 'SUSPENDED', 'TERMINATED')),
    ADD COLUMN IF NOT EXISTS suspended_at    TIMESTAMPTZ  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS suspended_by    CHAR(36)     DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS suspend_reason  VARCHAR(500) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS terminated_at   TIMESTAMPTZ  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS terminated_by   CHAR(36)     DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS termination_reason VARCHAR(500) DEFAULT NULL;

-- Anyone previously disabled becomes SUSPENDED, not TERMINATED — termination
-- is a deliberate act and must never be inferred.
UPDATE users
   SET employment_status = 'SUSPENDED',
       suspended_at = COALESCE(updated_at, now())
 WHERE is_active = FALSE;

ALTER TABLE users DROP COLUMN is_active;

ALTER TABLE users
    ADD COLUMN is_active BOOLEAN
        GENERATED ALWAYS AS (employment_status = 'ACTIVE') STORED;

ALTER TABLE users
    ADD CONSTRAINT fk_users_suspended_by
        FOREIGN KEY (suspended_by) REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_users_terminated_by
        FOREIGN KEY (terminated_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_org_employment
    ON users (organization_id, employment_status);

COMMENT ON COLUMN users.employment_status IS
    'ACTIVE | SUSPENDED (reversible) | TERMINATED (permanent). Drives is_active.';
COMMENT ON COLUMN users.is_active IS
    'Generated from employment_status. Read-only — change employment_status instead.';
