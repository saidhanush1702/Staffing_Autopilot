-- 049_consultant_profile_details.sql
-- Purpose: the consultant's full career record, held as STRUCTURED DATA rather
--          than as a PDF nobody can query.
-- Phase: 8
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────
--
-- Until now the only description of a consultant's career was the file they
-- uploaded. That file is opaque: it cannot be searched, it cannot be validated,
-- it breaks when it is a scan or a legacy .doc, and every resume generated from
-- it inherits whatever layout the consultant happened to use.
--
-- Holding the same facts as rows changes four things:
--
--   1. A resume can be BUILT rather than rewritten, into a template chosen for
--      how well applicant tracking systems read it.
--   2. The no-fabrication check gets much stronger. "Is this claim in the
--      original?" becomes a lookup against a field instead of a fuzzy search
--      through extracted text.
--   3. Nothing is unparseable any more. A consultant with a scanned PDF is no
--      longer a consultant we cannot tailor for.
--   4. Skills become searchable, which is what lets matching improve later.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
--
-- It does not retire the uploaded resume. Which source is used is an
-- ORGANISATION'S CHOICE (organizations.resume_source below): an agency already
-- happy with base-resume tailoring keeps it, and nothing about their pipeline
-- changes. New agencies can start from the profile instead.

/* ── the scalar additions ────────────────────────────────────────────── */
--
-- Name, email and phone are deliberately NOT here. They already live on
-- `users` and `consultant_profiles.phone`, and a second copy would drift from
-- the first the moment somebody edited one of them.
ALTER TABLE consultant_profiles
    ADD COLUMN IF NOT EXISTS github_url       VARCHAR(255) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS portfolio_url    VARCHAR(255) DEFAULT NULL,
    -- LeetCode, HackerRank, Codeforces, Kaggle. One column rather than one per
    -- site, because the list of sites will change and a schema should not.
    ADD COLUMN IF NOT EXISTS coding_profile_url VARCHAR(255) DEFAULT NULL,
    -- Free text the consultant writes about themselves. The tailoring step may
    -- reword it per job; it may never invent one that was not written.
    ADD COLUMN IF NOT EXISTS headline         VARCHAR(255) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS summary          TEXT DEFAULT NULL,
    -- Stamped when the consultant confirms their profile is finished. Used for
    -- the badge, never to block anything.
    ADD COLUMN IF NOT EXISTS profile_completed_at TIMESTAMPTZ DEFAULT NULL;


