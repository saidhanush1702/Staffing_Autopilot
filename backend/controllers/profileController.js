/**
 * Consultant profiles — the LIVE (approved) values.
 *
 * Two entry points with very different rules:
 *   ORG_ADMIN  → edits the live profile DIRECTLY (no approval)
 *   CONSULTANT → proposes changes, which go through profileChangeController
 *
 * Everything is driven by config/profileFields.js, so adding a field later
 * needs no change in this file.
 */
import Joi from 'joi';
import { query } from '../db.js';
import {
    PROFILE_FIELDS, ADMIN_ONLY_FIELDS, CONSULTANT_EDITABLE,
    REQUIRED_FIELDS, missingRequiredFields, joiForField,
} from '../config/profileFields.js';
import { canAccessConsultant } from '../utils/scope.js';
import { readPaging, pageResult } from '../utils/pagination.js';
import { logAction, describeChanges } from './auditLogController.js';

// Every profile field, rules taken from the registry. Hand-written duplicates
// used to live here and had already drifted — phone accepted 30 characters of
// anything while the registry called for 10 digits. Deriving both from
// joiForField removes the second source of truth.
export const adminUpdateProfileSchema = Joi.object(
    Object.fromEntries(
        Object.keys(PROFILE_FIELDS).map((name) => [name, joiForField(Joi, name)]),
    ),
).min(1);

/**
 * GET /api/profile-schema
 * The field registry, so the client renders forms from the server's
 * definition rather than a duplicated copy.
 */
export const getProfileSchema = (req, res) => {
    res.json({
        fields: PROFILE_FIELDS,
        consultantEditable: CONSULTANT_EDITABLE,
        required: REQUIRED_FIELDS,
        adminOnly: ADMIN_ONLY_FIELDS,
    });
};

const PROFILE_SELECT = `
    SELECT p.*,
           u.name, u.email, u.role, u.is_active, u.employment_status,
           u.suspended_at, u.suspend_reason, u.terminated_at, u.termination_reason,
           w.name AS work_auth_name,
           r.original_name AS resume_name,
           r.size_bytes    AS resume_size,
           r.created_at    AS resume_uploaded_at
      FROM consultant_profiles p
      JOIN users u ON u.id = p.user_id
 LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
 LEFT JOIN resume_artifacts r ON r.id = p.base_resume_artifact_id
`;

/**
 * GET /api/management/consultants
 *
 * ORG_ADMIN sees every consultant in the organisation.
 * RECRUITER sees only those currently assigned to them.
 *
 * Supports ?search, ?status (complete|incomplete|pending), ?limit, ?page.
 * The COUNT(*) OVER () window returns the total on the same pass, so a page
 * and its count can never disagree.
 */
export const listConsultants = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;
        const paging = readPaging(req);
        const search = (req.query.search ?? '').trim() || null;
        const filter = req.query.status ?? null;
        const includeInactive = req.query.includeInactive === 'true';

        const { rows } = await query(
            `SELECT COUNT(*) OVER () AS total_count,
                    p.user_id, p.phone, p.city, p.state, p.work_auth_status_id,
                    p.base_resume_artifact_id, p.daily_cap, p.is_paused,
                    p.consent_on_file, p.linkedin_url,
                    u.name, u.email, u.is_active, u.employment_status,
                    w.name AS work_auth_name,
                    rec.name AS recruiter_name, rec.id AS recruiter_id,
                    r.original_name AS resume_name,
                    EXISTS (
                        SELECT 1 FROM profile_change_requests c
                         WHERE c.consultant_id = p.user_id AND c.status = 'PENDING'
                    ) AS has_pending_changes
               FROM consultant_profiles p
               JOIN users u ON u.id = p.user_id
          LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
          LEFT JOIN resume_artifacts r ON r.id = p.base_resume_artifact_id
          LEFT JOIN assignments a
                 ON a.consultant_id = p.user_id AND a.effective_to IS NULL
          LEFT JOIN users rec ON rec.id = a.recruiter_id
              WHERE p.organization_id = $1
                AND ($7::boolean OR u.employment_status = 'ACTIVE')
                AND ($2::text IS NULL OR a.recruiter_id = $2)
                AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%'
                                      OR u.email ILIKE '%' || $3 || '%')
                AND ($4::text IS NULL
                     OR ($4 = 'pending' AND EXISTS (
                            SELECT 1 FROM profile_change_requests c
                             WHERE c.consultant_id = p.user_id AND c.status = 'PENDING'))
                     OR ($4 = 'complete' AND p.phone IS NOT NULL AND p.city IS NOT NULL
                         AND p.state IS NOT NULL AND p.work_auth_status_id IS NOT NULL
                         AND p.base_resume_artifact_id IS NOT NULL)
                     OR ($4 = 'incomplete' AND (p.phone IS NULL OR p.city IS NULL
                         OR p.state IS NULL OR p.work_auth_status_id IS NULL
                         OR p.base_resume_artifact_id IS NULL)))
              ORDER BY u.name
              LIMIT $5 OFFSET $6`,
            [orgId, role === 'RECRUITER' ? userId : null, search, filter,
                paging.limit, paging.offset, includeInactive],
        );

        const result = pageResult(rows, paging);
        return res.json({
            consultants: result.data.map((r) => ({
                ...r,
                missing_fields: missingRequiredFields(r),
                is_complete: missingRequiredFields(r).length === 0,
            })),
            page: result.page,
        });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/consultants/:id */
