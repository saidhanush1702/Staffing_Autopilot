-- 029_queue_lanes_and_leasing.sql
-- Purpose: the two lanes, the readiness gate, item leasing, and the link back
--          to the answer bank.
-- Phase: 5 → 6
--
-- ── THE THREE IDEAS IN HERE ───────────────────────────────────────────
--
-- 1. LANES.  Everything the provider returns is ingested, but only some jobs
--    apply through a system the desktop app can fill. `channel` records which,
--    decided at ingest from the portal, so both surfaces know who owns an item
--    and the consultant never sees the same job in two places.
--
-- 2. READINESS.  QUEUED no longer means "ready for the app". An item is created
--    by the discovery cycle and only becomes READY once the preparation stage
--    has tailored its resume. Without this the app would attach whatever resume
--    happened to be there when it looked.
--
-- 3. LEASING.  The app works an item over minutes while recruiters and the
--    cycle are also writing. A lease with an EXPIRY is what stops a crashed app
--    from locking a job forever — a plain "in progress" flag has no way back.

-- ── the fuller vocabulary ─────────────────────────────────────────────
--
-- Every stage of the pipeline becomes a state, so a dashboard can show where
-- work actually is. "Queued but not yet prepared" and "ready and waiting for
-- the app" are very different situations and used to look identical.
UPDATE lkp_queue_statuses SET name = 'AWAITING_REVIEW', label = 'Awaiting review'
 WHERE name = 'AWAITING_SUBMIT';

INSERT INTO lkp_queue_statuses (name, label, is_terminal, sort_order) VALUES
    ('PREPARING', 'Preparing',            FALSE, 2),
    ('READY',     'Ready to apply',       FALSE, 3),
    ('FILLING',   'Filling the form',     FALSE, 4),
    ('CANCELLED', 'Cancelled',            TRUE,  9)
ON CONFLICT (name) DO UPDATE
    SET label = EXCLUDED.label,
        is_terminal = EXCLUDED.is_terminal,
        sort_order = EXCLUDED.sort_order;

-- Re-space the pre-existing ones around the new arrivals.
UPDATE lkp_queue_statuses SET sort_order = 1  WHERE name = 'QUEUED';
UPDATE lkp_queue_statuses SET sort_order = 6  WHERE name = 'PARKED_UNKNOWN';
UPDATE lkp_queue_statuses SET sort_order = 7  WHERE name = 'AWAITING_REVIEW';
UPDATE lkp_queue_statuses SET sort_order = 8  WHERE name = 'SUBMITTED';
UPDATE lkp_queue_statuses SET sort_order = 10 WHERE name = 'SKIPPED';

-- FILLED and AWAITING_REVIEW describe the same moment: the form is filled and
-- the consultant has not submitted yet. Two names for one state is how a
-- dashboard ends up with a column that is always zero, so the redundant one
-- goes. Guarded, because deleting a status any item actually holds would be a
-- silent data problem rather than a tidy-up.
DELETE FROM lkp_queue_statuses s
 WHERE s.name = 'FILLED'
   AND NOT EXISTS (SELECT 1 FROM queue_items q WHERE q.status_id = s.id);


-- ── which portals the app can actually fill ───────────────────────────
--
-- A flag rather than a hard-coded list, because the set will change: teaching
-- the app a new system should be a row update and a recipe file, never a
-- schema change or a redeploy.
ALTER TABLE lkp_portal_types
    ADD COLUMN IF NOT EXISTS is_automatable BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lkp_portal_types.is_automatable IS
    'TRUE when the desktop app has a form recipe for this system. Drives the '
    'BOT/HUMAN lane on new queue items.';


-- ── queue items ───────────────────────────────────────────────────────

ALTER TABLE queue_items
    -- BOT   the desktop app owns this item
    -- HUMAN the consultant applies through the portal
    ADD COLUMN IF NOT EXISTS channel VARCHAR(10) NOT NULL DEFAULT 'HUMAN',

    -- Preparation. `became_ready_at` is what the daily cap counts, NOT
    -- queued_at: a slot is spent when an item is genuinely available to apply
    -- to, so a failed or slow preparation never silently burns a consultant's
    -- day.
    ADD COLUMN IF NOT EXISTS prepared_at         TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS became_ready_at     TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS preparation_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS preparation_error   VARCHAR(500) DEFAULT NULL,

    -- Leasing. `leased_by` is a device identifier rather than a foreign key,
    -- because the devices table belongs to the desktop-app phase and a forward
    -- reference would make this migration depend on one that does not exist.
    ADD COLUMN IF NOT EXISTS leased_by    VARCHAR(64)  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ  DEFAULT NULL,

    -- What a parked item is waiting on. A real reference, not the reason text
    -- parsed back out: releasing items by pattern-matching a sentence is how a
    -- consultant's job ends up stranded forever.
    ADD COLUMN IF NOT EXISTS parked_question_id CHAR(36) DEFAULT NULL
        REFERENCES questions(id) ON DELETE SET NULL,

    -- Cancellation is distinct from skipping. SKIPPED is a person deciding
    -- against a job; CANCELLED is the queue being voided because the consultant
    -- left or an admin pulled it. Collapsing them would make "why did this
    -- person apply to so few jobs" unanswerable.
    ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS cancelled_by  CHAR(36) DEFAULT NULL
        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(500) DEFAULT NULL;

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS chk_queue_channel;
ALTER TABLE queue_items
    ADD CONSTRAINT chk_queue_channel CHECK (channel IN ('BOT', 'HUMAN'));

-- The desktop app's only query: my ready items, in my lane.
CREATE INDEX IF NOT EXISTS idx_queue_ready_by_channel
    ON queue_items (organization_id, consultant_id, channel, status_id);

-- The lease sweeper's query. Partial, because expired leases are rare.
CREATE INDEX IF NOT EXISTS idx_queue_expired_leases
    ON queue_items (leased_until)
    WHERE leased_until IS NOT NULL;

-- Releasing everything parked on one question must not scan the table.
CREATE INDEX IF NOT EXISTS idx_queue_parked_on_question
    ON queue_items (consultant_id, parked_question_id)
    WHERE parked_question_id IS NOT NULL;

-- The cap counter, and the sweeper looking for stale readiness.
CREATE INDEX IF NOT EXISTS idx_queue_became_ready
    ON queue_items (consultant_id, became_ready_at)
    WHERE became_ready_at IS NOT NULL;
