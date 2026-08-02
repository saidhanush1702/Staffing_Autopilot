-- 006_lookups.sql
-- Purpose: shared lookup tables, served in ONE call via GET /api/lookups.
-- Phase: 1
--
-- Convention: lkp_ prefix, INT identity PK, name UNIQUE NOT NULL.
-- Referenced from business tables as <thing>_id INT DEFAULT NULL
-- ... ON DELETE SET NULL.

CREATE TABLE IF NOT EXISTS lkp_genders (
    id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS lkp_user_statuses (
    id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS lkp_work_auth_statuses (
    id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS lkp_roles (
    id   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    label VARCHAR(80) NOT NULL
);
