-- 036_widen_provider_job_id.sql
-- Purpose: stop real Google Jobs results from failing an entire discovery run.
-- Phase: 6

-- ── WHAT WENT WRONG ──────────────────────────────────────────────────────
--
-- provider_job_id was VARCHAR(512), a number chosen before any real SerpApi
-- response had been seen. Google's `job_id` is an opaque base64-ish token with
-- no documented ceiling, and in practice it routinely runs past 512 characters.
--
-- The failure was worse than one lost posting. The insert happens inside the
-- run's transaction, so a single oversized id aborted the whole run — no
-- postings stored, no run history written, and the API credits already spent.
-- The first real run against live data hit it immediately.
--
-- TEXT rather than a bigger VARCHAR: the value is somebody else's identifier
-- and we have no basis for any limit at all. Picking 2048 would just be the
-- same guess with more room. In Postgres TEXT and VARCHAR store identically,
-- so this costs nothing.

ALTER TABLE job_postings
    ALTER COLUMN provider_job_id TYPE TEXT;

COMMENT ON COLUMN job_postings.provider_job_id IS
    'The provider''s own id for this posting (SerpApi job_id). Opaque, and of '
    'unbounded length — it is not ours to constrain.';
