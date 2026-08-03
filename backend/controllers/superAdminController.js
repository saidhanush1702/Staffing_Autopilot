/**
 * SUPER_ADMIN — tenant management only.
 *
 * Creates and disables organisations, and bootstraps each one's first
 * ORG_ADMIN. Deliberately has NO access to any tenant's business data.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { encryptPassword } from '../utils/crypto.js';

export const createOrgSchema = Joi.object({
    name: Joi.string().trim().min(2).max(255).required(),
    slug: Joi.string().trim().lowercase().min(2).max(60)
        .pattern(/^[a-z0-9-]+$/)
        .message('Slug may contain only lowercase letters, numbers and hyphens.')
        .required(),
    contactEmail: Joi.string().email({ tlds: { allow: false } }).max(255).allow('', null),
    contactPhone: Joi.string().max(30).allow('', null),
    timezone: Joi.string().max(64).default('Asia/Kolkata'),

    adminName: Joi.string().trim().min(2).max(255).required(),
    adminEmail: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
    adminPassword: Joi.string().min(8).max(200).required(),
});

export const updateOrgSchema = Joi.object({
    name: Joi.string().trim().min(2).max(255),
    contactEmail: Joi.string().email({ tlds: { allow: false } }).max(255).allow('', null),
    contactPhone: Joi.string().max(30).allow('', null),
    timezone: Joi.string().max(64),
    isActive: Joi.boolean(),
}).min(1);

/** GET /api/super-admin/organizations */
export const listOrganizations = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT o.id, o.name, o.slug, o.contact_email, o.contact_phone,
                    o.timezone, o.is_active, o.created_at,
                    COUNT(u.id) FILTER (WHERE u.role = 'ORG_ADMIN')  ::int AS admin_count,
                    COUNT(u.id) FILTER (WHERE u.role = 'RECRUITER')  ::int AS recruiter_count,
                    COUNT(u.id) FILTER (WHERE u.role = 'CONSULTANT') ::int AS consultant_count
               FROM organizations o
          LEFT JOIN users u ON u.organization_id = o.id AND u.is_active = TRUE
           GROUP BY o.id
           ORDER BY o.created_at DESC`,
        );
        return res.json({ organizations: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/super-admin/organizations/:id
 *
 * The tenant, its per-role headcount, and its user list. SUPER_ADMIN sees who
 * exists and whether accounts are active — deliberately NOT their business
 * data (no profiles, no resumes, no change requests).
 */
export const getOrganization = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT id, name, slug, contact_email, contact_phone, timezone,
                    is_active, created_at, updated_at
               FROM organizations WHERE id = $1`,
            [req.params.id],
        );
        if (!rows[0]) return res.status(404).json({ error: 'Organization not found.' });

        // One pass, split by role and by active state.
        const { rows: countRows } = await query(
            `SELECT
               COUNT(*) FILTER (WHERE role = 'ORG_ADMIN')                   ::int AS org_admins,
               COUNT(*) FILTER (WHERE role = 'ORG_ADMIN'  AND is_active)    ::int AS org_admins_active,
               COUNT(*) FILTER (WHERE role = 'RECRUITER')                   ::int AS recruiters,
               COUNT(*) FILTER (WHERE role = 'RECRUITER'  AND is_active)    ::int AS recruiters_active,
               COUNT(*) FILTER (WHERE role = 'CONSULTANT')                  ::int AS consultants,
               COUNT(*) FILTER (WHERE role = 'CONSULTANT' AND is_active)    ::int AS consultants_active,
               COUNT(*)                                                     ::int AS total_users,
               COUNT(*) FILTER (WHERE NOT is_active)                        ::int AS disabled_users
             FROM users WHERE organization_id = $1`,
            [req.params.id],
        );

        const { rows: users } = await query(
            `SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login_at,
                    u.created_at, rec.name AS recruiter_name
               FROM users u
          LEFT JOIN assignments a
                 ON a.consultant_id = u.id AND a.effective_to IS NULL
          LEFT JOIN users rec ON rec.id = a.recruiter_id
              WHERE u.organization_id = $1
              ORDER BY CASE u.role
                         WHEN 'ORG_ADMIN' THEN 1
                         WHEN 'RECRUITER' THEN 2
                         ELSE 3 END, u.name`,
            [req.params.id],
        );

        return res.json({ organization: rows[0], counts: countRows[0], users });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/super-admin/organizations
 * Creates the tenant and its first ORG_ADMIN in one transaction — an
 * organisation with no way to log into it would be useless.
 */
