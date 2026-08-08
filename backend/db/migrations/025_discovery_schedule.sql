-- 025_discovery_schedule.sql
-- Purpose: per-organisation control of the 4-hour discovery cycle.
-- Phase: 5
--
-- The cycle was previously all-or-nothing for the whole deployment, decided by
-- DISCOVERY_ENABLED in the environment. That is the wrong granularity for a
-- multi-tenant system: one organisation pausing automatic discovery should not
-- stop it for everybody else, and an ORG_ADMIN should be able to make that
-- decision without a redeploy or a platform admin.
--
-- The env var keeps its job — whether this PROCESS runs the cycle at all — and
-- this column decides which tenants take part in it. Both must be true.
--
-- Defaults to FALSE for the same reason boards ship disabled: nothing reaches
-- out to the open web until somebody deliberately turns it on.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS discovery_schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN organizations.discovery_schedule_enabled IS
    'Whether the 4-hour job discovery cycle runs for this tenant. '
    'Requires DISCOVERY_ENABLED=true on the server as well. '
    'Manual "Run discovery now" is unaffected by this flag.';
