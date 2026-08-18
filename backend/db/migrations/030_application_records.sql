-- 030_application_records.sql
-- Purpose: the permanent record of what was actually sent to an employer.
-- Phase: 6
--
-- ── WHY THIS TABLE IS DIFFERENT FROM EVERY OTHER ──────────────────────
--
-- An application record is a statement about what went to a real employer in a
-- real person's name. It is evidence. So it gets the same treatment as
-- `audit_logs` and for the same reason: a trigger that refuses the operation,
-- AND a privilege revoke so the account the application runs as cannot do it
-- even through a successful injection. Two independent mechanisms, because one
-- of them being bypassed should not be enough.
--
-- Nobody deletes an application record. Not a recruiter, not an owner, not a
-- super admin, not through direct SQL as the app user.

-- ── vocabulary ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lkp_application_statuses (
    id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name     VARCHAR(30) NOT NULL UNIQUE,
    label    VARCHAR(80) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
);

-- HOW an application was made, which is a different question from WHETHER it
-- succeeded. The distinction matters because these carry different amounts of
-- trust: the first two were witnessed by software, the third is a person's own
-- account of something that happened elsewhere. Reporting that cannot tell
-- them apart is reporting that overstates what it knows.
CREATE TABLE IF NOT EXISTS lkp_submission_methods (
    id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name     VARCHAR(30) NOT NULL UNIQUE,
    label    VARCHAR(80) NOT NULL,
    -- TRUE when software observed the submission rather than being told of it.
    is_witnessed BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0
);


-- ── the record ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS application_records (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    posting_id      CHAR(36) NOT NULL REFERENCES job_postings(id) ON DELETE RESTRICT,

    -- The queue item this came from. Nullable because an application can be
    -- recorded for a job that was never queued — a consultant applying to
    -- something they found themselves is still an application.
    queue_item_id   CHAR(36) DEFAULT NULL
                    REFERENCES queue_items(id) ON DELETE SET NULL,

    status_id       INT NOT NULL REFERENCES lkp_application_statuses(id) ON DELETE RESTRICT,
    submission_method_id INT NOT NULL
                    REFERENCES lkp_submission_methods(id) ON DELETE RESTRICT,

    -- R-10 / R-11: the EXACT file that was sent, and who saw it happen.
    resume_artifact_id CHAR(36) DEFAULT NULL
                    REFERENCES resume_artifacts(id) ON DELETE RESTRICT,

    -- Denormalised snapshots. History must survive a company being renamed or
    -- a posting being re-titled, the same reasoning as performed_by_name in
    -- audit_logs.
    company         VARCHAR(255) NOT NULL,
    job_title       VARCHAR(255) NOT NULL,
    job_url         VARCHAR(1000) DEFAULT NULL,
    portal_label    VARCHAR(80)  DEFAULT NULL,

    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Which machine reported it, when software witnessed it. Text rather than a
    -- foreign key for the same reason as queue_items.leased_by.
    device_id       VARCHAR(64) DEFAULT NULL,
    -- Who keyed it in, for the self-reported and staff-recorded methods.
    recorded_by     CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,

    notes           VARCHAR(1000) DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One application per queue item, ever. This is also the idempotency key:
    -- a desktop app retrying a report after a dropped connection cannot create
    -- a second record.
    CONSTRAINT uq_application_per_queue_item UNIQUE (queue_item_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_consultant
    ON application_records (organization_id, consultant_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_posting
    ON application_records (posting_id);


-- ── the exact questions and answers ───────────────────────────────────
--
-- `question_text` is stored as the FORM worded it, not as a link to the
-- question bank. That looks like duplication and is deliberate: the bank is
-- editable, but this is a statement about what a specific employer asked on a
-- specific day. A foreign key alone would silently rewrite history the moment
-- someone reworded the canonical question. The link is kept alongside, for
-- analytics only.
CREATE TABLE IF NOT EXISTS application_qa (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    application_id  CHAR(36) NOT NULL
                    REFERENCES application_records(id) ON DELETE CASCADE,

    position        INT NOT NULL,
    question_text   TEXT NOT NULL,
    answer_text     TEXT DEFAULT NULL,
    field_type      VARCHAR(30) DEFAULT NULL,

    question_id     CHAR(36) DEFAULT NULL REFERENCES questions(id) ON DELETE SET NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_application_qa_position UNIQUE (application_id, position)
);

CREATE INDEX IF NOT EXISTS idx_application_qa_app
    ON application_qa (application_id, position);


-- ── append-only, enforced twice ───────────────────────────────────────

CREATE OR REPLACE FUNCTION application_records_immutable() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'application_records is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_application_records_immutable ON application_records;
CREATE TRIGGER trg_application_records_immutable
    BEFORE UPDATE OR DELETE ON application_records
    FOR EACH ROW EXECUTE FUNCTION application_records_immutable();

CREATE OR REPLACE FUNCTION application_qa_immutable() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'application_qa is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_application_qa_immutable ON application_qa;
CREATE TRIGGER trg_application_qa_immutable
    BEFORE UPDATE OR DELETE ON application_qa
    FOR EACH ROW EXECUTE FUNCTION application_qa_immutable();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON application_records FROM app_role';
        EXECUTE 'GRANT  INSERT, SELECT                ON application_records TO   app_role';
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON application_qa      FROM app_role';
        EXECUTE 'GRANT  INSERT, SELECT                ON application_qa      TO   app_role';
    END IF;
END $$;
