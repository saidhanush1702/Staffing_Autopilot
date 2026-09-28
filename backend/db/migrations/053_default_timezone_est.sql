-- 053_default_timezone_est.sql
--
-- The deployment's clock moves to Eastern time. `organizations.timezone`
-- drove the daily-cap reset boundary and the discovery scheduler off
-- 'Asia/Kolkata' by default; nothing in the UI ever exposed a way to change
-- it per agency, so every row still on that default is on it by accident,
-- not by choice. Reset those rows and point new ones at Eastern time too.

ALTER TABLE organizations ALTER COLUMN timezone SET DEFAULT 'America/New_York';

UPDATE organizations SET timezone = 'America/New_York' WHERE timezone = 'Asia/Kolkata';
