-- 018_search_criteria_children.sql
-- Purpose: the list-valued parts of a criteria version.
-- Phase: 3
--
-- All three tables hang off search_criteria_versions and are written ONCE,
-- when their version is created. Nothing here is ever updated — a change
-- produces a new version with a fresh copy of every child row.
--
-- WHY ONE `terms` TABLE INSTEAD OF FOUR. Job titles, include keywords,
-- exclude keywords and excluded companies are all "an ordered list of strings
-- attached to a version". Four near-identical tables would mean four
-- near-identical queries, four insert paths, and four places to fix the same
-- bug. One `kind`-discriminated table handles all of them, and a fifth list
-- type later costs one CHECK value.
--
-- Locations and work types keep their own tables because their SHAPE is
-- genuinely different, not merely their meaning.

CREATE TABLE IF NOT EXISTS search_criteria_terms (
    id              CHAR(36) PRIMARY KEY,

    version_id      CHAR(36) NOT NULL
                    REFERENCES search_criteria_versions(id) ON DELETE CASCADE,
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- JOB_TITLE        what to search for, `position` = priority order
    -- KEYWORD_INCLUDE  makes a posting interesting
    -- KEYWORD_EXCLUDE  disqualifies a posting outright
    -- EXCLUDED_COMPANY never surface anything from this employer
    kind            VARCHAR(20) NOT NULL
                    CHECK (kind IN ('JOB_TITLE','KEYWORD_INCLUDE','KEYWORD_EXCLUDE','EXCLUDED_COMPANY')),

    value           VARCHAR(200) NOT NULL CHECK (length(btrim(value)) > 0),

    -- 0-based order within its kind. Only JOB_TITLE treats it as priority;
    -- the others keep it so the editor round-trips what was typed.
    position        INT NOT NULL DEFAULT 0 CHECK (position >= 0),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The same term twice in the same list is a data-entry slip, not intent.
    CONSTRAINT uq_term_per_version UNIQUE (version_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_sct_version_kind
    ON search_criteria_terms (version_id, kind, position);


-- ── locations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_criteria_locations (
    id              CHAR(36) PRIMARY KEY,

    version_id      CHAR(36) NOT NULL
                    REFERENCES search_criteria_versions(id) ON DELETE CASCADE,
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    -- REMOTE rows may have no city or state at all — "remote, anywhere" is a
    -- real answer, so city is nullable rather than a placeholder string.
    city            VARCHAR(120) DEFAULT NULL,
    state           VARCHAR(120) DEFAULT NULL,

    work_mode       VARCHAR(10) NOT NULL DEFAULT 'ONSITE'
                    CHECK (work_mode IN ('ONSITE','HYBRID','REMOTE')),

    -- Only meaningful when there is a place to be near, so a radius on a
    -- REMOTE row is rejected rather than silently ignored.
    radius_miles    INT DEFAULT NULL CHECK (radius_miles IS NULL OR radius_miles BETWEEN 1 AND 500),

    position        INT NOT NULL DEFAULT 0 CHECK (position >= 0),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_location_has_place
        CHECK (work_mode = 'REMOTE' OR city IS NOT NULL),
    CONSTRAINT chk_remote_has_no_radius
        CHECK (work_mode <> 'REMOTE' OR radius_miles IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_scl_version ON search_criteria_locations (version_id, position);


-- ── work types ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_criteria_work_types (
    version_id      CHAR(36) NOT NULL
                    REFERENCES search_criteria_versions(id) ON DELETE CASCADE,
    work_type_id    INT NOT NULL
                    REFERENCES lkp_work_types(id) ON DELETE CASCADE,
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (version_id, work_type_id)
);

CREATE INDEX IF NOT EXISTS idx_scwt_version ON search_criteria_work_types (version_id);
