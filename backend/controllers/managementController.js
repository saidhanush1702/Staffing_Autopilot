/**
 * ORG_ADMIN + RECRUITER — everything inside one organisation.
 *
 * Every query here carries `organization_id = $1` sourced from req.user.orgId.
 * Recruiters are narrowed further to their currently-assigned consultants.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import {
    getAssignedConsultantIds, assertSameOrg, resolveManageableUser,
} from '../utils/scope.js';
import { readPaging, pageResult } from '../utils/pagination.js';
import { logAction, describeChanges } from './auditLogController.js';

export const createUserSchema = Joi.object({
    name: Joi.string().trim().min(2).max(255).required(),
    email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
    phone: Joi.string().max(30).allow('', null),
    role: Joi.string().valid('RECRUITER', 'CONSULTANT').required(),
    password: Joi.string().min(8).max(200).required(),
});

export const updateUserSchema = Joi.object({
    name: Joi.string().trim().min(2).max(255),
    phone: Joi.string().max(30).allow('', null),
    isActive: Joi.boolean(),
}).min(1);

export const resetPasswordSchema = Joi.object({
    newPassword: Joi.string().min(8).max(200).required()
        .messages({ 'string.min': 'Password must be at least 8 characters.' }),
});

export const assignSchema = Joi.object({
    consultantId: Joi.string().guid({ version: 'uuidv4' }).required(),
    recruiterId: Joi.string().guid({ version: 'uuidv4' }).required(),
    reason: Joi.string().max(255).allow('', null),
});

/* ────────────────────────────── users ────────────────────────────── */

/**
 * GET /api/management/users?role=
 * ORG_ADMIN sees every user in the org.
 * RECRUITER sees only their assigned consultants.
 */
export const listUsers = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;
        const roleFilter = req.query.role ?? null;

        if (role === 'RECRUITER') {
            const assigned = await getAssignedConsultantIds(orgId, userId);
            if (assigned.length === 0) return res.json({ users: [] });

            const { rows } = await query(
                `SELECT id, name, email, phone, role, is_active, last_login_at, created_at
                   FROM users
                  WHERE organization_id = $1
                    AND id = ANY($2::char(36)[])
                  ORDER BY name`,
                [orgId, assigned],
            );
            return res.json({ users: rows });
        }

        // COALESCE resolves the phone ownership rule from migration 011:
        // consultants own theirs on the profile, everyone else on users.
        const paging = readPaging(req);
        const search = (req.query.search ?? '').trim() || null;

        const { rows } = await query(
            `SELECT COUNT(*) OVER () AS total_count,
                    u.id, u.name, u.email, u.role, u.is_active,
                    COALESCE(p.phone, u.phone) AS phone,
                    u.last_login_at, u.created_at,
                    r.name AS recruiter_name
               FROM users u
          LEFT JOIN consultant_profiles p ON p.user_id = u.id
          LEFT JOIN assignments a
                 ON a.consultant_id = u.id AND a.effective_to IS NULL
          LEFT JOIN users r ON r.id = a.recruiter_id
              WHERE u.organization_id = $1
                AND ($2::text IS NULL OR u.role = $2)
                AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%'
                                      OR u.email ILIKE '%' || $3 || '%')
              ORDER BY u.role, u.name
              LIMIT $4 OFFSET $5`,
            [orgId, roleFilter, search, paging.limit, paging.offset],
        );

        const result = pageResult(rows, paging);
        return res.json({ users: result.data, page: result.page });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/users — ORG_ADMIN only */
