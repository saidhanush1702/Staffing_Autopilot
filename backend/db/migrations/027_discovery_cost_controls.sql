-- 027_discovery_cost_controls.sql
-- Purpose: record the credits a run chose NOT to spend.
-- Phase: 5 (v2)
--
-- ── WHY ───────────────────────────────────────────────────────────────
--
-- The provider bills per request, not per result. A run therefore has two
-- numbers worth knowing, and until now only one of them was recorded:
--
--   provider_calls  what it spent
--   credits_saved   what it declined to spend
--
-- The second exists because the orchestrator now stops paginating a search term
-- the moment a page comes back with nothing new in it. That decision is
-- invisible in the spend figure — a cheap run and a run that was cut short look
-- identical — so the saving is counted explicitly. Without it, nobody can tell
-- whether the early-exit rule is earning anything, and an optimisation nobody
-- can measure is an optimisation nobody should trust.

ALTER TABLE discovery_runs
    ADD COLUMN IF NOT EXISTS credits_saved INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN discovery_runs.provider_calls IS
    'API credits spent by this run. One per result page requested.';
COMMENT ON COLUMN discovery_runs.credits_saved IS
    'Result pages this run declined to buy because the previous page for that '
    'search term contained no postings we did not already hold.';
