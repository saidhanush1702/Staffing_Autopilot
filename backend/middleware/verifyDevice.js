/**
 * ── DEVICE AUTHENTICATION ─────────────────────────────────────────────
 *
 * A second, deliberately separate identity from the user session.
 *
 * `verifyToken` authenticates a PERSON in a browser and yields a role. This
 * authenticates a MACHINE and yields exactly one consultant. They are kept
 * apart on purpose: a device token must never be usable on a management route,
 * and a stolen browser cookie must never drive the desktop app.
 *
 * ── WHAT IS CHECKED ON EVERY CALL ─────────────────────────────────────
 *
 *   · the token hashes to a known device
 *   · that device has not been revoked            (R-21, instant kill)
 *   · the machine fingerprint still matches       (R-21, one machine)
 *   · the consultant is still ACTIVE              (a leaver's app stops)
 *   · the organisation is still active
 *
 * Any failure is 401, and the app treats 401 as "wipe local state and return to
 * the activation screen". So revoking a device is effective on its next call,
 * with no push channel and nothing to keep in sync.
 */
import crypto from 'node:crypto';
import { query } from '../db.js';

/**
 * Tokens are compared by hash, never by value.
 *
 * SHA-256 without a salt is correct here and would be wrong for a password: the
 * input is 32 bytes of cryptographic randomness, so there is no dictionary to
 * attack and nothing a salt would defend against. What matters is that the
 * database never holds anything replayable.
 */
export const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/** 32 random bytes, url-safe. Shown once, never stored. */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

/**
 * A short activation code a person can read aloud or retype.
 *
 * Deliberately not the device token: this one is handed over by a human, so it
 * trades entropy for legibility and is short-lived and single-use to
 * compensate. Ambiguous characters are excluded so nobody loses ten minutes to
 * an O that was a 0.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newActivationCode = () => {
    const bytes = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i += 1) {
        if (i > 0 && i % 4 === 0) out += '-';
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;              // e.g. K7QF-2M9X-BTRH
};

const unauthorised = (res, reason) => res.status(401).json({ error: reason, device: true });

export const verifyDevice = async (req, res, next) => {
    try {
        const header = req.headers.authorization ?? '';
        const [scheme, token] = header.split(' ');

        if (scheme !== 'Device' || !token) {
            return unauthorised(res, 'A device token is required.');
        }

        const { rows } = await query(
            `SELECT d.id, d.organization_id, d.consultant_id, d.machine_fingerprint,
                    d.revoked_at, d.activated_at,
                    u.employment_status, u.name AS consultant_name,
                    o.is_active AS org_active
               FROM devices d
               JOIN users u ON u.id = d.consultant_id
               JOIN organizations o ON o.id = d.organization_id
              WHERE d.device_token_hash = $1`,
            [hashToken(token)],
        );

        const device = rows[0];
        if (!device || !device.activated_at) {
            return unauthorised(res, 'This device is not recognised.');
        }
        if (device.revoked_at) {
            return unauthorised(res, 'This device has been revoked.');
        }
        if (!device.org_active) {
            return unauthorised(res, 'This organisation is no longer active.');
        }
        // A terminated or suspended consultant's app stops immediately. Without
        // this the machine would keep applying to jobs in the name of somebody
        // who no longer works here.
        if (device.employment_status !== 'ACTIVE') {
            return unauthorised(res, 'This consultant is no longer active.');
        }

        // R-21's second half. The token alone is not enough — it has to be
        // presented from the machine it was bound to, so a copied token on
        // another laptop is refused.
        const presented = req.get('X-Machine-Fingerprint');
        if (device.machine_fingerprint && presented !== device.machine_fingerprint) {
            return unauthorised(res, 'This token was issued to a different machine.');
        }

        req.device = {
            id: device.id,
            orgId: device.organization_id,
            consultantId: device.consultant_id,
            consultantName: device.consultant_name,
        };

        // Liveness for the owner's dashboard. Deliberately not awaited: a
        // failed bookkeeping write must not fail the consultant's request.
        query('UPDATE devices SET last_seen_at = now(), app_version = COALESCE($2, app_version) WHERE id = $1',
            [device.id, req.get('X-App-Version') ?? null]).catch(() => {});

        return next();
    } catch (err) {
        return next(err);
    }
};
