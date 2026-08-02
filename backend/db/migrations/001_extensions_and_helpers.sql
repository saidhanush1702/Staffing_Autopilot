-- 001_extensions_and_helpers.sql
-- Purpose: extensions + the shared updated_at trigger function.
-- Phase: 1

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- PostgreSQL has no ON UPDATE CURRENT_TIMESTAMP clause (that is a MySQL-ism),
-- so every table attaches this trigger to keep updated_at accurate.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
