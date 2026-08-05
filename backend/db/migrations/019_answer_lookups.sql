-- 019_answer_lookups.sql
-- Purpose: lookup tables for the answer bank.
-- Phase: 4
--
-- Convention: lkp_ prefix, INT identity PK, name UNIQUE NOT NULL, plus a
-- `label` so no screen ever types a status by hand.

CREATE TABLE IF NOT EXISTS lkp_answer_statuses (
    id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR(30) NOT NULL UNIQUE,
    label VARCHAR(80) NOT NULL
);

-- ── question categories ───────────────────────────────────────────────
--
-- `requires_owner_approval` is the ENTIRE routing rule for R-07, and it lives
-- in DATA rather than in a hardcoded list of category names. Making
-- "Criminal record" or "Notice period" owner-only later is then a seed change,
-- not a controller change — and there is exactly one place to read the rule
-- from, so the API and the UI cannot disagree about who may approve what.
CREATE TABLE IF NOT EXISTS lkp_question_categories (
    id                      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                    VARCHAR(40) NOT NULL UNIQUE,
    label                   VARCHAR(80) NOT NULL,
    requires_owner_approval BOOLEAN NOT NULL DEFAULT FALSE,
    description             VARCHAR(255) DEFAULT NULL
);
