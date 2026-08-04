-- 013_login_attempts.sql
-- Purpose: per-account login lockout (issue A-2).
-- Phase: 2 (remediation)
--
-- WHY
--   The only protection was an express-rate-limit keyed on IP. A staffing
--   agency sits behind one office IP, so ten fat-fingered passwords locked out
--   the whole building — including the admin who would fix it. Meanwhile
--   credential stuffing across many accounts from one IP was barely slowed,
--   and nothing at all stopped a distributed attack on a single account.
--
--   Lockout belongs on the ACCOUNT. This table makes it durable, so a server
--   restart does not clear an attacker's counter.

CREATE TABLE IF NOT EXISTS login_attempts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email        CITEXT      NOT NULL,
    ip_address   VARCHAR(64) DEFAULT NULL,
    user_agent   VARCHAR(255) DEFAULT NULL,
    succeeded    BOOLEAN     NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookups are always "recent failures for this email", so lead with both.
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
    ON login_attempts (email, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time
    ON login_attempts (attempted_at DESC);
