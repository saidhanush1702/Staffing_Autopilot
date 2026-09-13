-- 046_posting_origin_board.sql
-- Purpose: remember WHICH BOARD a posting was actually on, not just which of
--          our ingestion doors delivered it.
-- Phase: 5c
--
-- ── THE GAP THIS CLOSES ───────────────────────────────────────────────
--
-- SerpApi and JobsPipe answer "where did this job come from?" very differently,
-- and only one of them could answer it at all.
--
--   SerpApi    every board is its own row in lkp_job_sources — Built In,
--              CrunchBoard, LinkedIn, ZipRecruiter — and first_source_id points
--              at the specific one. So the discovery screen can count postings
--              per board, and does.
--   JobsPipe   ONE source row for the whole feed. A LinkedIn job, a Greenhouse
--              job and an Indeed job all record first_source_id = JOBSPIPE.
--
-- That single row is deliberate and must stay: it is what makes a job pushed by
-- the webhook and the same job polled by the search API collapse onto ONE
-- fingerprint instead of becoming two postings a consultant applies to twice
-- (R-15). Splitting JobsPipe into nine source rows would break that.
--
-- So the board becomes a property of the POSTING rather than a second source
-- row. `first_source_id` keeps answering "which door", `origin_board` answers
-- "which board" — and neither has to lie to accommodate the other.
--
-- ── WHY THIS IS NOT COSMETIC ──────────────────────────────────────────
--
-- The board is the single biggest predictor of freshness measured so far:
-- a Greenhouse posting reached us 6 MINUTES after publication, an Indeed relay
-- took 7.7 HOURS and carried a date accurate only to the day. Deciding which
-- sources to filter to — the entire point of the trial — needs this counted
-- over real traffic, not inferred from one sample.
--
-- The adapter already parses it (connectors/jobspipeSearch.js reads
-- `sources[0].provider`); it was simply thrown away after being written into a
-- queue transition's free text. Postings that matched nobody kept no record of
-- it at all, which is most of them.

ALTER TABLE job_postings
    ADD COLUMN IF NOT EXISTS origin_board VARCHAR(60) DEFAULT NULL;

COMMENT ON COLUMN job_postings.origin_board IS
    'The board this posting was actually listed on (greenhouse, lever, ashby, '
    'workable, smartrecruiters, workday, paylocity, linkedin, indeed …), as '
    'reported by the aggregator that delivered it. NULL for SerpApi postings, '
    'where first_source_id already names the board, and for anything ingested '
    'before migration 046.';

-- The count the discovery screen runs: postings per board for one agency.
-- Partial, because the column is NULL for every SerpApi row and those are
-- already counted by first_source_id.
CREATE INDEX IF NOT EXISTS idx_postings_origin_board
    ON job_postings (organization_id, origin_board)
    WHERE origin_board IS NOT NULL;


/* ── backfill what can still be recovered ─────────────────────────────── */
--
-- The board was being written into `queue_item_transitions.reason` as free
-- text — "Polled from JobsPipe (via linkedin) — score 92, BOT lane". That is
-- the only surviving record, so it is worth mining before it stops being the
-- only one.
--
-- It recovers ONLY postings that reached a queue. A posting that suited nobody
-- never produced a transition row and its board is gone for good — which is
-- most of the existing rows, and precisely why the column has to exist.
UPDATE job_postings p
   SET origin_board = m.board
  FROM (
        SELECT q.posting_id,
               lower((regexp_match(t.reason, '\(via ([A-Za-z0-9_-]+)\)'))[1]) AS board
          FROM queue_item_transitions t
          JOIN queue_items q ON q.id = t.queue_item_id
         WHERE t.reason ILIKE '%JobsPipe%'
           AND t.reason ~ '\(via [A-Za-z0-9_-]+\)'
       ) m
 WHERE p.id = m.posting_id
   AND p.origin_board IS NULL
   -- Never let the synthetic "Send test delivery" traffic pollute a board
   -- count the trial's conclusions are drawn from.
   AND m.board <> 'jobspipe-test';
