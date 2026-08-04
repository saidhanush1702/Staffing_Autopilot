/**
 * Layer 0 — authentication.
 *
 * Reads the JWT from the httpOnly `token` cookie, verifies it, then RE-CHECKS
 * the account against the database before letting the request through.
 *
 * The database check is not optional. A JWT is valid for 24 hours and cannot
 * be recalled, so signature-only verification meant that suspending,
 * terminating, or demoting someone left them with full access until their
 * token happened to expire. Three states are re-validated on every request:
 *
 *   1. employment_status — a suspended or terminated account is cut off at once
 *   2. the organisation is still active
 *   3. the role in the token still matches the database, so a demotion takes
 *      effect immediately rather than a day later
 *
 * Cost is one indexed primary-key lookup — sub-millisecond, and it closes all
 * three holes at once.
 *
 * orgId comes from the SIGNED TOKEN, never from the body, query string, or
 * route params. That is the whole basis of tenant isolation.
 */
import jwt from 'jsonwebtoken';
import { query } from '../db.js';

const clearCookie = (res) => {
    res.cookie('token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        expires: new Date(0),
        path: '/',
    });
};

const STATUS_MESSAGE = {
    SUSPENDED: 'Your access has been suspended. Contact your organization admin.',
    TERMINATED: 'This account has been terminated.',
};

export const verifyToken = async (req, res, next) => {
    const token = req.cookies?.token;

    if (!token) {
        return res.status(401).json({ error: 'Not authenticated. Please log in.' });
    }

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        const expired = err.name === 'TokenExpiredError';
        return res.status(401).json({
            error: expired ? 'Session expired. Please log in again.' : 'Invalid session.',
        });
    }

    try {
        const { rows } = await query(
            `SELECT u.id, u.role, u.organization_id, u.employment_status,
                    o.is_active AS org_active
               FROM users u
          LEFT JOIN organizations o ON o.id = u.organization_id
              WHERE u.id = $1`,
            [payload.id],
        );
        const user = rows[0];

        if (!user) {
            clearCookie(res);
            return res.status(401).json({ error: 'Account no longer exists.' });
        }

        // 401, not 403. The distinction matters: 403 means "you are signed in
        // but may not do this", and the client keeps the session. Here the
        // session itself is dead, so it must be 401 — that is what makes the
        // browser drop its state and bounce to the login screen.
        if (user.employment_status !== 'ACTIVE') {
            clearCookie(res);
            return res.status(401).json({
                error: STATUS_MESSAGE[user.employment_status] ?? 'This account is not active.',
                employmentStatus: user.employment_status,
            });
        }

        // SUPER_ADMIN has no organisation, so org_active is NULL for them.
        if (user.organization_id && user.org_active === false) {
            clearCookie(res);
            return res.status(401).json({ error: 'This organization has been disabled.' });
        }

        // A role change mid-session invalidates the token's claim.
        if (user.role !== payload.role) {
            clearCookie(res);
            return res.status(401).json({
                error: 'Your permissions have changed. Please sign in again.',
            });
        }

        req.user = {
            id: user.id,
            role: user.role,
            orgId: user.organization_id ?? null,
        };
        return next();
    } catch (err) {
        return next(err);
    }
};
