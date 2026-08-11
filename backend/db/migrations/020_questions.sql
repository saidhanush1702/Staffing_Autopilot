-- 020_questions.sql
-- Purpose: the organisation's question bank, and which questions are
--          outstanding for which consultant.
-- Phase: 4
--
-- A question is stored ONCE per organisation, keyed by a normalised form of
-- its text. That key is what lets the system recognise that
--   "What is your expected hourly rate?"  and
--   "Expected hourly rate:"
-- are the same question, so one approved answer serves both forms.
--
-- Normalisation is deliberately CONSERVATIVE — see config/questionNormaliser.js.
-- Two questions match only when they are textually the same question after
-- case, punctuation and whitespace are removed. No stemming, no synonyms, no
-- fuzzy distance. The failure mode that matters is reusing an answer for a
-- question that merely looked similar, which would put words in a
-- consultant's mouth on a real application; a surviving duplicate only wastes
-- a little of their time.

CREATE TABLE IF NOT EXISTS questions (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- The wording as a person would read it. Shown on every screen.
    question_text   VARCHAR(500) NOT NULL CHECK (length(btrim(question_text)) > 0),

    -- The matching key. Never shown.
    normalised_key  VARCHAR(500) NOT NULL,

    category_id     INT NOT NULL
                    REFERENCES lkp_question_categories(id) ON DELETE RESTRICT,

    -- TRUE for the standard set every consultant should answer. FALSE for a
    -- question raised at one person, which is targeted via consultant_questions.
    applies_to_all  BOOLEAN NOT NULL DEFAULT FALSE,

    -- Set when the category came from the classifier rather than a human, so
    -- the UI can invite a reviewer to confirm it.
    auto_categorised BOOLEAN NOT NULL DEFAULT FALSE,

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,

    created_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same question cannot exist twice in one organisation. This is what makes
-- the bank a bank rather than a pile.
CREATE UNIQUE INDEX IF NOT EXISTS uq_question_key_per_org
    ON questions (organization_id, normalised_key);

CREATE INDEX IF NOT EXISTS idx_questions_org_category
    ON questions (organization_id, category_id);
CREATE INDEX IF NOT EXISTS idx_questions_org_all
    ON questions (organization_id, applies_to_all) WHERE is_active;

DROP TRIGGER IF EXISTS trg_questions_updated_at ON questions;
CREATE TRIGGER trg_questions_updated_at
    BEFORE UPDATE ON questions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── questions raised at ONE consultant ────────────────────────────────
--
-- Org-wide questions (`applies_to_all`) need no row here. This table exists
-- for the case where a recruiter asks one person something specific, and to
-- record WHY it was asked — which, once Phase 5 exists, will be "an
-- application form asked it".
CREATE TABLE IF NOT EXISTS consultant_questions (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id     CHAR(36) NOT NULL REFERENCES questions(id) ON DELETE CASCADE,

    -- RECRUITER  a person asked it
    -- FORM       an application form raised it (Phase 5)
    source          VARCHAR(20) NOT NULL DEFAULT 'RECRUITER'
                    CHECK (source IN ('RECRUITER', 'FORM')),
    source_note     VARCHAR(255) DEFAULT NULL,

    created_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_question_per_consultant UNIQUE (consultant_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_cq_org_consultant
    ON consultant_questions (organization_id, consultant_id);
