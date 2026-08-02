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
    REQUIRED_FIELDS, missingRequiredFields,
} from '../config/profileFields.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction, describeChanges } from './auditLogController.js';

export const adminUpdateProfileSchema = Joi.object({
    phone: Joi.string().max(30).allow('', null),
    city: Joi.string().max(120).allow('', null),
    state: Joi.string().max(120).allow('', null),
    work_auth_status_id: Joi.number().integer().allow(null),
    work_auth_notes: Joi.string().max(500).allow('', null),
    linkedin_url: Joi.string().uri().max(255).allow('', null),
    daily_cap: Joi.number().integer().min(0).max(100),
    consent_on_file: Joi.boolean(),
    consent_signed_at: Joi.date().allow(null),
    is_paused: Joi.boolean(),
    notes: Joi.string().max(2000).allow('', null),
}).min(1);

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
           u.name, u.email, u.role, u.is_active,
           w.name AS work_auth_name,
           r.original_name AS resume_name,
           r.size_bytes    AS resume_size,
           r.created_at    AS resume_uploaded_at
      FROM consultant_profiles p
      JOIN users u ON u.id = p.user_id
 LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
 LEFT JOIN resume_artifacts r ON r.id = p.base_resume_artifact_id
`;

/** GET /api/management/consultants — list with completeness + pending flags */
export const listConsultants = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;

        const { rows } = await query(
            `SELECT p.user_id, p.phone, p.city, p.state, p.work_auth_status_id,
                    p.base_resume_artifact_id, p.daily_cap, p.is_paused,
                    p.consent_on_file,
                    u.name, u.email, u.is_active,
                    w.name AS work_auth_name,
                    rec.name AS recruiter_name,
                    EXISTS (
                        SELECT 1 FROM profile_change_requests c
                         WHERE c.consultant_id = p.user_id AND c.status = 'PENDING'
                    ) AS has_pending_changes
               FROM consultant_profiles p
               JOIN users u ON u.id = p.user_id
          LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
          LEFT JOIN assignments a
                 ON a.consultant_id = p.user_id AND a.effective_to IS NULL
          LEFT JOIN users rec ON rec.id = a.recruiter_id
              WHERE p.organization_id = $1
                AND ($2::text IS NULL OR a.recruiter_id = $2)
              ORDER BY u.name`,
            [orgId, role === 'RECRUITER' ? userId : null],
        );

        return res.json({
            consultants: rows.map((r) => ({
                ...r,
                missing_fields: missingRequiredFields(r),
                is_complete: missingRequiredFields(r).length === 0,
            })),
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
