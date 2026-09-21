-- 052_tailoring_on_request.sql
--
-- Resume tailoring is now something a person asks for, per job, rather than
-- something that happens to every job. A job that has not been asked for goes
-- straight to READY carrying the consultant's base resume, and says why:
-- NOT_REQUESTED. That is not a failure reason — nothing went wrong — but it
-- lives in the same column so one badge explains "why is this not tailored"
-- for every cause, including this one.

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS chk_queue_tailoring_reason;
ALTER TABLE queue_items
    ADD CONSTRAINT chk_queue_tailoring_reason CHECK (
        tailoring_skip_reason IS NULL OR tailoring_skip_reason IN (
            'NO_BASE_RESUME',
            'BUDGET_EXHAUSTED',
            'UNPARSEABLE_RESUME',
            'LLM_NOT_CONFIGURED',
            'AI_FAILED',
            'REVIEW_REJECTED',
            'REVIEW_EXPIRED',
            'PROFILE_INCOMPLETE',
            'NOT_REQUESTED'           -- new: nobody asked for this job to be tailored
        )
    );
