-- 037_queue_item_blockers.sql
-- Purpose: a parked application waits on EVERY question it could not answer,
--          not just the first one.
-- Phase: 6

-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
--
-- `queue_items.parked_question_id` holds one question. A real Easy Apply form
-- asked six, and the item parked on the first of them. Approving that one
-- released the application, which retried, hit the second, and parked again —
-- six answer-and-retry rounds for a single job, each one a separate trip
-- through the queue.
--
-- Worse, each retry costs a full page load and a re-fill on the employer's own
-- form. The board sees an application opened and abandoned six times.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────
--
-- One row per (application, question it is waiting on). The item becomes ready
-- again only when NONE of its blockers is unanswered, so one answering session
-- releases it once and it is applied for on the next pass.
--
-- `parked_question_id` stays for now: it still names the question shown as the
-- park reason, and dropping a column other code reads is a separate change
-- from fixing the behaviour.

CREATE TABLE IF NOT EXISTS queue_item_blockers (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    queue_item_id   CHAR(36) NOT NULL
                    REFERENCES queue_items(id) ON DELETE CASCADE,
    question_id     CHAR(36) NOT NULL
                    REFERENCES questions(id) ON DELETE CASCADE,

    -- What the form actually said, kept verbatim. The bank normalises wording
    -- so two employers share one entry; this is the employer's own phrasing,
    -- which is what the consultant should be shown when answering.
    asked_as        VARCHAR(2000) NOT NULL,
    field_type      VARCHAR(30)  DEFAULT NULL,
    is_required     BOOLEAN      NOT NULL DEFAULT TRUE,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- One row per question per application. A form that asks the same thing
    -- twice blocks once.
    CONSTRAINT uq_blocker UNIQUE (queue_item_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_blockers_item ON queue_item_blockers (queue_item_id);
CREATE INDEX IF NOT EXISTS idx_blockers_question ON queue_item_blockers (question_id);

COMMENT ON TABLE queue_item_blockers IS
    'Every unanswered question standing between an application and being sent. '
    'The item is released only when all of them have an answer.';
