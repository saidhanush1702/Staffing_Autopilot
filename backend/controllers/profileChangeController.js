/**
 * Consultant profile change requests — propose / review / apply.
 *
 *   consultant edits  → only CHANGED fields become a request
 *                     → live profile untouched, still used for matching
 *   reviewer decides  → EACH FIELD approved or rejected individually
 *                     → approved values copied into consultant_profiles
 *                     → rejected ones returned with a note
 *
 * Two-person rule: the consultant proposes, someone else approves. Enforced
 * by the route guards (a consultant can never reach the review endpoints) and
 * re-checked here.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import {
    PROFILE_FIELDS, CONSULTANT_EDITABLE,
    toStoredValue, toDisplayValue, missingRequiredFields,
} from '../config/profileFields.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction } from './auditLogController.js';

/* ── validation ──────────────────────────────────────────────────────── */

// Built from the registry, so a new consultant-editable field is accepted
// automatically without touching this schema.
export const submitChangeSchema = Joi.object(
    Object.fromEntries(CONSULTANT_EDITABLE.map((name) => {
        const f = PROFILE_FIELDS[name];
        if (f.type === 'lookup') return [name, Joi.number().integer().allow(null)];
        if (f.type === 'file') return [name, Joi.string().guid({ version: 'uuidv4' }).allow(null)];
        if (f.type === 'url') return [name, Joi.string().uri().max(f.maxLength ?? 255).allow('', null)];
        return [name, Joi.string().max(f.maxLength ?? 255).allow('', null)];
    })),
).min(1);

export const reviewSchema = Joi.object({
    decisions: Joi.array().min(1).items(Joi.object({
        fieldName: Joi.string().valid(...CONSULTANT_EDITABLE).required(),
        decision: Joi.string().valid('APPROVED', 'REJECTED').required(),
        note: Joi.string().max(500).allow('', null),
    })).required(),
    reviewNote: Joi.string().max(500).allow('', null),
});

/** Lookup tables needed to render human-readable values. */
const loadLookups = async () => {
    const { rows } = await query('SELECT id, name FROM lkp_work_auth_statuses ORDER BY id');
    return { workAuthStatuses: rows };
};

/* ── consultant: submit ──────────────────────────────────────────────── */

/**
 * POST /api/portal/profile/change-request
 *
 * Diffs the submission against the live profile and stores ONLY what changed.
 * Unchanged fields are silently dropped — a reviewer should never be asked to
 * approve a value that is already live.
 */
