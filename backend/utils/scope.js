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
