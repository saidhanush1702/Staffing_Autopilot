-- 050_career_change_requests.sql
-- Purpose: fold the consultant's career record (skills, experience, education,
--          projects, certifications) into the SAME approval workflow that
--          already governs phone, city and the base resume.
-- Phase: 8
--
-- ── WHY THIS EXISTS ───────────────────────────────────────────────────────
--
-- "My Profile" and "My Career" were two pages built for the same reason —
-- tell the agency about yourself so the right jobs reach you — on two
-- different engines. Profile changes were reviewed field by field before
-- going live; career changes wrote straight to the table the moment a
-- consultant clicked something.
--
-- That split was a real decision (see migration 049's header) made on the
-- reasoning that career facts are the consultant's own history and a
-- forty-item approval queue would stall onboarding. The client has since
-- asked for the two pages to become one, with the SAME reviewer gate over
-- everything a consultant submits. This migration is that: one page, one
-- submission, one decision, both kinds of data.
--
-- ── WHY IDENTITY FIELDS DID NOT NEED A SCHEMA CHANGE ────────────────────────
--
-- Phone, city, and now headline/summary/github/portfolio/coding-profile are
-- all SCALAR — one value per field. They already fit
-- profile_change_request_fields perfectly; the five new "about you" fields
-- just join config/profileFields.js as five more entries (no migration
-- needed there — see that file).
--
-- ── WHY CAREER DID NOT FIT THE SAME TABLE ────────────────────────────────
--
-- A field row is (name, old value, new value). Skills, jobs, education and
-- projects are each a LIST of rows, and a consultant's edit is "here is the
-- whole list now" — add three, remove one, reorder the rest. Modelling that
-- as individual field rows would mean inventing a synthetic field name per
-- list item, which breaks the moment two submissions touch the same list.
--
-- A snapshot avoids that entirely. One row per section, holding the WHOLE
-- proposed content as JSON, submitted once and decided once — which is
-- exactly the granularity the client asked for.

CREATE TABLE IF NOT EXISTS profile_change_request_career (
    -- 1:1 with the request. A request either has no career changes (no row
    -- here at all) or exactly one snapshot of everything that changed.
    change_request_id CHAR(36) PRIMARY KEY
                       REFERENCES profile_change_requests(id) ON DELETE CASCADE,

    organization_id    CHAR(36) NOT NULL
                        REFERENCES organizations(id) ON DELETE CASCADE,

    -- Each is the FULL proposed array for that section — not a diff. Applying
    -- an approval is "replace the live rows with this", which is simple,
    -- auditable, and cannot drift from a delta that half-applied.
    --
    -- Absent sections are stored as NULL, not '[]': NULL means "the consultant
    -- did not touch this section", and an empty array means "they cleared it
    -- out on purpose". The two must stay distinguishable, or approving a
    -- request that only changed skills would silently wipe a consultant's
    -- entire employment history.
    skills          JSONB DEFAULT NULL,
    education       JSONB DEFAULT NULL,
    experience      JSONB DEFAULT NULL,
    projects        JSONB DEFAULT NULL,
    certifications  JSONB DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_career_snapshot_org
    ON profile_change_request_career (organization_id);

COMMENT ON TABLE profile_change_request_career IS
    'The proposed career-section content attached to a profile change request. '
    'Applied wholesale on approval (old rows replaced), discarded on rejection. '
    'A NULL column means that section was not touched; [] means it was cleared.';
