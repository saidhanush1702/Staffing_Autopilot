-- 023_job_postings.sql
-- Purpose: the posting pool, its de-duplication, and the raw material it came from.
-- Phase: 5
--
-- Three tables, and the two supporting ones are what make a scraper survivable:
--
--   job_postings          the normalised posting, one row per fingerprint
--   job_posting_sightings every time a board showed us that posting
--   job_source_payloads   the RAW html/json we parsed it out of
--
-- WHY KEEP THE RAW PAYLOAD. Every board will change its markup, without notice,
-- and the parser will break. If the raw response is gone, so is every posting
-- that arrived while it was broken. Keeping it means a parser fix can be
-- REPLAYED over history instead of the data being lost. Bytes are cheap; a week
-- of missed postings is not.

CREATE TABLE IF NOT EXISTS job_postings (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- ── the normalised shape every connector must produce ─────────────
    company         VARCHAR(255) NOT NULL CHECK (length(btrim(company)) > 0),
    title           VARCHAR(255) NOT NULL CHECK (length(btrim(title)) > 0),
    location_text   VARCHAR(255) DEFAULT NULL,
    is_remote       BOOLEAN NOT NULL DEFAULT FALSE,

    description     TEXT DEFAULT NULL,
    source_url      VARCHAR(1000) NOT NULL,

    work_type_id    INT DEFAULT NULL REFERENCES lkp_work_types(id) ON DELETE SET NULL,
    portal_type_id  INT DEFAULT NULL REFERENCES lkp_portal_types(id) ON DELETE SET NULL,

    -- Pay as advertised. Nullable because most postings do not state it, and
    -- inventing a number would poison the minimum-pay filter.
    pay_min         NUMERIC(12,2) DEFAULT NULL CHECK (pay_min IS NULL OR pay_min >= 0),
    pay_max         NUMERIC(12,2) DEFAULT NULL CHECK (pay_max IS NULL OR pay_max >= 0),
    pay_unit        VARCHAR(10)   DEFAULT NULL CHECK (pay_unit IN ('HOURLY','ANNUAL')),
    pay_currency    CHAR(3)       DEFAULT NULL,
    CONSTRAINT chk_posting_pay_pair
        CHECK ((pay_min IS NULL AND pay_max IS NULL) OR pay_unit IS NOT NULL),

    -- R-15. company + title + location, each normalised. See config/fingerprint.js.
    fingerprint     CHAR(64) NOT NULL,

    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    times_seen      INT NOT NULL DEFAULT 1 CHECK (times_seen > 0),

    -- The board that showed it to us FIRST. Later sightings from other boards
    -- live in job_posting_sightings rather than overwriting this.
    first_source_id INT DEFAULT NULL REFERENCES lkp_job_sources(id) ON DELETE SET NULL,

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    posted_at       TIMESTAMPTZ DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- R-15, enforced by the database rather than by careful controller code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_posting_fingerprint_per_org
    ON job_postings (organization_id, fingerprint);

CREATE INDEX IF NOT EXISTS idx_postings_org_seen
    ON job_postings (organization_id, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_postings_org_active
    ON job_postings (organization_id, is_active) WHERE is_active;

DROP TRIGGER IF EXISTS trg_job_postings_updated_at ON job_postings;
CREATE TRIGGER trg_job_postings_updated_at
    BEFORE UPDATE ON job_postings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── every time a board showed us this posting ─────────────────────────
--
-- Makes de-duplication INSPECTABLE. When two postings merge into one, this is
-- the evidence of what merged and from where — otherwise a bad fingerprint
-- silently swallows real jobs and nobody can prove it.
CREATE TABLE IF NOT EXISTS job_posting_sightings (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    posting_id      CHAR(36) NOT NULL
                    REFERENCES job_postings(id) ON DELETE CASCADE,
    source_id       INT NOT NULL REFERENCES lkp_job_sources(id) ON DELETE CASCADE,
    run_id          CHAR(36) DEFAULT NULL,

    source_url      VARCHAR(1000) NOT NULL,
    seen_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sightings_posting ON job_posting_sightings (posting_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sightings_source  ON job_posting_sightings (source_id, seen_at DESC);


-- ── the raw material ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_source_payloads (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    source_id       INT NOT NULL REFERENCES lkp_job_sources(id) ON DELETE CASCADE,
    run_id          CHAR(36) DEFAULT NULL,

    request_url     VARCHAR(1000) NOT NULL,
    http_status     INT DEFAULT NULL,
    content_type    VARCHAR(120) DEFAULT NULL,

    -- Truncated rather than unbounded: enough to re-parse, not enough to turn
    -- the database into a web archive.
    body            TEXT DEFAULT NULL,
    body_bytes      INT DEFAULT NULL,

    -- How many postings this payload yielded. Zero on a page that parsed
    -- cleanly but contained nothing is a strong signal the selectors have
    -- drifted, which a 200 response alone would hide.
    postings_found  INT NOT NULL DEFAULT 0,

    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payloads_source ON job_source_payloads (source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_payloads_run    ON job_source_payloads (run_id);


-- ── anything that would not parse ─────────────────────────────────────
--
-- Held, never dropped. A silent drop is how a source degrades for weeks with
-- everyone believing it is fine.
CREATE TABLE IF NOT EXISTS job_parse_quarantine (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    source_id       INT NOT NULL REFERENCES lkp_job_sources(id) ON DELETE CASCADE,
    payload_id      CHAR(36) DEFAULT NULL
                    REFERENCES job_source_payloads(id) ON DELETE SET NULL,
    run_id          CHAR(36) DEFAULT NULL,

    reason          VARCHAR(255) NOT NULL,
    raw_fragment    TEXT DEFAULT NULL,

    resolved        BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at     TIMESTAMPTZ DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quarantine_open
    ON job_parse_quarantine (organization_id, source_id) WHERE NOT resolved;
