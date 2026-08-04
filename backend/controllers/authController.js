/**
 * Authentication — Phase 1 scope: login, logout, me, change-password.
 *
 * The JWT lives ONLY in an httpOnly cookie. It is never returned in the
 * response body and never stored in localStorage. The login response carries
 * display data only.
 */
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { query } from '../db.js';
import { verifyPassword, encryptPassword } from '../utils/crypto.js';
import { logAction } from './auditLogController.js';

const COOKIE_NAME = 'token';
const ONE_DAY_MS = 86_400_000;

const cookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: ONE_DAY_MS,
    path: '/',
});

// tlds:{allow:false} because Joi otherwise validates against a fixed TLD list,
// which rejects internal domains such as .local, .internal and .test.
export const loginSchema = Joi.object({
    email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
    password: Joi.string().min(1).max(200).required(),
});

export const changePasswordSchema = Joi.object({
    currentPassword: Joi.string().min(1).max(200).required(),
    newPassword: Joi.string().min(8).max(200).required()
        .messages({ 'string.min': 'New password must be at least 8 characters.' }),
});

/**
 * Per-ACCOUNT lockout.
 *
 * Counts recent failures for one email. Keyed on the account rather than the
 * IP because an office shares a single NAT'd address — an IP-keyed lock takes
 * out every colleague, including the admin who would undo it, while doing
 * little against a distributed attack on one account.
 *
 * Backed by a table rather than memory so a restart does not reset an
 * attacker's counter.
 */
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES ?? 15);

const recordAttempt = (email, req, succeeded) =>
    query(
        `INSERT INTO login_attempts (email, ip_address, user_agent, succeeded)
         VALUES ($1, $2, $3, $4)`,
        [email, req.ip ?? null, (req.get('user-agent') ?? '').slice(0, 255), succeeded],
    ).catch((err) => console.error('login_attempts write failed:', err.message));

/** @returns {{ locked: boolean, minutesLeft?: number }} */
const checkLockout = async (email) => {
    // Failures since the last SUCCESSFUL login — a correct password clears the
    // counter, so an ordinary user who mistypes then succeeds starts fresh.
    const { rows } = await query(
        `SELECT COUNT(*)::int AS failures, MAX(attempted_at) AS last_failure
           FROM login_attempts
          WHERE email = $1
            AND succeeded = FALSE
            AND attempted_at > now() - ($2 || ' minutes')::interval
            AND attempted_at > COALESCE(
                (SELECT MAX(attempted_at) FROM login_attempts
                  WHERE email = $1 AND succeeded = TRUE),
                '-infinity'::timestamptz)`,
        [email, String(LOCKOUT_MINUTES)],
    );

    const { failures, last_failure: lastFailure } = rows[0];
    if (failures < MAX_ATTEMPTS) return { locked: false };

    const unlocksAt = new Date(new Date(lastFailure).getTime() + LOCKOUT_MINUTES * 60_000);
    const minutesLeft = Math.max(Math.ceil((unlocksAt - Date.now()) / 60_000), 1);
    return { locked: true, minutesLeft };
};

/** POST /api/auth/login */
export const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const lock = await checkLockout(email);
        if (lock.locked) {
            return res.status(429).json({
                error: `Too many failed attempts. Try again in ${lock.minutesLeft} minute${lock.minutesLeft === 1 ? '' : 's'}.`,
            });
        }

        const { rows } = await query(
            `SELECT u.id, u.name, u.email, u.role, u.organization_id,
                    u.employment_status,
                    u.password_enc, u.password_iv, u.password_tag,
                    o.name AS organization_name, o.is_active AS org_active
               FROM users u
          LEFT JOIN organizations o ON o.id = u.organization_id
              WHERE u.email = $1`,
            [email],
        );

        const user = rows[0];

        // Identical response for "no such user" and "wrong password" so the
        // endpoint cannot be used to enumerate accounts.
        if (!user || !verifyPassword(password, user)) {
            await recordAttempt(email, req, false);
            const after = await checkLockout(email);
            return res.status(401).json({
                error: 'Invalid email or password.',
                ...(after.locked
                    ? { error: `Too many failed attempts. Try again in ${after.minutesLeft} minutes.` }
                    : {}),
            });
        }

        if (user.employment_status === 'TERMINATED') {
            await recordAttempt(email, req, false);
            return res.status(403).json({ error: 'This account has been terminated.' });
        }
        if (user.employment_status === 'SUSPENDED') {
            await recordAttempt(email, req, false);
            return res.status(403).json({
                error: 'Your access has been suspended. Contact your organization admin.',
            });
        }
        if (user.role !== 'SUPER_ADMIN' && user.org_active === false) {
            await recordAttempt(email, req, false);
            return res.status(403).json({ error: 'This organization has been disabled.' });
        }

        await recordAttempt(email, req, true);

        const token = jwt.sign(
            { id: user.id, role: user.role, orgId: user.organization_id },
            process.env.JWT_SECRET,
            { expiresIn: '1d' },
        );

        res.cookie(COOKIE_NAME, token, cookieOptions());

        await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

        logAction({
            orgId: user.organization_id,
            module: 'auth',
            action: 'Signed In',
            entityType: 'User',
            entityId: user.id,
            entityName: user.name,
            performedBy: user.id,
            performedByRole: user.role,
            description: `${user.name} signed in`,
            ipAddress: req.ip,
        }).catch(() => {});

        // Display data only — no token, no password material.
        return res.json({
            name: user.name,
            email: user.email,
            role: user.role,
            orgId: user.organization_id,
            organizationName: user.organization_name ?? null,
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/auth/logout */
export const logout = (req, res) => {
    res.cookie(COOKIE_NAME, '', {
        ...cookieOptions(),
        expires: new Date(0),
        maxAge: undefined,
    });
    return res.json({ message: 'Signed out.' });
};

/**
 * GET /api/auth/me
 * Rehydrates the client after a page refresh. The cookie is the source of
 * truth — localStorage only ever holds a display hint.
 */
export const me = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT u.id, u.name, u.email, u.role, u.organization_id, u.is_active,
                    o.name AS organization_name
               FROM users u
          LEFT JOIN organizations o ON o.id = u.organization_id
              WHERE u.id = $1`,
            [req.user.id],
        );

        const user = rows[0];
        if (!user || !user.is_active) {
            res.cookie(COOKIE_NAME, '', { ...cookieOptions(), expires: new Date(0), maxAge: undefined });
            return res.status(401).json({ error: 'Account is no longer active.' });
        }

        return res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            orgId: user.organization_id,
            organizationName: user.organization_name ?? null,
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/auth/change-password */
export const changePassword = async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body;

        const { rows } = await query(
            'SELECT id, name, role, organization_id, password_enc, password_iv, password_tag FROM users WHERE id = $1',
            [req.user.id],
        );
        const user = rows[0];

        if (!user || !verifyPassword(currentPassword, user)) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const { enc, iv, tag } = encryptPassword(newPassword);
        await query(
            `UPDATE users
                SET password_enc = $1, password_iv = $2, password_tag = $3, updated_by = $4
              WHERE id = $4`,
            [enc, iv, tag, user.id],
        );

        logAction({
            orgId: user.organization_id,
            module: 'auth',
            action: 'Updated Password',
            entityType: 'User',
            entityId: user.id,
            entityName: user.name,
            performedBy: user.id,
            performedByRole: user.role,
            description: `${user.name} changed their password`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Password updated.' });
    } catch (err) {
        return next(err);
    }
};
