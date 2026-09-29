-- 042_tailored_sections.sql
-- Purpose: keep the structured tailored resume, not just the PDF of it.
-- Phase: 7
--
-- ── WHY THIS COLUMN EXISTS ───────────────────────────────────────────────
--
-- The tailoring pipeline produced three things and kept two. The structured
-- resume the model returned was validated, scored, checked for fabrication,
-- rendered to a PDF — and then dropped. What survived was the PDF and the
-- flags raised against it.
--
-- That is enough to APPLY with and not enough to REVIEW. A reviewer looking at
-- a flagged resume has to see the sentence that was flagged, in the document it
-- appears in, next to the base resume it was supposed to come from. Without the
-- structured form the only way back to that text is to re-extract it from the
-- PDF, and PDF extraction does not return the same string that went in — line
-- breaks move, bullets become characters, spacing collapses.
--
-- That matters more than it sounds. `resume_fabrication_flags.claim_text` holds
-- the exact substring the checker compared, taken from the flattened structured
-- resume. Highlighting those claims inside re-extracted PDF text means matching
-- strings against a text they were not taken from, and the highlight silently
-- fails on precisely the long, specific claims that matter most.
--
-- ── WHY ON THE ARTIFACT AND NOT IN A NEW TABLE ───────────────────────────
--
-- It is one-to-one with the artifact, it is written once when the artifact is
-- written, and it dies with it. resume_documents is a separate table for the
-- opposite reason: a parsed BASE resume is shared by every job that consultant
-- is matched to, so it is keyed by content hash rather than by artifact.

ALTER TABLE resume_artifacts
    ADD COLUMN IF NOT EXISTS sections JSONB DEFAULT NULL;

COMMENT ON COLUMN resume_artifacts.sections IS
    'The structured resume this artifact was rendered from, for tailored '
    'artifacts. The text a fabrication flag''s claim_text was taken from, so '
    'the review screen can highlight claims in the document they came from. '
    'NULL for base uploads, which are files we received rather than built.';
