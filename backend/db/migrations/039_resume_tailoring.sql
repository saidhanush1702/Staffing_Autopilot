-- 039_resume_tailoring.sql
-- Purpose: the AI preparation stage — the tailored resume, what it cost, and
--          every claim in it that could not be traced back to the original.
-- Phase: 7
--
-- ── WHERE THIS SITS ──────────────────────────────────────────────────────
--
-- Between QUEUED and READY, in the seam discoveryController.promoteToReady()
-- has been holding open since Phase 5. Nothing before this migration ever
-- attached anything to a queue item; `tailored_resume_artifact_id` has existed
-- and been NULL since migration 024.
--
-- ── THE RULE THIS SCHEMA EXISTS TO ENFORCE ───────────────────────────────
--
-- Tailoring may REPHRASE and REORDER what is already true. It may never invent
-- a skill, a tool, an employer, a date or a number. That rule is worth nothing
-- unless a failure of it is visible afterwards, which is what
-- resume_fabrication_flags is for: not a pass/fail bit, but the specific claim,
-- where it appeared, and who decided what to do about it.

/* ── the parsed base resume, cached ──────────────────────────────────── */
--
-- Parsing a resume into sections costs a model call. Doing it per JOB would
-- mean a consultant matched to forty postings pays for forty identical parses
-- of one unchanged document.
--
-- Keyed on the file's sha256 rather than on the artifact id, because that is
-- what actually identifies the content: re-uploading the same file, or two
-- consultants somehow sharing one, resolves to the work already done.
CREATE TABLE IF NOT EXISTS resume_documents (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    artifact_id     CHAR(36) NOT NULL
                    REFERENCES resume_artifacts(id) ON DELETE CASCADE,

    -- The cache key. Unique per organisation rather than globally: two agencies
    -- sharing an installation must not share document contents.
    sha256          CHAR(64) NOT NULL,

    -- The structured resume, in the shape config/resumeSchema.js declares.
    sections        JSONB NOT NULL,
    -- The plain text it was parsed from. Kept because the fabrication check
    -- compares TEXT, not structure — a claim invented inside a bullet is
    -- invisible to a field-by-field comparison.
    raw_text        TEXT NOT NULL,

    -- Bumped when the schema or the extraction changes, so a stale parse can be
    -- found and redone rather than silently trusted forever.
    parser_version  INT NOT NULL DEFAULT 1,
    -- Which provider and model produced it. The provider is not yet decided,
    -- and "this was parsed by something we no longer use" is a real question.
    provider        VARCHAR(40)  DEFAULT NULL,
    model           VARCHAR(120) DEFAULT NULL,

    parsed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_resume_document_sha UNIQUE (organization_id, sha256, parser_version)
);

CREATE INDEX IF NOT EXISTS idx_resume_documents_artifact
    ON resume_documents (artifact_id);


/* ── what a tailored artifact knows about itself ─────────────────────── */

