-- 016_work_types_lookup.sql
-- Purpose: the engagement types a consultant will accept.
-- Phase: 3
--
-- Convention: lkp_ prefix, INT identity PK, name UNIQUE NOT NULL, and a
-- `label` for the UI so no screen ever types "Full-time" by hand.
-- Seeded in db/seeds/001_lookups_seed.js.

CREATE TABLE IF NOT EXISTS lkp_work_types (
    id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR(50) NOT NULL UNIQUE,
    label VARCHAR(80) NOT NULL
);
