/**
 * Layer 1 — role guards.
 *
 * These check WHO you are, not WHAT you may touch. Tenant scoping (Layer 2,
 * in every query) is what actually prevents cross-organisation access. A route
 * that passes a role guard but forgets `WHERE organization_id = $1` is still
 * a data leak.
 *
 * Rule: DELETE / disable routes are ORG_ADMIN only, even where read and write
 * are broader.
 */

const deny = (res, message = 'Access denied.') =>
    res.status(403).json({ error: message });

const requireRoles = (roles, message) => (req, res, next) => {
    if (!req.user?.role) return deny(res, 'Not authenticated.');
    return roles.includes(req.user.role) ? next() : deny(res, message);
};

/** Platform owner. No organisation. Manages tenants only. */
export const isSuperAdmin = requireRoles(
    ['SUPER_ADMIN'],
    'Access denied. SUPER_ADMIN only.',
);

/** Full control within one organisation. */
export const isOrgAdmin = requireRoles(
    ['ORG_ADMIN'],
    'Access denied. ORG_ADMIN only.',
);

/** Operational staff: org admin + recruiters. */
export const isManagement = requireRoles(
    ['ORG_ADMIN', 'RECRUITER'],
    'Access denied. Management roles only.',
);

/** Self-service portal. Own records only. */
export const isConsultant = requireRoles(
    ['CONSULTANT'],
    'Access denied. CONSULTANT only.',
);

/** Narrow combo, kept explicit rather than inlined at call sites. */
export const isOrgAdminOrRecruiter = requireRoles(
    ['ORG_ADMIN', 'RECRUITER'],
    'Access denied.',
);

/**
 * Any tenant user (i.e. everyone except SUPER_ADMIN, who has no orgId).
 * Used by shared endpoints such as /api/lookups.
 */
export const isTenantUser = (req, res, next) => {
    if (!req.user?.role) return deny(res, 'Not authenticated.');
    if (req.user.role === 'SUPER_ADMIN') {
        return deny(res, 'Access denied. This endpoint is organisation-scoped.');
    }
    if (!req.user.orgId) {
        return deny(res, 'Access denied. No organisation on this account.');
    }
    return next();
};
