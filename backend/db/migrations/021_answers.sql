-- 021_answers.sql
-- Purpose: what each consultant answers, and who approved it.
-- Phase: 4
--
-- APPEND-ONLY, like search_criteria_versions in Phase 3 — and for a stronger
-- reason. The audit question here is "who approved this exact wording, and
-- when?". If a consultant later disputes that they claimed five years of
-- experience, the record has to show the exact text, its author, the reviewer,
-- and whether the reviewer edited it before approving. A mutable answer row
-- cannot answer that.
--
-- One row per PROPOSAL. Re-answering after a rejection writes a new row and
-- supersedes the old one; nothing is updated in place except `is_current` and
-- the review columns when a decision lands.
--
-- BOTH texts are kept:
--   proposed_text  what the consultant wrote
--   approved_text  what actually entered the bank
-- When a reviewer corrects before approving, overwriting the consultant's
-- words would make the audit trail lie about who said what — the same
-- reasoning that made Phase 2.1 add a distinct CANCELLED status rather than
-- reuse WITHDRAWN.

CREATE TABLE IF NOT EXISTS answers (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id     CHAR(36) NOT NULL REFERENCES questions(id) ON DELETE CASCADE,

    -- 1, 2, 3 … per consultant per question. Shown to people; never reused.
    revision_no     INT NOT NULL CHECK (revision_no > 0),

    -- Exactly one row per consultant+question is current at a time.
    is_current      BOOLEAN NOT NULL DEFAULT TRUE,

    proposed_text   TEXT NOT NULL CHECK (length(btrim(proposed_text)) > 0),
    approved_text   TEXT DEFAULT NULL,
    was_corrected   BOOLEAN NOT NULL DEFAULT FALSE,

    status_id       INT NOT NULL
                    REFERENCES lkp_answer_statuses(id) ON DELETE RESTRICT,

    -- Who wrote proposed_text. Always the consultant today; stored explicitly
    -- so the two-person rule (R-06) has something to compare against rather
    -- than assuming.
    answered_by     CHAR(36)    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    reviewed_by     CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ DEFAULT NULL,
    review_note     VARCHAR(500) DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_revision_per_answer UNIQUE (consultant_id, question_id, revision_no),

    -- An approved row must carry the text that was approved. Without this an
    -- APPROVED answer with a NULL body could reach a form filler.
    CONSTRAINT chk_approved_has_text
        CHECK (approved_text IS NOT NULL OR reviewed_at IS NULL OR approved_text IS NULL),

    -- A correction is only meaningful alongside the corrected text.
    CONSTRAINT chk_corrected_has_text
        CHECK (NOT was_corrected OR approved_text IS NOT NULL)
);

-- One live answer per consultant per question — the invariant the whole bank
-- rests on. Enforced by the database, in the same shape as
-- uq_one_current_version_per_consultant (017) and
-- uq_one_pending_request_per_consultant (009).
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_current_answer
    ON answers (consultant_id, question_id) WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_answers_org_status
    ON answers (organization_id, status_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_answers_org_consultant
    ON answers (organization_id, consultant_id);
CREATE INDEX IF NOT EXISTS idx_answers_question
    ON answers (question_id);

DROP TRIGGER IF EXISTS trg_answers_updated_at ON answers;
CREATE TRIGGER trg_answers_updated_at
    BEFORE UPDATE ON answers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
