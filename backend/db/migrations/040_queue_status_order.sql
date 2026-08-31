-- 040_queue_status_order.sql
-- Purpose: state the queue's display order in full, once, rather than nudging
--          it relative to whatever it happened to be.
-- Phase: 7
--
-- ── WHAT WENT WRONG ──────────────────────────────────────────────────────
--
-- Migration 039 inserted RESUME_REVIEW at sort_order 3 and pushed READY and
-- FILLING to 4 and 5 — correct against the numbering migration 029 left behind.
-- But the live numbering had moved on since: PARKED_UNKNOWN was already sitting
-- at 5. So FILLING and PARKED_UNKNOWN collided, and a dashboard ordering by
-- sort_order showed "filling the form" and "parked" in whichever order the
-- planner happened to return them.
--
-- ── WHY THIS FIXES IT THE WAY IT DOES ────────────────────────────────────
--
-- The bug is not the two numbers. It is that both 029 and 039 wrote RELATIVE
-- adjustments — "push these two along" — which are only correct against the
-- state the author had in front of them. The third such migration would have
-- collided too.
--
-- So this one is absolute. It names every status and its position, so running
-- it against any prior state produces the same result, and the pipeline order
-- is readable in one place instead of reconstructed from three migrations.

UPDATE lkp_queue_statuses s
   SET sort_order = v.ord
  FROM (VALUES
        ('QUEUED',           1),   -- matched, waiting to be prepared
        ('PREPARING',        2),   -- the AI stage has it
        ('RESUME_REVIEW',    3),   -- tailored, but a claim was flagged
        ('READY',            4),   -- ready for the desktop app or the consultant
        ('FILLING',          5),   -- the app is filling the form
        ('PARKED_UNKNOWN',   6),   -- stopped on a question nobody has answered
        ('AWAITING_REVIEW',  7),   -- filled, waiting for the consultant to send
        ('SUBMITTED',        8),   -- terminal: it reached the employer
        ('CANCELLED',        9),   -- terminal: the queue was pulled
        ('SKIPPED',         10)    -- terminal: declined, but re-queueable
       ) AS v(name, ord)
 WHERE s.name = v.name
   AND s.sort_order IS DISTINCT FROM v.ord;

-- A duplicate here means a status was added without a place in the list above.
-- Better to fail the migration than to ship a dashboard whose column order is
-- decided by the query planner.
DO $$
DECLARE dupes INT;
BEGIN
    SELECT COUNT(*) INTO dupes FROM (
        SELECT sort_order FROM lkp_queue_statuses
         GROUP BY sort_order HAVING COUNT(*) > 1
    ) d;
    IF dupes > 0 THEN
        RAISE EXCEPTION
            'Two queue statuses share a sort_order. Add the new status to '
            'migration 040''s list rather than nudging its neighbours.';
    END IF;
END $$;
