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

// Shared so the create and update forms cannot disagree about what a valid
// name or phone number is.
const nameRule = Joi.string().trim().min(2).max(255)
    .pattern(/^[A-Za-z][A-Za-z .'-]*$/)
    .messages({
        'string.pattern.base': 'Name may only contain letters, spaces, hyphens and apostrophes.',
        'string.min': 'Name must be at least 2 characters.',
    });

// Matches PROFILE_FIELDS.phone — a consultant's phone lives on their profile
// and is validated by the registry, so the two rules must agree.
const phoneRule = Joi.string().pattern(/^[0-9]{10}$/)
    .messages({ 'string.pattern.base': 'Phone number must be exactly 10 digits, no spaces or symbols.' })
    .allow('', null);

const emailRule = Joi.string().trim().lowercase()
    .email({ tlds: { allow: false } }).max(255);

export const createUserSchema = Joi.object({
    name: nameRule.required(),
    email: emailRule.required(),
    phone: phoneRule,
    role: Joi.string().valid('RECRUITER', 'CONSULTANT').required(),
    password: Joi.string().min(8).max(200).required()
        .messages({ 'string.min': 'Password must be at least 8 characters.' }),
});

// No isActive here — employment state changes go through the dedicated
// suspend / reactivate / terminate endpoints, which enforce the transition
// rules (terminated is permanent) and record who did it and why.
export const updateUserSchema = Joi.object({
    name: nameRule,
    phone: phoneRule,
}).min(1);

export const lifecycleSchema = Joi.object({
    reason: Joi.string().max(500).allow('', null),
});

export const resetPasswordSchema = Joi.object({
    newPassword: Joi.string().min(8).max(200).required()
        .messages({ 'string.min': 'Password must be at least 8 characters.' }),
});

export const assignSchema = Joi.object({
    consultantId: Joi.string().guid({ version: 'uuidv4' }).required(),
    recruiterId: Joi.string().guid({ version: 'uuidv4' }).required(),
    reason: Joi.string().max(255).allow('', null),
});

// Bulk edit from the recruiter's end: the FULL roster this recruiter should
// own once saved. Absent ids mean "release", not "leave alone" — the endpoint
// reconciles against what is stored rather than taking a list of deltas.
export const recruiterRosterSchema = Joi.object({
    consultantIds: Joi.array()
        .items(Joi.string().guid({ version: 'uuidv4' }))
        .max(500)
        .required(),
    reason: Joi.string().max(255).allow('', null),
});

// The consultant's end. `null` unassigns — the database permits a consultant
// at most one current recruiter, so this is single-valued by definition.
export const consultantRecruiterSchema = Joi.object({
    recruiterId: Joi.string().guid({ version: 'uuidv4' }).allow(null).required(),
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

        // Terminated and suspended people are hidden unless explicitly asked
        // for — day to day an admin wants the current roster, not the history.
        const includeInactive = req.query.includeInactive === 'true';

        const { rows } = await query(
            `SELECT COUNT(*) OVER () AS total_count,
                    u.id, u.name, u.email, u.role, u.is_active,
                    u.employment_status, u.suspended_at, u.suspend_reason,
                    u.terminated_at, u.termination_reason,
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
                AND ($4::boolean OR u.employment_status = 'ACTIVE')
              ORDER BY
                CASE u.employment_status
                  WHEN 'ACTIVE' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END,
                u.role, u.name
              LIMIT $5 OFFSET $6`,
            [orgId, roleFilter, search, includeInactive, paging.limit, paging.offset],
        );

        // Tab badges must count the whole organisation, not the current page.
        const { rows: counts } = await query(
            `SELECT u.role,
                    COUNT(*) FILTER (WHERE u.employment_status = 'ACTIVE')::int AS active,
                    COUNT(*)::int AS total
               FROM users u
              WHERE u.organization_id = $1
              GROUP BY u.role`,
            [orgId],
        );

        const result = pageResult(rows, paging);
        return res.json({
            users: result.data,
            page: result.page,
            counts: Object.fromEntries(
                counts.map((c) => [c.role, { active: c.active, total: c.total }]),
            ),
        });
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

        const { name, phone } = req.body;
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
                    SET name = COALESCE($1, name), updated_by = $2
                  WHERE id = $3 AND organization_id = $4`,
                [name ?? null, req.user.id, old.id, orgId],
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
        ]);

        logAction({
            orgId, module: 'users', action: 'Updated User',
            entityType: 'User', entityId: old.id, entityName: name ?? old.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description, ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'User updated.' });
    } catch (err) {
        return next(err);
    }
};

/* ────────────────── employment lifecycle ─────────────────────────── */

/**
 * POST /api/management/users/:id/suspend — ORG_ADMIN only.
 *
 * Removes portal access while keeping the person on the books. Reversible.
 * Use for leave, an investigation, or a temporary hold.
 */
export const suspendUser = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { target, error } = await resolveManageableUser(
            req.user, req.params.id, { allowSelf: false },
        );
        if (error) return res.status(error.status).json({ error: error.message });

        if (target.employment_status === 'TERMINATED') {
            return res.status(409).json({ error: 'This person has already been terminated.' });
        }
        if (target.employment_status === 'SUSPENDED') {
            return res.status(409).json({ error: 'This person is already suspended.' });
        }

        await query(
            `UPDATE users
                SET employment_status = 'SUSPENDED',
                    suspended_at = now(), suspended_by = $1, suspend_reason = $2,
                    updated_by = $1
              WHERE id = $3 AND organization_id = $4`,
            [req.user.id, req.body.reason || null, target.id, orgId],
        );

        logAction({
            orgId, module: 'users', action: 'Suspended User',
            entityType: 'User', entityId: target.id, entityName: target.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Suspended access for ${target.role.toLowerCase()} "${target.name}"`
                + (req.body.reason ? ` — ${req.body.reason}` : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Access suspended.', employmentStatus: 'SUSPENDED' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/users/:id/reactivate — ORG_ADMIN only.
 * Only a SUSPENDED account can come back. Termination is final.
 */
export const reactivateUser = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { target, error } = await resolveManageableUser(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        if (target.employment_status === 'TERMINATED') {
            return res.status(409).json({
                error: 'A terminated person cannot be reactivated. Create a new account instead.',
            });
        }
        if (target.employment_status === 'ACTIVE') {
            return res.status(409).json({ error: 'This person is already active.' });
        }

        await query(
            `UPDATE users
                SET employment_status = 'ACTIVE',
                    suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL,
                    updated_by = $1
              WHERE id = $2 AND organization_id = $3`,
            [req.user.id, target.id, orgId],
        );

        logAction({
            orgId, module: 'users', action: 'Reactivated User',
            entityType: 'User', entityId: target.id, entityName: target.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Restored access for ${target.role.toLowerCase()} "${target.name}"`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Access restored.', employmentStatus: 'ACTIVE' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/users/:id/terminate — ORG_ADMIN only.
 *
 * PERMANENT. The person has resigned or been dismissed: no portal access ever
 * again, and no longer an employee of this organisation. The record is kept —
 * never deleted — so history, audit entries and past work stay attributable.
 *
 * Any current assignment is closed in the same transaction. A terminated
 * recruiter must not keep holding consultants, and a terminated consultant
 * should not stay on a recruiter's list.
 */
export const terminateUser = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { target, error } = await resolveManageableUser(
            req.user, req.params.id, { allowSelf: false },
        );
        if (error) return res.status(error.status).json({ error: error.message });

        if (target.employment_status === 'TERMINATED') {
            return res.status(409).json({ error: 'This person is already terminated.' });
        }

        const {
            releasedAssignments, cancelledRequests, pausedCriteria,
        } = await withTransaction(async (client) => {
            await client.query(
                `UPDATE users
                    SET employment_status = 'TERMINATED',
                        terminated_at = now(), terminated_by = $1,
                        termination_reason = $2, updated_by = $1
                  WHERE id = $3 AND organization_id = $4`,
                [req.user.id, req.body.reason || null, target.id, orgId],
            );

            const { rowCount: released } = await client.query(
                `UPDATE assignments
                    SET effective_to = CURRENT_DATE, updated_by = $1
                  WHERE organization_id = $2
                    AND effective_to IS NULL
                    AND (consultant_id = $3 OR recruiter_id = $3)`,
                [req.user.id, orgId, target.id],
            );

            // C-2. A pending request from someone who no longer works here is
            // not decidable: approving pushes values live for a non-employee,
            // rejecting sends a note to an account that can never be read.
            // Cancel it in the SAME transaction as the termination, so the
            // queue can never disagree with the person's employment state.
            await client.query(
                `UPDATE profile_change_request_fields
                    SET status = 'CANCELLED'
                  WHERE status = 'PENDING'
                    AND change_request_id IN (
                        SELECT id FROM profile_change_requests
                         WHERE consultant_id = $1 AND organization_id = $2
                           AND status = 'PENDING')`,
                [target.id, orgId],
            );
            const { rowCount: cancelled } = await client.query(
                `UPDATE profile_change_requests
                    SET status = 'CANCELLED',
                        reviewed_by = $1, reviewed_at = now(), updated_by = $1,
                        review_note = 'Cancelled automatically — the consultant was terminated.'
                  WHERE consultant_id = $2 AND organization_id = $3
                    AND status = 'PENDING'`,
                [req.user.id, target.id, orgId],
            );

            // H-1. Search criteria are the input to job discovery. Left active,
            // Phase 5 would keep finding jobs — and Phase 6 tailoring resumes —
            // for someone who no longer works here. Same transaction as the
            // termination, for the same reason the change request is cancelled
            // in it: the two states must never disagree.
            //
            // Deliberately NOT done on suspend. Suspension is reversible and the
            // person is still an employee; auto-pausing would then need an
            // auto-resume, and silently resuming discovery on reactivation is a
            // decision the admin should make, not one to infer.
            const { rowCount: paused } = await client.query(
                `UPDATE search_criteria
                    SET is_active = FALSE, paused_at = now(), paused_by = $1, updated_by = $1
                  WHERE organization_id = $2 AND consultant_id = $3 AND is_active`,
                [req.user.id, orgId, target.id],
            );

            return {
                releasedAssignments: released,
                cancelledRequests: cancelled,
                pausedCriteria: paused,
            };
        });

        logAction({
            orgId, module: 'users', action: 'Terminated User',
            entityType: 'User', entityId: target.id, entityName: target.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Terminated ${target.role.toLowerCase()} "${target.name}"`
                + (req.body.reason ? ` — ${req.body.reason}` : '')
                + (releasedAssignments ? ` (${releasedAssignments} assignment(s) released)` : '')
                + (cancelledRequests ? ' (pending profile changes cancelled)' : '')
                + (pausedCriteria ? ' (job discovery paused)' : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            message: 'Terminated.',
            employmentStatus: 'TERMINATED',
            releasedAssignments,
            cancelledRequests,
            pausedCriteria,
        });
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

/* ── bulk assignment editing ───────────────────────────────────────────
 *
 * The single POST above moves one consultant at a time. These two endpoints
 * let an admin edit the links from either end in one go — the recruiter's
 * whole roster, or one consultant's recruiter.
 *
 * Both take the DESIRED END STATE, not a list of deltas, and reconcile it
 * against what is stored. A stale browser tab therefore cannot double-add or
 * remove someone twice: replaying the same payload is a no-op.
 */

/** One user of an expected role, within the org. `null` if it is not them. */
const loadAssignableUser = async (orgId, userId, role) => {
    const { rows } = await query(
        `SELECT id, name, employment_status
           FROM users
          WHERE id = $1 AND organization_id = $2 AND role = $3`,
        [userId, orgId, role],
    );
    return rows[0] ?? null;
};

/** id -> name, for the org users named in an audit description. */
const namesById = async (orgId, ids) => {
    if (ids.length === 0) return new Map();
    const { rows } = await query(
        'SELECT id, name FROM users WHERE organization_id = $1 AND id = ANY($2::text[])',
        [orgId, ids],
    );
    return new Map(rows.map((r) => [r.id, r.name]));
};

/**
 * PUT /api/management/assignments/recruiter/:recruiterId — ORG_ADMIN only.
 *
 * Body `{ consultantIds }` is the complete roster this recruiter should hold.
 * Consultants in the list but not currently theirs are added — taking them off
 * whichever recruiter had them. Consultants currently theirs but absent from
 * the list are released and left unassigned.
 */
export const setRecruiterRoster = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { recruiterId } = req.params;
        const { reason } = req.body;

        // A repeated id must not open two rows for the same person.
        const wanted = [...new Set(req.body.consultantIds)];

        const recruiter = await loadAssignableUser(orgId, recruiterId, 'RECRUITER');
        if (!recruiter) {
            return res.status(404).json({ error: 'Recruiter not found in your organization.' });
        }
        if (recruiter.employment_status !== 'ACTIVE') {
            return res.status(409).json({
                error: 'Cannot assign consultants to a recruiter who is not active.',
            });
        }

        // Every proposed consultant must be a real, active consultant here.
        // Checked as a set before anything is written, so a single bad id
        // fails the whole save rather than half-applying it.
        const { rows: candidates } = wanted.length
            ? await query(
                `SELECT id, name, employment_status
                   FROM users
                  WHERE organization_id = $1 AND role = 'CONSULTANT'
                    AND id = ANY($2::text[])`,
                [orgId, wanted],
            )
            : { rows: [] };

        const byId = new Map(candidates.map((c) => [c.id, c]));
        if (wanted.some((id) => !byId.has(id))) {
            return res.status(404).json({
                error: 'One or more selected consultants were not found in your organization.',
            });
        }
        const inactive = candidates.filter((c) => c.employment_status !== 'ACTIVE');
        if (inactive.length > 0) {
            return res.status(409).json({
                error: `Cannot assign an inactive consultant: ${inactive.map((c) => c.name).join(', ')}.`,
            });
        }

        const currentIds = await getAssignedConsultantIds(orgId, recruiterId);
        const toAdd = wanted.filter((id) => !currentIds.includes(id));
        const toRemove = currentIds.filter((id) => !wanted.includes(id));

        if (toAdd.length === 0 && toRemove.length === 0) {
            return res.json({ message: 'No changes.', added: 0, removed: 0, moved: 0 });
        }

        // Who the added consultants are being taken FROM — read before the
        // write, since the write is what erases it. Used for the audit line.
        const { rows: priorRows } = toAdd.length
            ? await query(
                `SELECT a.consultant_id, r.name AS recruiter_name
                   FROM assignments a
                   JOIN users r ON r.id = a.recruiter_id
                  WHERE a.organization_id = $1
                    AND a.effective_to IS NULL
                    AND a.consultant_id = ANY($2::text[])`,
                [orgId, toAdd],
            )
            : { rows: [] };
        const priorRecruiter = new Map(priorRows.map((r) => [r.consultant_id, r.recruiter_name]));

        const nameOf = await namesById(orgId, [...new Set([...toAdd, ...toRemove])]);

        await withTransaction(async (client) => {
            if (toRemove.length > 0) {
                await client.query(
                    `UPDATE assignments
                        SET effective_to = CURRENT_DATE, updated_by = $1
                      WHERE organization_id = $2
                        AND recruiter_id    = $3
                        AND effective_to IS NULL
                        AND consultant_id = ANY($4::text[])`,
                    [req.user.id, orgId, recruiterId, toRemove],
                );
            }

            if (toAdd.length > 0) {
                // Close whatever they had first — for a move this belongs to a
                // different recruiter, and the partial unique index would
                // reject the insert otherwise.
                await client.query(
                    `UPDATE assignments
                        SET effective_to = CURRENT_DATE, updated_by = $1
                      WHERE organization_id = $2
                        AND effective_to IS NULL
                        AND consultant_id = ANY($3::text[])`,
                    [req.user.id, orgId, toAdd],
                );

                for (const consultantId of toAdd) {
                    await client.query(
                        `INSERT INTO assignments
                            (id, organization_id, consultant_id, recruiter_id,
                             effective_from, reason, created_by)
                         VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6)`,
                        [uuidv4(), orgId, consultantId, recruiterId, reason || null, req.user.id],
                    );
                }
            }
        });

        const label = (id) => nameOf.get(id) ?? id;
        const parts = [];
        if (toAdd.length > 0) {
            parts.push('added ' + toAdd.map((id) => {
                const from = priorRecruiter.get(id);
                return from ? `${label(id)} (moved from ${from})` : label(id);
            }).join(', '));
        }
        if (toRemove.length > 0) {
            parts.push(`released ${toRemove.map(label).join(', ')}`);
        }

        logAction({
            orgId, module: 'assignments', action: 'Updated Assignment',
            entityType: 'Assignment', entityId: recruiterId, entityName: recruiter.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Updated recruiter "${recruiter.name}" roster — ${parts.join('; ')}`
                + (reason ? ` — ${reason}` : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            message: 'Assignments updated.',
            added: toAdd.length,
            removed: toRemove.length,
            moved: priorRecruiter.size,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * PUT /api/management/assignments/consultant/:consultantId — ORG_ADMIN only.
 *
 * Body `{ recruiterId }`, or `{ recruiterId: null }` to leave them unassigned.
 * Single-valued because `uq_assignments_one_current` allows a consultant only
 * one open assignment row.
 */
export const setConsultantRecruiter = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { consultantId } = req.params;
        const { recruiterId, reason } = req.body;

        const consultant = await loadAssignableUser(orgId, consultantId, 'CONSULTANT');
        if (!consultant) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }
        if (consultant.employment_status !== 'ACTIVE') {
            return res.status(409).json({
                error: 'Cannot change the assignment of a consultant who is not active.',
            });
        }

        let recruiter = null;
        if (recruiterId) {
            recruiter = await loadAssignableUser(orgId, recruiterId, 'RECRUITER');
            if (!recruiter) {
                return res.status(404).json({ error: 'Recruiter not found in your organization.' });
            }
            if (recruiter.employment_status !== 'ACTIVE') {
                return res.status(409).json({
                    error: 'Cannot assign a consultant to a recruiter who is not active.',
                });
            }
        }

        const { rows: cur } = await query(
            `SELECT a.recruiter_id, r.name AS recruiter_name
               FROM assignments a
               JOIN users r ON r.id = a.recruiter_id
              WHERE a.organization_id = $1
                AND a.consultant_id   = $2
                AND a.effective_to IS NULL`,
            [orgId, consultantId],
        );
        const currentId = cur[0]?.recruiter_id ?? null;

        // Idempotent: re-saving the same choice writes nothing, so a stale tab
        // cannot pad the history with zero-length rows.
        if (currentId === (recruiterId ?? null)) {
            return res.json({ message: 'No changes.', changed: false });
        }

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE assignments
                    SET effective_to = CURRENT_DATE, updated_by = $1
                  WHERE organization_id = $2
                    AND consultant_id   = $3
                    AND effective_to IS NULL`,
                [req.user.id, orgId, consultantId],
            );

            if (recruiterId) {
                await client.query(
                    `INSERT INTO assignments
                        (id, organization_id, consultant_id, recruiter_id,
                         effective_from, reason, created_by)
                     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6)`,
                    [uuidv4(), orgId, consultantId, recruiterId, reason || null, req.user.id],
                );
            }
        });

        const description = recruiter
            ? `Assigned consultant "${consultant.name}" to recruiter "${recruiter.name}"`
                + (cur[0] ? ` (moved from "${cur[0].recruiter_name}")` : '')
            : `Unassigned consultant "${consultant.name}" from recruiter "${cur[0].recruiter_name}"`;

        logAction({
            orgId, module: 'assignments', action: 'Updated Assignment',
            entityType: 'Assignment', entityId: consultantId, entityName: consultant.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: description + (reason ? ` — ${reason}` : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Assignment updated.', changed: true });
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
               COUNT(*) FILTER (WHERE employment_status = 'SUSPENDED')::int   AS suspended_users,
               COUNT(*) FILTER (WHERE employment_status = 'TERMINATED')::int  AS terminated_users
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