export const getConsultantProfile = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(403).json({ error: 'You do not have access to this consultant.' });
        }

        const { rows } = await query(
            `${PROFILE_SELECT} WHERE p.user_id = $1 AND p.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );
        if (!rows[0]) return res.status(404).json({ error: 'Consultant profile not found.' });

        const profile = rows[0];
        return res.json({
            profile,
            missingFields: missingRequiredFields(profile),
            isComplete: missingRequiredFields(profile).length === 0,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * PUT /api/management/consultants/:id/profile — ORG_ADMIN only.
 * Direct write. The approval gate exists because the CONSULTANT is proposing,
 * not because the field is sensitive.
 */
export const adminUpdateProfile = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        const existing = await query(
            `SELECT p.*, u.name FROM consultant_profiles p
               JOIN users u ON u.id = p.user_id
              WHERE p.user_id = $1 AND p.organization_id = $2`,
            [req.params.id, orgId],
        );
        const old = existing.rows[0];
        if (!old) return res.status(404).json({ error: 'Consultant profile not found.' });

        // Build the UPDATE from only the keys actually sent.
        const entries = Object.entries(req.body).filter(([k]) => PROFILE_FIELDS[k]);
        if (entries.length === 0) {
            return res.status(422).json({ error: 'No recognised profile fields supplied.' });
        }

        const sets = entries.map(([k], i) => `${k} = $${i + 1}`);
        const values = entries.map(([, v]) => (v === '' ? null : v));
        values.push(req.user.id, req.params.id, orgId);

        await query(
            `UPDATE consultant_profiles
                SET ${sets.join(', ')}, updated_by = $${values.length - 2}
              WHERE user_id = $${values.length - 1} AND organization_id = $${values.length}`,
            values,
        );

        const description = describeChanges('Profile', entries.map(([k, v]) => ({
            label: PROFILE_FIELDS[k].label,
            oldVal: old[k],
            newVal: v,
        })));

        logAction({
            orgId, module: 'consultant_profiles', action: 'Updated Profile',
            entityType: 'ConsultantProfile', entityId: req.params.id, entityName: old.name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description, ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Profile updated.' });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/portal/profile — the consultant's own live profile.
 * Includes their pending request, if any, so the UI can lock the form.
 */
export const myProfile = async (req, res, next) => {
    try {
        const { rows } = await query(
            `${PROFILE_SELECT}
              WHERE p.user_id = $1 AND p.organization_id = $2`,
            [req.user.id, req.user.orgId],
        );
        if (!rows[0]) return res.status(404).json({ error: 'Profile not found.' });
        const profile = rows[0];

        const { rows: recruiterRows } = await query(
            `SELECT r.name, r.email FROM assignments a
               JOIN users r ON r.id = a.recruiter_id
              WHERE a.consultant_id = $1 AND a.effective_to IS NULL`,
            [req.user.id],
        );

        const { rows: pending } = await query(
            `SELECT c.id, c.submitted_at, c.status,
                    json_agg(json_build_object(
                        'field_name', f.field_name,
                        'new_display', f.new_display,
                        'status', f.status,
                        'review_note', f.review_note
                    ) ORDER BY f.field_name) AS fields
               FROM profile_change_requests c
               JOIN profile_change_request_fields f ON f.change_request_id = c.id
              WHERE c.consultant_id = $1 AND c.status = 'PENDING'
              GROUP BY c.id`,
            [req.user.id],
        );

        // The most recent reviewed request, so the consultant sees the outcome
        // and — importantly — WHO decided it and in what role.
        const { rows: lastReviewed } = await query(
            `SELECT c.id, c.status, c.reviewed_at, c.review_note,
                    rev.name AS reviewed_by_name, rev.role AS reviewed_by_role,
                    COUNT(f.id) FILTER (WHERE f.status = 'APPROVED')::int AS approved_count,
                    COUNT(f.id) FILTER (WHERE f.status = 'REJECTED')::int AS rejected_count,
                    json_agg(json_build_object(
                        'field_name', f.field_name,
                        'old_display', f.old_display,
                        'new_display', f.new_display,
                        'status', f.status,
                        'review_note', f.review_note
                    ) ORDER BY f.field_name) AS fields
               FROM profile_change_requests c
               JOIN profile_change_request_fields f ON f.change_request_id = c.id
          LEFT JOIN users rev ON rev.id = c.reviewed_by
              WHERE c.consultant_id = $1 AND c.status NOT IN ('PENDING', 'WITHDRAWN')
              GROUP BY c.id, rev.name, rev.role
              ORDER BY c.reviewed_at DESC NULLS LAST
              LIMIT 1`,
            [req.user.id],
        );

        return res.json({
            profile,
            recruiter: recruiterRows[0] ?? null,
            missingFields: missingRequiredFields(profile),
            isComplete: missingRequiredFields(profile).length === 0,
            pendingRequest: pending[0] ?? null,
            lastReviewed: lastReviewed[0] ?? null,
        });
    } catch (err) {
        return next(err);
    }
};
