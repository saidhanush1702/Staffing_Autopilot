-- 033_devices.sql
-- Purpose: consultant desktop app identity — activation, device tokens, and
--          per-board session state.
-- Phase: 7 (desktop app), hub side
--
-- ── R-21, AND WHY THE TOKEN IS HASHED ─────────────────────────────────
--
-- "Device tokens bind to one person AND one machine, and are revocable
-- instantly by the owner, which kills the app immediately."
--
-- Instant revocation is why the token is an opaque random string stored as a
-- HASH rather than a signed token. A JWT cannot be un-issued: revoking one
-- means keeping a denylist, which is a second source of truth that can
-- disagree with the first. Here, revocation is a timestamp on one row and the
-- next call the app makes fails.
--
-- The plaintext token is returned exactly once, at activation, and never
-- stored. Nobody — including an owner reading the database — can recover a
-- device's token; they can only revoke it and issue another.

CREATE TABLE IF NOT EXISTS devices (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- ── activation ────────────────────────────────────────────────────
    -- The one-time code the owner hands to the consultant. Hashed for the same
    -- reason as the device token, and short-lived: a code that works forever is
    -- a password that was written on a sticky note.
    activation_hash    CHAR(64)    NOT NULL,
    activation_expires TIMESTAMPTZ NOT NULL,
    activated_at       TIMESTAMPTZ DEFAULT NULL,

    -- ── the device token, set at activation ───────────────────────────
    device_token_hash  CHAR(64)     DEFAULT NULL,

    -- R-21's "one machine". Captured at activation and compared on every call,
    -- so a token copied to a second machine is refused even though it is the
    -- correct token.
    machine_fingerprint VARCHAR(128) DEFAULT NULL,
    -- Human-readable, for the owner's dashboard: "DESKTOP-4F2A · Windows 11".
    machine_label       VARCHAR(120) DEFAULT NULL,

    -- ── lifecycle ─────────────────────────────────────────────────────
    revoked_at      TIMESTAMPTZ DEFAULT NULL,
    revoked_by      CHAR(36)    DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    revoke_reason   VARCHAR(255) DEFAULT NULL,

    last_seen_at    TIMESTAMPTZ DEFAULT NULL,
    app_version     VARCHAR(32) DEFAULT NULL,

    issued_by       CHAR(36) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live device per consultant. Enforced here rather than in code because
-- two devices pulling the same queue means the same job applied to twice, under
-- one person's name, to one employer — which the employer sees.
--
-- Issuing a new device therefore revokes the old one; the index makes the
-- alternative impossible rather than merely discouraged.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_device_per_consultant
    ON devices (consultant_id)
    WHERE revoked_at IS NULL AND activated_at IS NOT NULL;

-- Only one pending activation at a time, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_activation
    ON devices (consultant_id)
    WHERE revoked_at IS NULL AND activated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_org ON devices (organization_id, revoked_at);
-- The lookup on every authenticated call.
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (device_token_hash)
    WHERE device_token_hash IS NOT NULL;

DROP TRIGGER IF EXISTS trg_devices_updated_at ON devices;
CREATE TRIGGER trg_devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── per-board session state ───────────────────────────────────────────
--
-- The app reports what it found on each board so the stall is visible on the
-- recruiter and owner dashboards, rather than the consultant silently applying
-- to nothing for a week.
--
--   OK               logged in, working
--   SESSION_EXPIRED  needs the consultant to sign in again
--   BOT_CHECK        the board challenged us
--
-- `paused_until` is what the app obeys. For a bot-check on LinkedIn it is set
-- to the end of the agency's day, which is R-22's "a full stop for the
-- remainder of the day".
CREATE TABLE IF NOT EXISTS device_board_status (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    device_id       CHAR(36) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

    -- Matches lkp_job_sources.name, but kept as text: the app knows boards by
    -- name and should not need a lookup id to report a stall.
    board           VARCHAR(40) NOT NULL,

    state           VARCHAR(20) NOT NULL DEFAULT 'OK'
                    CHECK (state IN ('OK', 'SESSION_EXPIRED', 'BOT_CHECK')),

    paused_until    TIMESTAMPTZ DEFAULT NULL,
    detail          VARCHAR(255) DEFAULT NULL,
    reported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_board_per_device UNIQUE (device_id, board)
);

CREATE INDEX IF NOT EXISTS idx_board_status_org
    ON device_board_status (organization_id, state);


-- ── resume deliveries ─────────────────────────────────────────────────
--
-- R-11: "Every resume delivery is logged with time, person, and machine."
-- The audit log records who did what; this records the fact that a specific
-- file reached a specific machine for a specific job, which is the question
-- asked when somebody wants to know where a CV went.
CREATE TABLE IF NOT EXISTS resume_deliveries (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    consultant_id   CHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artifact_id     CHAR(36) NOT NULL
                    REFERENCES resume_artifacts(id) ON DELETE RESTRICT,
    queue_item_id   CHAR(36) DEFAULT NULL
                    REFERENCES queue_items(id) ON DELETE SET NULL,

    device_id       CHAR(36) DEFAULT NULL REFERENCES devices(id) ON DELETE SET NULL,
    delivered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address      VARCHAR(64) DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_resume_deliveries_consultant
    ON resume_deliveries (organization_id, consultant_id, delivered_at DESC);