export const submitChangeRequest = async (req, res, next) => {
    try {
        const { id: consultantId, orgId } = req.user;

        const existing = await query(
            `SELECT 1 FROM profile_change_requests
              WHERE consultant_id = $1 AND status = 'PENDING'`,
            [consultantId],
        );
        if (existing.rows.length) {
            return res.status(409).json({
                error: 'You already have changes awaiting approval. Withdraw them first to make new edits.',
            });
        }

        const { rows: profileRows } = await query(
            'SELECT * FROM consultant_profiles WHERE user_id = $1 AND organization_id = $2',
            [consultantId, orgId],
        );
        const live = profileRows[0];
        if (!live) return res.status(404).json({ error: 'Profile not found.' });

        const lookups = await loadLookups();

        // ── the diff ──────────────────────────────────────────────────
        const changed = [];
        for (const [name, rawValue] of Object.entries(req.body)) {
            if (!CONSULTANT_EDITABLE.includes(name)) continue;   // whitelist

            const newValue = toStoredValue(rawValue);
            const oldValue = toStoredValue(live[name]);
            if (newValue === oldValue) continue;                  // unchanged

            changed.push({
                field_name: name,
                old_value: oldValue,
                new_value: newValue,
                old_display: toDisplayValue(name, oldValue, lookups),
                new_display: toDisplayValue(name, newValue, lookups),
            });
        }

        if (changed.length === 0) {
            return res.status(422).json({ error: 'Nothing changed. Edit at least one field before submitting.' });
        }

        const requestId = await withTransaction(async (client) => {
            const id = uuidv4();
            await client.query(
                `INSERT INTO profile_change_requests
                    (id, organization_id, consultant_id, submitted_by, created_by)
                 VALUES ($1,$2,$3,$4,$4)`,
                [id, orgId, consultantId, consultantId],
            );
            for (const c of changed) {
                await client.query(
                    `INSERT INTO profile_change_request_fields
                        (id, change_request_id, field_name, old_value, new_value,
                         old_display, new_display)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                    [uuidv4(), id, c.field_name, c.old_value, c.new_value,
                        c.old_display, c.new_display],
                );
            }
            return id;
        });

        const labels = changed.map((c) => PROFILE_FIELDS[c.field_name].label).join(', ');
        logAction({
            orgId, module: 'profile_changes', action: 'Submitted Profile Changes',
            entityType: 'ProfileChangeRequest', entityId: requestId,
            entityName: req.user.name ?? 'Consultant',
            performedBy: consultantId, performedByRole: 'CONSULTANT',
            description: `Submitted ${changed.length} field change(s) for approval: ${labels}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            message: 'Changes submitted for approval.',
            requestId,
            fieldCount: changed.length,
        });
    } catch (err) {
        return next(err);
    }
};

/** DELETE /api/portal/profile/change-request — consultant withdraws before review. */
export const withdrawChangeRequest = async (req, res, next) => {
    try {
        const { rows } = await query(
            `UPDATE profile_change_requests
                SET status = 'WITHDRAWN', updated_by = $1
              WHERE consultant_id = $1 AND status = 'PENDING'
              RETURNING id`,
            [req.user.id],
        );
        if (!rows[0]) return res.status(404).json({ error: 'No pending request to withdraw.' });

        logAction({
            orgId: req.user.orgId, module: 'profile_changes', action: 'Removed Profile Changes',
            entityType: 'ProfileChangeRequest', entityId: rows[0].id,
            performedBy: req.user.id, performedByRole: 'CONSULTANT',
            description: 'Withdrew a pending profile change request',
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Request withdrawn. You can edit your profile again.' });
    } catch (err) {
        return next(err);
    }
};

/* ── reviewer: list + detail ─────────────────────────────────────────── */

/**
 * GET /api/management/profile-changes?status=PENDING
 * ORG_ADMIN sees the whole org; RECRUITER only their assigned consultants.
 */
export const listChangeRequests = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;
        const status = req.query.status ?? 'PENDING';

        const { rows } = await query(
            `SELECT c.id, c.status, c.submitted_at, c.reviewed_at, c.review_note,
                    c.consultant_id,
                    u.name AS consultant_name, u.email AS consultant_email,
                    rev.name AS reviewed_by_name, rev.role AS reviewed_by_role,
                    rec.name AS recruiter_name,
                    COUNT(f.id) FILTER (WHERE f.status = 'APPROVED')::int AS approved_count,
                    COUNT(f.id) FILTER (WHERE f.status = 'REJECTED')::int AS rejected_count,
                    COUNT(f.id)::int AS field_count,
                    json_agg(json_build_object(
                        'id', f.id,
                        'field_name', f.field_name,
                        'old_display', f.old_display,
                        'new_display', f.new_display,
                        'status', f.status,
                        'review_note', f.review_note
                    ) ORDER BY f.field_name) AS fields
               FROM profile_change_requests c
               JOIN users u ON u.id = c.consultant_id
               JOIN profile_change_request_fields f ON f.change_request_id = c.id
          LEFT JOIN users rev ON rev.id = c.reviewed_by
          LEFT JOIN assignments a
                 ON a.consultant_id = c.consultant_id AND a.effective_to IS NULL
          LEFT JOIN users rec ON rec.id = a.recruiter_id
              WHERE c.organization_id = $1
                AND ($2::text = 'ALL' OR c.status = $2)
                AND ($3::text IS NULL OR a.recruiter_id = $3)
              GROUP BY c.id, u.name, u.email, rev.name, rev.role, rec.name
              ORDER BY c.submitted_at ASC`,
            [orgId, status, role === 'RECRUITER' ? userId : null],
        );

        return res.json({ requests: rows });
    } catch (err) {
        return next(err);
    }
};

/* ── reviewer: decide ────────────────────────────────────────────────── */

/**
 * POST /api/management/profile-changes/:id/review
 *
 * Body: { decisions: [{ fieldName, decision, note }], reviewNote }
 *
 * Approved fields are written into consultant_profiles in the SAME
 * transaction that records the decision — a value can never be marked
 * approved without actually going live, or vice versa.
 */
export const reviewChangeRequest = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        const { rows: reqRows } = await query(
            `SELECT c.*, u.name AS consultant_name
               FROM profile_change_requests c
               JOIN users u ON u.id = c.consultant_id
              WHERE c.id = $1 AND c.organization_id = $2`,
            [req.params.id, orgId],
        );
        const request = reqRows[0];
        if (!request) return res.status(404).json({ error: 'Request not found in your organization.' });
        if (request.status !== 'PENDING') {
            return res.status(409).json({ error: `This request is already ${request.status.toLowerCase()}.` });
        }

        // A recruiter may only review their own assigned consultants.
        if (!(await canAccessConsultant(req.user, request.consultant_id))) {
            return res.status(403).json({ error: 'You do not have access to this consultant.' });
        }

        // Two-person rule: never approve your own submission.
        if (request.submitted_by === req.user.id) {
            return res.status(403).json({ error: 'You cannot approve changes you submitted yourself.' });
        }

        const { rows: fieldRows } = await query(
            'SELECT * FROM profile_change_request_fields WHERE change_request_id = $1',
            [req.params.id],
        );
        const byName = new Map(fieldRows.map((f) => [f.field_name, f]));

        // Every field in the request must be decided.
        const decided = new Set(req.body.decisions.map((d) => d.fieldName));
        const undecided = fieldRows.filter((f) => !decided.has(f.field_name));
        if (undecided.length) {
            return res.status(422).json({
                error: `Decide every field before submitting. Missing: ${undecided.map((f) => f.field_name).join(', ')}`,
            });
        }

        const approved = req.body.decisions.filter((d) => d.decision === 'APPROVED');
        const rejected = req.body.decisions.filter((d) => d.decision === 'REJECTED');

        const status = approved.length === 0 ? 'REJECTED'
            : rejected.length === 0 ? 'APPROVED'
                : 'PARTIALLY_APPROVED';

        await withTransaction(async (client) => {
            // 1. Copy approved values into the live profile.
            if (approved.length) {
                const sets = approved.map((d, i) => `${d.fieldName} = $${i + 1}`);
                const values = approved.map((d) => {
                    const f = byName.get(d.fieldName);
                    const field = PROFILE_FIELDS[d.fieldName];
                    if (f.new_value === null) return null;
                    if (field.type === 'lookup' || field.type === 'number') return Number(f.new_value);
                    if (field.type === 'boolean') return f.new_value === 'true';
                    return f.new_value;
                });
                values.push(req.user.id, request.consultant_id, orgId);

                await client.query(
                    `UPDATE consultant_profiles
                        SET ${sets.join(', ')}, updated_by = $${values.length - 2}
                      WHERE user_id = $${values.length - 1} AND organization_id = $${values.length}`,
                    values,
                );
            }

            // 2. Record every per-field decision.
            for (const d of req.body.decisions) {
                await client.query(
                    `UPDATE profile_change_request_fields
                        SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
                      WHERE change_request_id = $4 AND field_name = $5`,
                    [d.decision, req.user.id, d.note || null, req.params.id, d.fieldName],
                );
            }

            // 3. Close the request.
            await client.query(
                `UPDATE profile_change_requests
                    SET status = $1, reviewed_by = $2, reviewed_at = now(),
                        review_note = $3, updated_by = $2
                  WHERE id = $4`,
                [status, req.user.id, req.body.reviewNote || null, req.params.id],
            );
        });

        const approvedLabels = approved.map((d) => PROFILE_FIELDS[d.fieldName].label);
        const rejectedLabels = rejected.map((d) => PROFILE_FIELDS[d.fieldName].label);
        const parts = [];
        if (approvedLabels.length) parts.push(`approved ${approvedLabels.join(', ')}`);
        if (rejectedLabels.length) parts.push(`rejected ${rejectedLabels.join(', ')}`);

        logAction({
            orgId, module: 'profile_changes',
            action: status === 'REJECTED' ? 'Rejected Profile Changes' : 'Approved Profile Changes',
            entityType: 'ProfileChangeRequest', entityId: req.params.id,
            entityName: request.consultant_name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Reviewed changes for "${request.consultant_name}": ${parts.join('; ')}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            message: 'Review recorded.',
            status,
            approved: approved.length,
            rejected: rejected.length,
        });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/profile-changes/count — sidebar badge for reviewers. */
export const pendingCount = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;
        const { rows } = await query(
            `SELECT COUNT(DISTINCT c.id)::int AS count
               FROM profile_change_requests c
          LEFT JOIN assignments a
                 ON a.consultant_id = c.consultant_id AND a.effective_to IS NULL
              WHERE c.organization_id = $1 AND c.status = 'PENDING'
                AND ($2::text IS NULL OR a.recruiter_id = $2)`,
            [orgId, role === 'RECRUITER' ? userId : null],
        );
        return res.json({ pending: rows[0].count });
    } catch (err) {
        return next(err);
    }
};