ALTER TABLE resume_artifacts
    -- The base resume this was generated from. RESTRICT, not CASCADE: deleting
    -- a base resume that a sent application's tailored copy descends from would
    -- quietly break the audit chain behind a real submission.
    ADD COLUMN IF NOT EXISTS source_artifact_id CHAR(36) DEFAULT NULL
        REFERENCES resume_artifacts(id) ON DELETE RESTRICT,

    -- The job it was written for. Nullable because base resumes have no job.
    ADD COLUMN IF NOT EXISTS queue_item_id CHAR(36) DEFAULT NULL,

    ADD COLUMN IF NOT EXISTS provider VARCHAR(40)  DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS model    VARCHAR(120) DEFAULT NULL,

    -- Keyword coverage against the job description, before and after. Computed
    -- in code, never asked of the model — a model asked to grade its own output
    -- reports a good number. Storing both is what makes the improvement
    -- provable rather than asserted.
    ADD COLUMN IF NOT EXISTS ats_score_before INT DEFAULT NULL
        CHECK (ats_score_before IS NULL OR ats_score_before BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS ats_score_after  INT DEFAULT NULL
        CHECK (ats_score_after  IS NULL OR ats_score_after  BETWEEN 0 AND 100),

    ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_resume_artifacts_queue_item
    ON resume_artifacts (queue_item_id) WHERE queue_item_id IS NOT NULL;


/* ── the cost ledger and the audit trail ─────────────────────────────── */
--
-- One row per ATTEMPT, not per queue item. A job that failed twice and
-- succeeded on the third try cost three calls, and a ledger that records only
-- the successful one understates the bill by two thirds.
--
-- This table is also what the monthly budget is enforced against, which is why
-- cost_usd is nullable rather than defaulted to zero: a model whose price we do
-- not know must read as "unknown", not as "free". A budget that treats the
-- first as the second never fires.
CREATE TABLE IF NOT EXISTS resume_tailoring_runs (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    queue_item_id   CHAR(36) DEFAULT NULL
                    REFERENCES queue_items(id) ON DELETE SET NULL,
    consultant_id   CHAR(36) DEFAULT NULL
                    REFERENCES users(id) ON DELETE SET NULL,

    -- 'parse' | 'tailor' | 'check' — every paid stage, so the ledger can answer
    -- "what did the checking half cost us" separately from the tailoring half.
    stage           VARCHAR(20) NOT NULL,
    attempt         INT NOT NULL DEFAULT 1,

    provider        VARCHAR(40)  DEFAULT NULL,
    model           VARCHAR(120) DEFAULT NULL,
    -- The version of the locked rule set. A change in output quality has to be
    -- attributable to a change in the prompt, or nobody can tune it.
    prompt_version  VARCHAR(40)  DEFAULT NULL,

    input_tokens       INT DEFAULT NULL,
    output_tokens      INT DEFAULT NULL,
    cache_read_tokens  INT DEFAULT NULL,
    cache_write_tokens INT DEFAULT NULL,

    cost_usd        NUMERIC(12,6) DEFAULT NULL,

    verdict         VARCHAR(12) NOT NULL DEFAULT 'FAILED'
                    CHECK (verdict IN ('CLEAN','FLAGGED','FAILED','SKIPPED')),

    duration_ms     INT DEFAULT NULL,
    error           VARCHAR(2000) DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The budget query: spend for one organisation since a date.
CREATE INDEX IF NOT EXISTS idx_tailoring_runs_org_time
    ON resume_tailoring_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tailoring_runs_item
    ON resume_tailoring_runs (queue_item_id, created_at DESC);


/* ── every claim that could not be traced to the original ────────────── */
--
-- Deliberately one row per CLAIM rather than a flag on the artifact. "This
-- resume was flagged" tells a reviewer nothing they can act on; "the bullet
-- claiming a 40% latency reduction does not appear in the base resume" tells
-- them exactly what to look at and lets them decide on it individually.
CREATE TABLE IF NOT EXISTS resume_fabrication_flags (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    tailoring_run_id CHAR(36) DEFAULT NULL
                    REFERENCES resume_tailoring_runs(id) ON DELETE SET NULL,
    queue_item_id   CHAR(36) NOT NULL
                    REFERENCES queue_items(id) ON DELETE CASCADE,
    tailored_artifact_id CHAR(36) DEFAULT NULL
                    REFERENCES resume_artifacts(id) ON DELETE SET NULL,

    claim_text      VARCHAR(2000) NOT NULL,
    section         VARCHAR(80)  DEFAULT NULL,

    severity        VARCHAR(10) NOT NULL DEFAULT 'MEDIUM'
                    CHECK (severity IN ('HIGH','MEDIUM','LOW')),

    -- RULE      caught deterministically in code, before any model ran.
    -- MODEL     caught by the independent second-pass model.
    -- STRUCTURE caught by comparing the two structures — an invented employer,
    --           a promoted job title, a degree that was not there.
    --
    -- Worth distinguishing: a RULE or STRUCTURE flag is a fact, and a MODEL
    -- flag is an opinion. A reviewer reads them differently, and so should any
    -- report on how often the model is right.
    detected_by     VARCHAR(12) NOT NULL DEFAULT 'MODEL'
                    CHECK (detected_by IN ('RULE','MODEL','STRUCTURE')),

    reason          VARCHAR(1000) DEFAULT NULL,

    reviewer_verdict VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                    CHECK (reviewer_verdict IN ('PENDING','ACCEPTED','REJECTED')),
    reviewed_by     CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMPTZ DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fabrication_flags_item
    ON resume_fabrication_flags (queue_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fabrication_flags_open
    ON resume_fabrication_flags (organization_id)
    WHERE reviewer_verdict = 'PENDING';


/* ── the marker on the queue item ────────────────────────────────────── */
--
-- ── WHY THIS COLUMN EXISTS ───────────────────────────────────────────────
--
-- Tailoring can legitimately not happen, and the application still goes out.
-- The consultant has no base resume on file; the file is a legacy .doc nothing
-- can read; the organisation's monthly AI budget is spent; the provider is
-- down. In every one of those cases the right answer is the same — send the
-- application with the base resume rather than hold it — and the wrong answer
-- is to do that silently.
--
-- So the outcome is recorded on the item itself. One column answers "did this
-- application go out with a tailored resume, and if not, why not?" on every
-- screen that shows a job: the management queue, the consultant portal, and the
-- desktop app.
ALTER TABLE queue_items
    ADD COLUMN IF NOT EXISTS tailoring_state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS tailoring_skip_reason VARCHAR(40) DEFAULT NULL;

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS chk_queue_tailoring_state;
ALTER TABLE queue_items
    ADD CONSTRAINT chk_queue_tailoring_state CHECK (
        tailoring_state IN ('PENDING','TAILORED','NOT_TAILORED','FLAGGED')
    );

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS chk_queue_tailoring_reason;
ALTER TABLE queue_items
    ADD CONSTRAINT chk_queue_tailoring_reason CHECK (
        tailoring_skip_reason IS NULL OR tailoring_skip_reason IN (
            'NO_BASE_RESUME',        -- nothing on file to tailor
            'BUDGET_EXHAUSTED',      -- the month's AI budget is spent
            'UNPARSEABLE_RESUME',    -- legacy .doc, a scan, or a corrupt file
            'LLM_NOT_CONFIGURED',    -- no provider chosen yet
            'AI_FAILED',             -- the provider failed every attempt
            'REVIEW_REJECTED',       -- a reviewer chose the base resume
            'REVIEW_EXPIRED'         -- nobody reviewed it in time
        )
    );

-- The queue item this artifact belongs to. Added after queue_items is altered
-- so the two tables can reference each other; both sides are nullable, so the
-- cycle never blocks an insert.
ALTER TABLE resume_artifacts DROP CONSTRAINT IF EXISTS fk_resume_artifact_queue_item;
ALTER TABLE resume_artifacts
    ADD CONSTRAINT fk_resume_artifact_queue_item
        FOREIGN KEY (queue_item_id) REFERENCES queue_items(id) ON DELETE SET NULL;

-- "What is waiting on a human" and "what went out untailored", both cheap.
CREATE INDEX IF NOT EXISTS idx_queue_tailoring_state
    ON queue_items (organization_id, tailoring_state);


/* ── the review state ────────────────────────────────────────────────── */
--
-- A flagged resume is not READY and is not failed. It is waiting on a person,
-- which is a state the queue did not previously have.
--
-- Slotted at 3, between PREPARING and READY, with the later states pushed
-- along. Migration 029 already re-spaced this list once, so the precedent for
-- renumbering rather than appending is set: sort_order is what every dashboard
-- orders its columns by, and appending would put "needs review" after
-- "submitted".
INSERT INTO lkp_queue_statuses (name, label, is_terminal, sort_order) VALUES
    ('RESUME_REVIEW', 'Resume needs review', FALSE, 3)
ON CONFLICT (name) DO UPDATE
    SET label = EXCLUDED.label,
        is_terminal = EXCLUDED.is_terminal,
        sort_order = EXCLUDED.sort_order;

UPDATE lkp_queue_statuses SET sort_order = 4 WHERE name = 'READY';
UPDATE lkp_queue_statuses SET sort_order = 5 WHERE name = 'FILLING';

COMMENT ON COLUMN queue_items.tailoring_state IS
    'Whether this job went out with a tailored resume. NOT_TAILORED is a normal '
    'outcome, not a failure — the application still goes out, carrying the base '
    'resume, and tailoring_skip_reason says why.';
