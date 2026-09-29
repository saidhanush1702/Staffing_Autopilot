-- 034_device_code_retrievable.sql
-- Purpose: let an ORG_ADMIN read an activation code back after issuing it.
-- Phase: 6 (desktop app access)

-- ── WHY THIS CHANGES A DELIBERATE DECISION ───────────────────────────────
--
-- 033 stored the activation code as a SHA-256 hash and nothing else, so that
-- once shown it could never be recovered — by this application, by an admin
-- reading the database, or by anyone who took a copy of it.
--
-- The owner's decision is that an admin must be able to look a code up again,
-- exactly as they can already look up a user's password. In practice an
-- unrecoverable code means that losing the message you pasted it into costs a
-- reissue, and reissuing revokes the device the consultant may already be using.
--
-- The trade is real and worth naming: a retrievable code is a live credential
-- sitting in a table. It is therefore given the SAME protection a password gets
-- in this system and no less — AES-256-GCM under PASSWORD_ENC_KEY, which lives
-- in the environment and never in the database. Someone who reads a database
-- backup still cannot use what they find.
--
-- ── THE HASH STAYS ───────────────────────────────────────────────────────
--
-- activation_hash is untouched and remains the only thing activation is checked
-- against. The encrypted copy exists purely so a human can be shown the code
-- again; it is never used to authenticate anything. Keeping verification on the
-- hash means this change cannot weaken the activation path itself.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS activation_enc TEXT,          -- base64 ciphertext
    ADD COLUMN IF NOT EXISTS activation_iv  VARCHAR(32),   -- hex, 12 bytes
    ADD COLUMN IF NOT EXISTS activation_tag VARCHAR(32);   -- hex GCM auth tag

-- Nullable on purpose. Devices issued before this migration have a hash and no
-- ciphertext, and their codes are genuinely unrecoverable — the reveal endpoint
-- says so rather than pretending the row is broken.

COMMENT ON COLUMN devices.activation_enc IS
    'AES-256-GCM ciphertext of the activation code, so an ORG_ADMIN can be shown '
    'it again. Never used for verification — that is activation_hash. Null for '
    'devices issued before migration 034.';
