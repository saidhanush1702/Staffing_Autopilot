-- 011_consolidate_consultant_phone.sql
-- Purpose: fix the duplicated `phone` column (issue C-3).
-- Phase: 2 (remediation)
--
-- PROBLEM
--   `phone` existed on BOTH users and consultant_profiles. createUser wrote to
--   both, then they diverged:
--     - ORG_ADMIN editing a user      -> wrote users.phone
--     - an approved consultant change -> wrote consultant_profiles.phone
--     - the Users screen displayed    -> users.phone  (stale)
--   A consultant could update their number, have it approved, and the agency
--   would still see the old one.
--
-- OWNERSHIP RULE FROM HERE ON
--   CONSULTANT          -> consultant_profiles.phone is the single source.
--                          users.phone is always NULL for them.
--   ORG_ADMIN/RECRUITER -> users.phone (they have no profile row).
--   Reads use COALESCE(profile.phone, users.phone), so one expression works
--   for every role.

-- 1. Preserve anything that only exists on users.
UPDATE consultant_profiles p
   SET phone = u.phone
  FROM users u
 WHERE u.id = p.user_id
   AND p.phone IS NULL
   AND u.phone IS NOT NULL;

-- 2. Clear the duplicate so there is no stale value left to read by accident.
UPDATE users
   SET phone = NULL
 WHERE role = 'CONSULTANT'
   AND phone IS NOT NULL;

-- 3. Record the rule where a future developer will actually see it.
COMMENT ON COLUMN users.phone IS
    'Account phone for ORG_ADMIN and RECRUITER. Always NULL for CONSULTANT — see consultant_profiles.phone.';

COMMENT ON COLUMN consultant_profiles.phone IS
    'Single source of truth for a consultant''s phone. This is the number used on job applications.';
