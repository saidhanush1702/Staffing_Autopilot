/**
 * Audit log — every module writes here.
 *
 * Call convention: fire-and-forget, AFTER commit, never awaited.
 *
 *   logAction({ ... }).catch(() => {});
 *
 * Audit logging must never break a business request, so every error is
 * swallowed to console.error.
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';

/**
 * @param {object}  p
 * @param {string}  p.orgId
 * @param {string}  p.module            'users' | 'assignments' | 'organizations'
 * @param {string}  p.action            'Added User' — first word drives UI colour
 * @param {string}  p.entityType
 * @param {string} [p.entityId]
 * @param {string} [p.entityName]
 * @param {string}  p.performedBy
 * @param {string} [p.performedByRole]
 * @param {string} [p.description]
 * @param {string} [p.ipAddress]
 */
export const logAction = async ({
    orgId, module, action, entityType,
    entityId = null, entityName = null,
    performedBy, performedByRole = null,
    description = null, ipAddress = null,
}) => {
    try {
        if (!orgId) return;   // SUPER_ADMIN platform actions have no tenant

        let performedByName = null;
        const { rows } = await query(
            'SELECT name, role FROM users WHERE id = $1',
            [performedBy],
        );
        if (rows[0]) {
            performedByName = rows[0].name;
            performedByRole = performedByRole ?? rows[0].role;
        }

        await query(
            `INSERT INTO audit_logs
                (id, organization_id, module, action, entity_type, entity_id,
                 entity_name, performed_by, performed_by_name, performed_by_role,
                 description, ip_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [uuidv4(), orgId, module, action, entityType, entityId, entityName,
                performedBy, performedByName, performedByRole, description, ipAddress],
        );
    } catch (err) {
        console.error('Audit log write failed (request unaffected):', err.message);
    }
};

/**
 * Build a human-readable description from a before/after diff.
 *
 *   describeChanges('User', [
 *       { label: 'Name',  oldVal: old.name,  newVal: name },
 *       { label: 'Phone', oldVal: old.phone, newVal: phone },
 *   ])
 *   → 'Updated User: Changed Name from "A" to "B"; Set Phone to "123"'
 */
export const describeChanges = (label, fields) => {
    const changes = [];

    for (const f of fields) {
        const ov = String(f.oldVal ?? '').trim();
        const nv = String(f.newVal ?? '').trim();
        if (ov === nv) continue;

        if (!ov) changes.push(`Set ${f.label} to "${nv}"`);
        else if (!nv) changes.push(`Cleared ${f.label} (was "${ov}")`);
        else changes.push(`Changed ${f.label} from "${ov}" to "${nv}"`);
    }

    return changes.length
        ? `Updated ${label}: ${changes.join('; ')}`
        : `Updated ${label} (no field changes)`;
};

/**
 * GET /api/management/audit-logs/:module?limit=50&offset=0
 * ORG_ADMIN only, always org-scoped.
 */
export const getModuleAuditLogs = async (req, res, next) => {
    try {
        const { module } = req.params;
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);

        const { rows } = await query(
            `SELECT id, module, action, entity_type, entity_id, entity_name,
                    performed_by, performed_by_name, performed_by_role,
                    description, created_at
               FROM audit_logs
              WHERE organization_id = $1 AND module = $2
              ORDER BY created_at DESC
              LIMIT $3 OFFSET $4`,
            [req.user.orgId, module, limit, offset],
        );

        const { rows: countRows } = await query(
            'SELECT COUNT(*)::int AS total FROM audit_logs WHERE organization_id = $1 AND module = $2',
            [req.user.orgId, module],
        );

        return res.json({ logs: rows, total: countRows[0].total, limit, offset });
    } catch (err) {
        return next(err);
    }
};
