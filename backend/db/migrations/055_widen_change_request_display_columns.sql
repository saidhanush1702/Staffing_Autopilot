-- 055_widen_change_request_display_columns.sql
-- Purpose: fix a crash on "Submit for approval" whenever a long free-text
--          field (summary, headline, ...) is part of the submission.
-- Phase: 8 follow-up
--
-- ── THE BUG ────────────────────────────────────────────────────────────
--
-- profile_change_request_fields.old_value / new_value are TEXT — unbounded,
-- correctly. old_display / new_display were left VARCHAR(255) from when this
-- table only tracked short scalar fields (phone, city, a lookup label).
-- Migration 049/050 added `summary` (up to 4000 chars, see
-- config/profileFields.js) to the consultant-editable fields, and
-- toDisplayValue() returns free text as-is, with no truncation. The moment
-- anyone submits a summary longer than 255 characters — which is nearly
-- every real one, and exactly what "Fill with resume" produces — the INSERT
-- into profile_change_request_fields throws "value too long for type
-- character varying(255)", which surfaces to the consultant as a bare
-- "Internal server error." with no indication of what to shorten.
--
-- The display column exists to be READABLE, not narrower than its own
-- source value. Widening it to TEXT, matching old_value/new_value, removes
-- this whole class of bug for any future long field too.

ALTER TABLE profile_change_request_fields
    ALTER COLUMN old_display TYPE TEXT,
    ALTER COLUMN new_display TYPE TEXT;
