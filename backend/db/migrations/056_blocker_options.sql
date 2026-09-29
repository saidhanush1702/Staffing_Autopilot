-- 056_blocker_options.sql
-- Purpose: a radio, checkbox or select question is shown to the consultant as
--          a free-text box, even though the form only ever accepted one of a
--          fixed set of choices — and typed text rarely matches any of them
--          exactly, which is why a radio answer keeps failing to fill and the
--          same job keeps coming back asking it again.
-- Phase: 6

-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
--
-- `queue_item_blockers.field_type` already says a question is a radio, a
-- select or a checkbox — but the actual OPTIONS the form offered were never
-- kept, so the Questions tab could not show them and a consultant answering
-- "Yes" against options worded "Yes, I am authorized" never produced a match
-- the filler could act on. The application parked again on the next job that
-- asked the same thing, looking to the consultant like nothing was ever
-- answered at all.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────
--
-- Keeps the option labels the form actually offered, verbatim, alongside the
-- question. Nothing here changes how an item is released — `releasableItems`
-- still only cares whether an approved answer exists.

ALTER TABLE queue_item_blockers
    ADD COLUMN IF NOT EXISTS options JSONB DEFAULT NULL;

COMMENT ON COLUMN queue_item_blockers.options IS
    'The exact option labels this form offered, for a radio, checkbox group or '
    'select — null for a plain text question. Lets the Questions tab show the '
    'real choices instead of a free-text box, so the answer saved is one of '
    'them, verbatim, and reliably matches the same or a similarly-worded form.';
