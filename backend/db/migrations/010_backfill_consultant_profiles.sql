-- 010_backfill_consultant_profiles.sql
-- Purpose: give every existing CONSULTANT a profile row.
-- Phase: 2
--
-- From here on, createUser() inserts the profile in the same transaction as
-- the user, so every consultant ALWAYS has one. This backfills the consultants
-- that were seeded before that existed, so no read path ever has to handle a
-- missing profile.

INSERT INTO consultant_profiles (user_id, organization_id, daily_cap, created_by)
SELECT u.id, u.organization_id, 5, u.created_by
  FROM users u
 WHERE u.role = 'CONSULTANT'
   AND NOT EXISTS (
       SELECT 1 FROM consultant_profiles p WHERE p.user_id = u.id
   );
