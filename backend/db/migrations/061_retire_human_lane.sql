-- 061_retire_human_lane.sql
-- Purpose: there is no "consultant applies by hand" lane any more.
-- Phase: 9
--
-- Every job is applied to by the desktop app: a coded recipe where one exists,
-- the AI agent everywhere else. The HUMAN lane existed for jobs nothing could
-- fill, and the rule is now that those are not handed to a person — they are
-- SKIPPED with a reason and a recruiter can Requeue them.
--
-- Existing HUMAN rows become AGENT, which is what they would be created as
-- today. Their status is untouched, so a job already SUBMITTED stays SUBMITTED
-- and a READY one is simply picked up by the app.

UPDATE queue_items SET channel = 'AGENT' WHERE channel = 'HUMAN';

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS chk_queue_channel;
ALTER TABLE queue_items
    ADD CONSTRAINT chk_queue_channel CHECK (channel IN ('BOT', 'AGENT'));

ALTER TABLE queue_items ALTER COLUMN channel SET DEFAULT 'AGENT';