/* ── the skills taxonomy ─────────────────────────────────────────────── */
--
-- A shared vocabulary, so "React", "ReactJS" and "React.js" are one thing
-- rather than three. Without it, matching on skills is matching on typos.
--
-- Seeded with a curated list so the search box works on day one, and it GROWS
-- ON ITS OWN: skills seen repeatedly in real job postings are promoted in, so
-- the vocabulary tracks what employers are actually asking for instead of what
-- somebody remembered to type into a seed file two years ago.
CREATE TABLE IF NOT EXISTS lkp_skills (
    id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- The display spelling. "PostgreSQL", not "postgresql".
    name        VARCHAR(120) NOT NULL,
    -- The match key: lowercased and stripped. This is what makes React/ReactJS
    -- collapse, and it is what every lookup goes through.
    slug        VARCHAR(120) NOT NULL UNIQUE,

    category    VARCHAR(60) DEFAULT NULL,

    -- SEED     shipped with the product
    -- LEARNED  promoted in after appearing in enough real postings
    -- CUSTOM   typed by a consultant and kept
    origin      VARCHAR(10) NOT NULL DEFAULT 'SEED'
                CHECK (origin IN ('SEED','LEARNED','CUSTOM')),

    -- How many postings this has been seen in. Orders the autocomplete, so the
    -- suggestions a consultant sees are the ones employers actually ask for.
    posting_hits INT NOT NULL DEFAULT 0,

    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_skills_search
    ON lkp_skills (slug varchar_pattern_ops) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_skills_rank
    ON lkp_skills (posting_hits DESC) WHERE is_active;


/* ── aliases ─────────────────────────────────────────────────────────── */
--
-- "JS" is JavaScript. "K8s" is Kubernetes. "GCP" is Google Cloud Platform.
-- A consultant typing the short form should find the canonical skill, and a
-- posting using it should count toward the same term.
CREATE TABLE IF NOT EXISTS lkp_skill_aliases (
    id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skill_id  INT NOT NULL REFERENCES lkp_skills(id) ON DELETE CASCADE,
    alias     VARCHAR(120) NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_skill_aliases_skill ON lkp_skill_aliases (skill_id);


/* ── what a consultant claims ────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS consultant_skills (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id        INT NOT NULL REFERENCES lkp_skills(id) ON DELETE CASCADE,

    -- Optional. A resume that says "3 years" where the consultant said nothing
    -- is a fabrication, so these stay null unless the consultant fills them in.
    years           NUMERIC(4,1) DEFAULT NULL CHECK (years IS NULL OR years >= 0),
    proficiency     VARCHAR(20) DEFAULT NULL
                    CHECK (proficiency IS NULL OR proficiency IN
                          ('BEGINNER','INTERMEDIATE','ADVANCED','EXPERT')),

    -- Tailoring may REORDER skills to match a job. It may not add one. This is
    -- the consultant's own ordering, which is the default the reordering
    -- starts from.
    position        INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_consultant_skill UNIQUE (consultant_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_consultant_skills
    ON consultant_skills (consultant_id, position);


/* ── education ───────────────────────────────────────────────────────── */
--
-- One flexible shape covering school and university, because the bench spans
-- markets that record education differently. An Indian application wants 10th,
-- 12th and the degree, each with a board and a percentage; a US one wants the
-- degree and a GPA.
--
-- `score` is TEXT rather than a number on purpose: "8.7 CGPA", "76.4%" and
-- "3.8/4.0" are all real answers, and forcing them into one numeric column
-- means choosing which markets get to be wrong.
CREATE TABLE IF NOT EXISTS consultant_education (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- SECONDARY (10th) · SENIOR_SECONDARY (12th) · DIPLOMA
    -- BACHELORS · MASTERS · DOCTORATE · OTHER
    level           VARCHAR(20) NOT NULL DEFAULT 'BACHELORS'
                    CHECK (level IN ('SECONDARY','SENIOR_SECONDARY','DIPLOMA',
                                     'BACHELORS','MASTERS','DOCTORATE','OTHER')),

    institution     VARCHAR(255) NOT NULL CHECK (length(btrim(institution)) > 0),
    -- The awarding body where it differs from the institution — a university,
    -- or CBSE/ICSE/a state board.
    board           VARCHAR(255) DEFAULT NULL,
    degree          VARCHAR(255) DEFAULT NULL,
    field_of_study  VARCHAR(255) DEFAULT NULL,
    location        VARCHAR(255) DEFAULT NULL,

    start_year      INT DEFAULT NULL CHECK (start_year IS NULL OR start_year BETWEEN 1950 AND 2100),
    end_year        INT DEFAULT NULL CHECK (end_year IS NULL OR end_year BETWEEN 1950 AND 2100),
    is_current      BOOLEAN NOT NULL DEFAULT FALSE,

    score           VARCHAR(40) DEFAULT NULL,
    score_type      VARCHAR(20) DEFAULT NULL
                    CHECK (score_type IS NULL OR score_type IN ('PERCENTAGE','CGPA','GPA','GRADE')),

    details         VARCHAR(1000) DEFAULT NULL,
    position        INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultant_education
    ON consultant_education (consultant_id, position);


/* ── work history ────────────────────────────────────────────────────── */
--
-- Not in the original request, and added deliberately: a resume for an
-- experienced consultant with no employment section is not a resume. Freshers
-- simply leave it empty, which the Entry-Level template expects.
CREATE TABLE IF NOT EXISTS consultant_experience (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    company         VARCHAR(255) NOT NULL CHECK (length(btrim(company)) > 0),
    title           VARCHAR(255) NOT NULL CHECK (length(btrim(title)) > 0),
    location        VARCHAR(255) DEFAULT NULL,
    employment_type VARCHAR(30)  DEFAULT NULL,

    -- Kept as the consultant wrote them — "Mar 2021", "2019". Parsing them into
    -- dates invents precision the person never gave.
    start_date      VARCHAR(40) DEFAULT NULL,
    end_date        VARCHAR(40) DEFAULT NULL,
    is_current      BOOLEAN NOT NULL DEFAULT FALSE,

    -- The raw material tailoring works on: reordered and reworded per job,
    -- never added to.
    bullets         JSONB NOT NULL DEFAULT '[]'::jsonb,
    tech_used       JSONB NOT NULL DEFAULT '[]'::jsonb,

    position        INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultant_experience
    ON consultant_experience (consultant_id, position);


/* ── projects ────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS consultant_projects (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    name            VARCHAR(255) NOT NULL CHECK (length(btrim(name)) > 0),
    description     VARCHAR(2000) DEFAULT NULL,

    -- "Jan 2024 – Apr 2024", or "3 months". Free text for the same reason as
    -- the employment dates above.
    duration        VARCHAR(80) DEFAULT NULL,
    team_size       INT DEFAULT NULL CHECK (team_size IS NULL OR team_size > 0),
    role            VARCHAR(255) DEFAULT NULL,

    deployed_url    VARCHAR(500) DEFAULT NULL,
    repo_url        VARCHAR(500) DEFAULT NULL,

    bullets         JSONB NOT NULL DEFAULT '[]'::jsonb,
    tech_used       JSONB NOT NULL DEFAULT '[]'::jsonb,

    position        INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultant_projects
    ON consultant_projects (consultant_id, position);


/* ── certifications, courses, awards ─────────────────────────────────── */
--
-- One table for all three. They differ only in what `kind` says, and splitting
-- them would mean three near-identical tables and three near-identical forms.
CREATE TABLE IF NOT EXISTS consultant_certifications (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- CERTIFICATION  a credential with an issuer
    -- COURSE         a completed course
    -- AWARD          a win or a placement
    -- PARTICIPATION  attended, took part
    kind            VARCHAR(20) NOT NULL DEFAULT 'CERTIFICATION'
                    CHECK (kind IN ('CERTIFICATION','COURSE','AWARD','PARTICIPATION')),

    name            VARCHAR(255) NOT NULL CHECK (length(btrim(name)) > 0),
    issuer          VARCHAR(255) DEFAULT NULL,

    issued_on       VARCHAR(40) DEFAULT NULL,
    expires_on      VARCHAR(40) DEFAULT NULL,
    credential_id   VARCHAR(255) DEFAULT NULL,
    credential_url  VARCHAR(500) DEFAULT NULL,

    details         VARCHAR(1000) DEFAULT NULL,
    position        INT NOT NULL DEFAULT 0,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultant_certifications
    ON consultant_certifications (consultant_id, position);


/* ── keep updated_at honest on all of them ───────────────────────────── */

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['consultant_education','consultant_experience',
                             'consultant_projects','consultant_certifications']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END LOOP;
END $$;


/* ── the agency's choice ─────────────────────────────────────────────── */
--
-- BASE_RESUME  tailor the file the consultant uploaded. What the system does
--              today, and what an agency already happy with it keeps.
-- PROFILE      build the resume from the structured profile into a template.
--
-- Deliberately per organisation and defaulting to BASE_RESUME: every existing
-- agency carries on exactly as before until somebody decides otherwise, and
-- nobody wakes up to a pipeline that changed under them.
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS resume_source VARCHAR(20) NOT NULL DEFAULT 'BASE_RESUME',
    -- One template for the whole agency. See config/resumeTemplates.js.
    ADD COLUMN IF NOT EXISTS resume_template VARCHAR(40) NOT NULL DEFAULT 'CLASSIC';

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_resume_source;
ALTER TABLE organizations
    ADD CONSTRAINT chk_org_resume_source
        CHECK (resume_source IN ('BASE_RESUME','PROFILE'));


/* ── the new skip reason ─────────────────────────────────────────────── */
--
-- In PROFILE mode, a profile with no skills, no education and no experience
-- gives the tailoring step nothing to build from. Generating anyway would
-- either produce a resume with empty sections or invite the model to fill the
-- gaps, which is the exact failure the fabrication check exists to prevent.
--
-- So it takes the same path every other shortfall takes: the application still
-- goes out, carrying the base resume, marked with the reason. Nothing is
-- blocked and nothing is invented.
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
            'PROFILE_INCOMPLETE'      -- new: nothing in the profile to build from
        )
    );

-- Which template and which source produced a given file, so a resume can be
-- accounted for months later when both settings have moved on.
ALTER TABLE resume_artifacts
    ADD COLUMN IF NOT EXISTS template     VARCHAR(40) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS resume_source VARCHAR(20) DEFAULT NULL;

COMMENT ON COLUMN organizations.resume_source IS
    'Where tailoring reads the consultant''s career from: BASE_RESUME (the '
    'uploaded file, parsed once and cached) or PROFILE (the structured rows in '
    'consultant_education / _experience / _projects / _skills / _certifications).';