export const createUser = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { name, email, phone, role, password } = req.body;

        const dup = await query('SELECT 1 FROM users WHERE email = $1', [email]);
        if (dup.rows.length) {
            return res.status(409).json({ error: `Email "${email}" is already registered.` });
        }

        const id = uuidv4();
        const { enc, iv, tag } = encryptPassword(password);

        const isConsultantRole = role === 'CONSULTANT';

        await withTransaction(async (client) => {
            // Phone ownership (migration 011): consultants keep theirs on the
            // profile only, so users.phone stays NULL for them.
            await client.query(
                `INSERT INTO users
                    (id, organization_id, name, email, phone, role,
                     password_enc, password_iv, password_tag, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [id, orgId, name, email,
                    isConsultantRole ? null : (phone || null),
                    role, enc, iv, tag, req.user.id],
            );

            // A consultant always has a profile row from the moment they exist,
            // so no read path anywhere has to handle a missing profile.
            if (isConsultantRole) {
                await client.query(
                    `INSERT INTO consultant_profiles
                        (user_id, organization_id, phone, daily_cap, created_by)
                     VALUES ($1,$2,$3,5,$4)`,
                    [id, orgId, phone || null, req.user.id],
                );
            }
        });

        logAction({
            orgId, module: 'users', action: 'Added User',
            entityType: 'User', entityId: id, entityName: name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Added ${role.toLowerCase()} "${name}" (${email})`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({ message: 'User created.', userId: id });
    } catch (err) {
        return next(err);
    }
};

/** PATCH /api/management/users/:id — ORG_ADMIN only */
export const updateUser = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        const { target: old, error } = await resolveManageableUser(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        const { name, phone, isActive } = req.body;
        const isConsultantRole = old.role === 'CONSULTANT';

        // A consultant's phone lives on their profile (migration 011), so the
        // previous value for the audit diff has to come from there too.
        let oldPhone = old.phone;
        if (isConsultantRole) {
            const { rows } = await query(
                'SELECT phone FROM consultant_profiles WHERE user_id = $1 AND organization_id = $2',
                [old.id, orgId],
            );
            oldPhone = rows[0]?.phone ?? null;
        }

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE users
                    SET name = COALESCE($1, name),
                        is_active = COALESCE($2, is_active),
                        updated_by = $3
                  WHERE id = $4 AND organization_id = $5`,
                [name ?? null, isActive ?? null, req.user.id, old.id, orgId],
            );

            if (phone !== undefined) {
                // Routed by role so there is only ever ONE stored phone.
                // ORG_ADMIN writes are direct — the approval gate exists
                // because the CONSULTANT is proposing, not because the field
                // is sensitive.
                const table = isConsultantRole ? 'consultant_profiles' : 'users';
                const key = isConsultantRole ? 'user_id' : 'id';
                await client.query(
                    `UPDATE ${table}
                        SET phone = $1, updated_by = $2
                      WHERE ${key} = $3 AND organization_id = $4`,
                    [phone || null, req.user.id, old.id, orgId],
                );
            }
        });

        const description = describeChanges('User', [
            { label: 'Name', oldVal: old.name, newVal: name ?? old.name },
            { label: 'Phone', oldVal: oldPhone, newVal: phone === undefined ? oldPhone : phone },
            { label: 'Status', oldVal: old.is_active ? 'Active' : 'Disabled',
                newVal: (isActive ?? old.is_active) ? 'Active' : 'Disabled' },
        ]);

        // Verb drives the colour in the activity log:
        // Disabled = red, Enabled = emerald, Updated = amber.
        const action = isActive === false ? 'Disabled User'
            : isActive === true && old.is_active === false ? 'Enabled User'
                : 'Updated User';

        logAction({
            orgId, module: 'users', action,
            entityType: 'User', entityId: old.id, entityName: name ?? old.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description, ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'User updated.' });
    } catch (err) {
        return next(err);
    }
};

/**
 * DELETE /api/management/users/:id — ORG_ADMIN only.
 * Soft disable, per the is_active convention. Never a row delete.
 */
export const deactivateUser = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        // allowSelf: false — disabling your own account would lock you out.
        const { target, error } = await resolveManageableUser(
            req.user, req.params.id, { allowSelf: false },
        );
        if (error) return res.status(error.status).json({ error: error.message });

        await query(
            'UPDATE users SET is_active = FALSE, updated_by = $1 WHERE id = $2 AND organization_id = $3',
            [req.user.id, target.id, orgId],
        );

        logAction({
            orgId, module: 'users', action: 'Disabled User',
            entityType: 'User', entityId: target.id, entityName: target.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Disabled ${target.role.toLowerCase()} "${target.name}"`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'User disabled.' });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/users/:id/password — ORG_ADMIN only.
 *
 * Decrypts and returns one user's password. Possible only because passwords
 * are stored reversibly (AES-256-GCM) rather than hashed — see
 * backend/utils/crypto.js.
 *
 * Design decisions that keep this defensible:
 *   - ONE user per request, never bundled into the user list. If passwords
 *     rode along in GET /users, every page load would ship every password
 *     over the wire and into browser memory, devtools, and any proxy log.
 *   - Org-scoped: an admin can only ever reach their own organisation.
 *   - SUPER_ADMIN is unreachable (they have organization_id = NULL, so the
 *     org filter excludes them).
 *   - Every reveal writes an audit row. If passwords are visible, knowing
 *     WHO looked and WHEN is the control that makes it accountable.
 */
