-- 015_align_user_status_lookup.sql
-- Purpose: make lkp_user_statuses agree with the employment model it is
--          supposed to describe.
-- Phase: 2 (remediation — status naming consistency)
--
-- THE PROBLEM
--   lkp_user_statuses was seeded in Phase 1 with 'Active', 'Disabled',
--   'Invited'. Migration 012 then replaced the underlying model with
--   employment_status = ACTIVE | SUSPENDED | TERMINATED, and the lookup was
--   never updated. So GET /api/lookups has been serving three names of which
--   one ('Active') half-matches, one ('Disabled') describes a state that no
--   longer exists, and one ('Invited') describes a state that never existed —
--   there is no invitation flow anywhere in this system.
--
--   Nothing consumes it yet, which is exactly why it was free to drift. A
--   lookup that disagrees with its own table is a trap for the next feature
--   that reaches for it, so it is corrected now rather than when it breaks
--   something.
--
-- THE FIX
--   Mirror employment_status exactly: `name` is the value the database stores
--   and the API returns, `label` is the text the UI shows. That is already the
--   lkp_roles convention, so this makes the two lookups the same shape.

ALTER TABLE lkp_user_statuses
    ADD COLUMN IF NOT EXISTS label VARCHAR(80);

-- No FK points at this table (users carries employment_status directly), so
-- clearing it cannot orphan a row.
DELETE FROM lkp_user_statuses;

INSERT INTO lkp_user_statuses (name, label) VALUES
    ('ACTIVE',     'Active'),
    ('SUSPENDED',  'Suspended'),
    ('TERMINATED', 'Terminated')
ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label;

ALTER TABLE lkp_user_statuses
    ALTER COLUMN label SET NOT NULL;

COMMENT ON TABLE lkp_user_statuses IS
    'Mirrors users.employment_status. name = stored value, label = UI text. '
    'Keep in step with the CHECK constraint on users.employment_status.';