export const createOrganization = async (req, res, next) => {
    try {
        const {
            name, slug, contactEmail, contactPhone, timezone,
            adminName, adminEmail, adminPassword,
        } = req.body;

        const dupOrg = await query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
        if (dupOrg.rows.length) {
            return res.status(409).json({ error: `Slug "${slug}" is already taken.` });
        }
        const dupUser = await query('SELECT 1 FROM users WHERE email = $1', [adminEmail]);
        if (dupUser.rows.length) {
            return res.status(409).json({ error: `Email "${adminEmail}" is already registered.` });
        }

        const result = await withTransaction(async (client) => {
            const orgId = uuidv4();
            await client.query(
                `INSERT INTO organizations
                    (id, name, slug, contact_email, contact_phone, timezone, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [orgId, name, slug, contactEmail || null, contactPhone || null,
                    timezone, req.user.id],
            );

            const { enc, iv, tag } = encryptPassword(adminPassword);
            const adminId = uuidv4();
            await client.query(
                `INSERT INTO users
                    (id, organization_id, name, email, role,
                     password_enc, password_iv, password_tag, created_by)
                 VALUES ($1,$2,$3,$4,'ORG_ADMIN',$5,$6,$7,$8)`,
                [adminId, orgId, adminName, adminEmail, enc, iv, tag, req.user.id],
            );

            return { orgId, adminId };
        });

        return res.status(201).json({
            message: 'Organization created.',
            organizationId: result.orgId,
            adminId: result.adminId,
        });
    } catch (err) {
        return next(err);
    }
};

/** PATCH /api/super-admin/organizations/:id */
export const updateOrganization = async (req, res, next) => {
    try {
        const { rows } = await query('SELECT * FROM organizations WHERE id = $1', [req.params.id]);
        const org = rows[0];
        if (!org) return res.status(404).json({ error: 'Organization not found.' });

        const { name, contactEmail, contactPhone, timezone, isActive } = req.body;

        await query(
            `UPDATE organizations
                SET name          = COALESCE($1, name),
                    contact_email = COALESCE($2, contact_email),
                    contact_phone = COALESCE($3, contact_phone),
                    timezone      = COALESCE($4, timezone),
                    is_active     = COALESCE($5, is_active),
                    updated_by    = $6
              WHERE id = $7`,
            [name ?? null, contactEmail ?? null, contactPhone ?? null,
                timezone ?? null, isActive ?? null, req.user.id, req.params.id],
        );

        return res.json({ message: 'Organization updated.' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/super-admin/organizations/:id/toggle-active
 * Soft disable — never a row delete (is_active convention).
 */
export const toggleOrganizationActive = async (req, res, next) => {
    try {
        const { rows } = await query(
            'SELECT id, name, is_active FROM organizations WHERE id = $1',
            [req.params.id],
        );
        const org = rows[0];
        if (!org) return res.status(404).json({ error: 'Organization not found.' });

        await query(
            'UPDATE organizations SET is_active = NOT is_active, updated_by = $1 WHERE id = $2',
            [req.user.id, org.id],
        );

        return res.json({
            message: org.is_active ? 'Organization disabled.' : 'Organization enabled.',
            isActive: !org.is_active,
        });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/super-admin/stats */
export const platformStats = async (req, res, next) => {
    try {
        const { rows } = await query(`
            SELECT
              (SELECT COUNT(*)::int FROM organizations)                       AS total_orgs,
              (SELECT COUNT(*)::int FROM organizations WHERE is_active)       AS active_orgs,
              (SELECT COUNT(*)::int FROM users WHERE role = 'ORG_ADMIN')      AS org_admins,
              (SELECT COUNT(*)::int FROM users WHERE role = 'RECRUITER')      AS recruiters,
              (SELECT COUNT(*)::int FROM users WHERE role = 'CONSULTANT')     AS consultants
        `);
        return res.json({ stats: rows[0] });
    } catch (err) {
        return next(err);
    }
};
