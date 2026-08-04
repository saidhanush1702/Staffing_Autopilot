/**
 * Layer 2 helpers — tenant and assignment scoping.
 *
 * This is the layer that actually stops cross-tenant access. The role guard
 * only proves someone is a RECRUITER; this proves the rows they touch belong
 * to their organisation and, for recruiters, to their assigned consultants.
 */
import { query } from '../db.js';

/**
 * IDs of consultants currently assigned to a recruiter, within one org.
 * Returns [] when the recruiter has no assignments — callers must treat an
 * empty list as "sees nothing", never as "no filter".
 */
export const getAssignedConsultantIds = async (orgId, recruiterId) => {
    const { rows } = await query(
        `SELECT consultant_id
           FROM assignments
          WHERE organization_id = $1
            AND recruiter_id    = $2
            AND effective_to IS NULL`,
        [orgId, recruiterId],
    );
    return rows.map((r) => r.consultant_id);
};

/**
 * Can this user read this consultant's records?
 *   ORG_ADMIN  — any consultant in their own organisation
 *   RECRUITER  — only currently-assigned consultants
 *   CONSULTANT — only themselves
 */
export const canAccessConsultant = async (user, consultantId) => {
    if (user.role === 'CONSULTANT') return user.id === consultantId;

    if (user.role === 'ORG_ADMIN') {
        const { rows } = await query(
            `SELECT 1 FROM users
              WHERE id = $1 AND organization_id = $2 AND role = 'CONSULTANT'`,
            [consultantId, user.orgId],
        );
        return rows.length > 0;
    }

    if (user.role === 'RECRUITER') {
        const { rows } = await query(
            `SELECT 1 FROM assignments
              WHERE organization_id = $1
                AND recruiter_id    = $2
                AND consultant_id   = $3
                AND effective_to IS NULL`,
            [user.orgId, user.id, consultantId],
        );
        return rows.length > 0;
    }

    return false;
};

/**
 * Confirm a user row belongs to the caller's organisation.
 * Use before any UPDATE/DELETE that takes an id from the URL.
 */
export const assertSameOrg = async (orgId, userId) => {
    const { rows } = await query(
        'SELECT id, name, role FROM users WHERE id = $1 AND organization_id = $2',
        [userId, orgId],
    );
    return rows[0] ?? null;
};

/**
 * Load a user for a management action, applying BOTH rules that every
 * user-management endpoint needs:
 *
 *   1. the target must belong to the actor's organisation
 *   2. an ORG_ADMIN may not act on ANOTHER ORG_ADMIN
 *
 * Rule 2 exists because ORG_ADMIN can reveal and reset passwords. Without it,
 * admin A could read or overwrite admin B's credentials and sign in as them —
 * privilege escalation inside a tenant, and it would launder every subsequent
 * action into B's name in the audit log.
 *
 * Acting on YOURSELF is allowed (you already know your own password); pass
 * `{ allowSelf: false }` for destructive actions such as disabling an account.
 *
 * Use this instead of hand-writing the checks. Duplicated authorisation rules
 * get forgotten — that is exactly how the reveal/reset endpoints originally
 * shipped without rule 2.
 *
 * @returns {{ target?: object, error?: { status: number, message: string } }}
 *
 * NOTE: the row includes password material so callers do not need a second
 * query. Never serialise `target` straight to a response.
 */
export const resolveManageableUser = async (actor, targetId, { allowSelf = true } = {}) => {
    const { rows } = await query(
        `SELECT id, name, email, phone, role, is_active, employment_status,
                password_enc, password_iv, password_tag
           FROM users
          WHERE id = $1 AND organization_id = $2`,
        [targetId, actor.orgId],
    );
    const target = rows[0];

    // Returns 404 rather than 403 so it does not confirm the user exists
    // elsewhere in the platform.
    if (!target) {
        return { error: { status: 404, message: 'User not found in your organization.' } };
    }

    if (!allowSelf && target.id === actor.id) {
        return { error: { status: 400, message: 'You cannot perform this action on your own account.' } };
    }

    if (target.role === 'ORG_ADMIN' && target.id !== actor.id) {
        return { error: { status: 403, message: 'Cannot act on another organization admin.' } };
    }

    return { target };
};
