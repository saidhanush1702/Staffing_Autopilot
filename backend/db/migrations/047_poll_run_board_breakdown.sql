-- 047_poll_run_board_breakdown.sql
-- Purpose: per-poll, per-board counts — "this run returned 18 from linkedin,
--          7 from indeed" — so a run's yield can be read board by board.
-- Phase: 5c
--
-- ── WHY ON THE RUN AND NOT DERIVED FROM POSTINGS ──────────────────────
--
-- A posting cannot be traced back to the poll that fetched it: JobsPipe
-- sightings carry run_id = NULL by design (so the webhook and poller never
-- race the scheduler's one-open-run constraint), and a job already in the pool
-- is only a repeat sighting, not a new row. So the breakdown is counted while
-- the poll runs, from every job the response returned — including duplicates
-- and unusable rows, which a postings query would never see.
--
-- Shape, keyed by board (`sources[0].provider`; "unknown" when absent):
--   { "linkedin": { "returned": 18, "new": 12, "duplicates": 6,
--                   "unusable": 0, "matched": 3, "queued": 3 }, … }
--
-- NULL on polls recorded before this migration.

ALTER TABLE jobspipe_poll_runs
    ADD COLUMN IF NOT EXISTS board_breakdown JSONB DEFAULT NULL;

COMMENT ON COLUMN jobspipe_poll_runs.board_breakdown IS
    'Per-board counts for this poll: { board: { returned, new, duplicates, '
    'unusable, matched, queued } }. NULL for polls before migration 047.';
