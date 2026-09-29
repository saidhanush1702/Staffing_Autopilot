-- 032_retire_held_matches.sql
-- Purpose: retire the HELD match state, which the cap-at-ready change made dead.
-- Phase: 6
--
-- ── WHY IT IS DEAD ────────────────────────────────────────────────────
--
-- HELD meant "matched, but the consultant's daily cap was full when the queue
-- was filled". That made sense while the cap gated queue-item CREATION.
--
-- The cap now gates promotion to READY instead, so every match becomes a queue
-- item and the surplus waits at QUEUED. Nothing writes HELD any more, and rows
-- left in it are invisible to the new flow: they are not PENDING, so they are
-- never picked up, and they have no queue item, so they never appear anywhere.
-- They are stranded.
--
-- Returning them to PENDING puts them back in front of the engine, which will
-- create the queue items the old flow never got to.

UPDATE job_matches SET status = 'PENDING' WHERE status = 'HELD';

ALTER TABLE job_matches DROP CONSTRAINT IF EXISTS job_matches_status_check;
ALTER TABLE job_matches
    ADD CONSTRAINT job_matches_status_check
    CHECK (status IN ('PENDING', 'QUEUED', 'DISCARDED'));

-- The partial index named the dead state too, so it no longer covers the rows
-- the engine actually reads.
DROP INDEX IF EXISTS idx_matches_pending;
CREATE INDEX IF NOT EXISTS idx_matches_pending
    ON job_matches (organization_id, consultant_id, status, score DESC)
    WHERE status = 'PENDING';

-- ── the counter changed meaning, so it changed name ───────────────────
--
-- `held_by_cap` counted matches the cap refused to queue. The same number now
-- counts QUEUED items the cap has not yet promoted — related, but not the same
-- measurement. Leaving the old name would make run history compare two
-- different quantities under one heading, which is worse than either.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'discovery_runs' AND column_name = 'held_by_cap') THEN
        ALTER TABLE discovery_runs RENAME COLUMN held_by_cap TO awaiting_cap;
    END IF;
END $$;

COMMENT ON COLUMN discovery_runs.awaiting_cap IS
    'Queue items left at QUEUED because the consultant''s daily cap was already '
    'spent. They are reconsidered on the next promotion pass, not discarded.';