export const revealUserPassword = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        // Enforces org scope AND the peer-admin rule. Without the second
        // check, one org admin could read another's password and sign in as
        // them — see utils/scope.js.
        const { target, error } = await resolveManageableUser(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        let password;
        try {
            password = decryptPassword({
                enc: target.password_enc,
                iv: target.password_iv,
                tag: target.password_tag,
            });
        } catch {
            // Wrong PASSWORD_ENC_KEY, or the row predates the current key.
            return res.status(409).json({
                error: 'Password could not be decrypted. The encryption key may have changed since this user was created.',
            });
        }

        logAction({
            orgId, module: 'users', action: 'Viewed Password',
            entityType: 'User', entityId: target.id, entityName: target.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Viewed the password of ${target.role.toLowerCase()} "${target.name}" (${target.email})`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            userId: target.id,
            name: target.name,
            email: target.email,
            password,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/users/:id/reset-password — ORG_ADMIN only.
 * Sets a new password for a user in the same organisation.
 */
export const resetUserPassword = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        // Same guard as the reveal endpoint: resetting a peer admin's password
        // is an account takeover, not an administrative convenience.
        const { target, error } = await resolveManageableUser(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        const { enc, iv, tag } = encryptPassword(req.body.newPassword);
        await query(
            `UPDATE users
                SET password_enc = $1, password_iv = $2, password_tag = $3, updated_by = $4
              WHERE id = $5 AND organization_id = $6`,
            [enc, iv, tag, req.user.id, target.id, orgId],
        );

        logAction({
            orgId, module: 'users', action: 'Updated Password',
            entityType: 'User', entityId: target.id, entityName: target.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Reset the password of ${target.role.toLowerCase()} "${target.name}"`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Password reset.' });
    } catch (err) {
        return next(err);
    }
};

/* ─────────────────────────── assignments ─────────────────────────── */

/** GET /api/management/assignments */
export const listAssignments = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;

        const { rows } = await query(
            `SELECT a.id, a.consultant_id, a.recruiter_id,
                    a.effective_from, a.effective_to, a.reason, a.created_at,
                    c.name AS consultant_name, c.email AS consultant_email,
                    r.name AS recruiter_name,  r.email AS recruiter_email
               FROM assignments a
               JOIN users c ON c.id = a.consultant_id
               JOIN users r ON r.id = a.recruiter_id
              WHERE a.organization_id = $1
                AND ($2::text IS NULL OR a.recruiter_id = $2)
              ORDER BY a.effective_to NULLS FIRST, a.created_at DESC`,
            [orgId, role === 'RECRUITER' ? userId : null],
        );

        return res.json({ assignments: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/assignments — ORG_ADMIN only.
 * Closes any current assignment for the consultant, then opens a new one.
 * History is never overwritten.
 */
export const assignConsultant = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { consultantId, recruiterId, reason } = req.body;

        const consultant = await assertSameOrg(orgId, consultantId);
        const recruiter = await assertSameOrg(orgId, recruiterId);

        if (!consultant || consultant.role !== 'CONSULTANT') {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }
        if (!recruiter || recruiter.role !== 'RECRUITER') {
            return res.status(404).json({ error: 'Recruiter not found in your organization.' });
        }

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE assignments
                    SET effective_to = CURRENT_DATE, updated_by = $1
                  WHERE organization_id = $2 AND consultant_id = $3 AND effective_to IS NULL`,
                [req.user.id, orgId, consultantId],
            );
            await client.query(
                `INSERT INTO assignments
                    (id, organization_id, consultant_id, recruiter_id, effective_from, reason, created_by)
                 VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6)`,
                [uuidv4(), orgId, consultantId, recruiterId, reason || null, req.user.id],
            );
        });

        logAction({
            orgId, module: 'assignments', action: 'Updated Assignment',
            entityType: 'Assignment', entityId: consultantId, entityName: consultant.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Assigned consultant "${consultant.name}" to recruiter "${recruiter.name}"`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({ message: 'Consultant assigned.' });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/stats */
export const orgStats = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;

        if (role === 'RECRUITER') {
            const assigned = await getAssignedConsultantIds(orgId, userId);
            return res.json({
                stats: { myConsultants: assigned.length, role: 'RECRUITER' },
            });
        }

        const { rows } = await query(
            `SELECT
               COUNT(*) FILTER (WHERE role = 'RECRUITER'  AND is_active)::int AS recruiters,
               COUNT(*) FILTER (WHERE role = 'CONSULTANT' AND is_active)::int AS consultants,
               COUNT(*) FILTER (WHERE NOT is_active)::int                     AS disabled_users
             FROM users WHERE organization_id = $1`,
            [orgId],
        );

        const { rows: unassigned } = await query(
            `SELECT COUNT(*)::int AS unassigned
               FROM users u
              WHERE u.organization_id = $1 AND u.role = 'CONSULTANT' AND u.is_active
                AND NOT EXISTS (
                    SELECT 1 FROM assignments a
                     WHERE a.consultant_id = u.id AND a.effective_to IS NULL)`,
            [orgId],
        );

        return res.json({ stats: { ...rows[0], ...unassigned[0], role: 'ORG_ADMIN' } });
    } catch (err) {
        return next(err);
    }
};
