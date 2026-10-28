-- 060_matcher_v2.sql
-- Purpose: the switches matching v2 needs (see Implementation_plans/JOB_MATCHING_V2.md).
--
-- ── WHY A PER-ORGANISATION VERSION ───────────────────────────────────────
--
-- v2 changes who receives which job. Switching every tenant at once would be a
-- surprise nobody asked for, so each organisation says which matcher it runs:
--
--   1  the original: title words, a hard location gate, one pass mark of 70
--   2  skills coverage, role families, a soft location rule, three outcomes
--
-- Default 1. An organisation is moved to 2 deliberately, after comparing the
-- two on its own postings (backend/scripts/matcher-compare.mjs).
--
-- ── OPEN TO RELOCATE ─────────────────────────────────────────────────────
--
-- Stored on the criteria VERSION rather than on a location row, because it is
-- a statement about the person ("I would move for the right job"), not about
-- one of the places they listed. Versions stay append-only, so what a consultant
-- was willing to do when a job was linked stays answerable.

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS matcher_version SMALLINT NOT NULL DEFAULT 1
    CHECK (matcher_version IN (1, 2));

ALTER TABLE search_criteria_versions
    ADD COLUMN IF NOT EXISTS open_to_relocate BOOLEAN NOT NULL DEFAULT FALSE;


-- ── THE MIDDLE OUTCOME ───────────────────────────────────────────────────
--
-- v2 has three outcomes, not two. A job that is a plausible fit but not a
-- certain one is stored as SUGGESTED — a match with NO queue item — until a
-- recruiter either links it (QUEUED, through the same door a manual link uses)
-- or says it is not a fit (NOT_A_FIT). Keeping the row either way means the same
-- job is never suggested to the same consultant twice.
ALTER TABLE job_matches DROP CONSTRAINT IF EXISTS job_matches_status_check;
ALTER TABLE job_matches
    ADD CONSTRAINT job_matches_status_check
    CHECK (status IN ('PENDING', 'QUEUED', 'DISCARDED', 'SUGGESTED', 'NOT_A_FIT'));

CREATE INDEX IF NOT EXISTS idx_matches_suggested
    ON job_matches (organization_id, score DESC)
    WHERE status = 'SUGGESTED';
