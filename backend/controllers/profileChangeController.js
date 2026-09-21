/**
 * Consultant profile change requests — propose / review / apply.
 *
 * ONE MERGED WORKFLOW covering everything a consultant can submit: identity
 * fields (phone, city, work auth, the base resume, the "about you" links) and
 * the career record (skills, work history, education, projects,
 * certifications). Both used to be two pages on two engines — see this file's
 * git history and migration 050's header for why they were split and why
 * they were brought back together.
 *
 *   consultant edits  → identity: only CHANGED fields become field rows
 *                     → career: the whole proposed list per touched section
 *                       becomes one snapshot row (services/careerApproval.js)
 *                     → live data untouched either way — matching and
 *                       tailoring keep using the last-APPROVED version
 *
 *   reviewer decides  → ONE decision, APPROVED or REJECTED, for the WHOLE
 *                       submission — not per field. Approving copies every
 *                       identity field into consultant_profiles AND replaces
 *                       the career tables with the snapshot, in one
 *                       transaction. Rejecting changes nothing live.
 *
 * ── WHY ONE DECISION AND NOT PER-FIELD ANY MORE ───────────────────────
 *
 * This file used to let a reviewer approve nine fields and reject a tenth.
 * That granularity does not extend cleanly to "3 skills added, 1 job added" —
 * there is no sensible per-skill checkbox on a submission a consultant meant
 * as one coherent update to their profile. Rather than have two different
 * review models on one merged page, the whole submission is now one decision.
 * The trade-off is explicit and was chosen deliberately: a single typo
 * anywhere in a submission sends the whole thing back, including everything
 * that was fine. The per-field STORAGE (profile_change_request_fields) is
 * kept exactly as it was, so the audit trail still shows every individual
 * field that changed — only the review ACTION collapsed to one button.
 *
 * Two-person rule: the consultant proposes, someone else approves. Enforced
 * by the route guards (a consultant can never reach the review endpoints) and
 * re-checked here.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import {
    PROFILE_FIELDS, joiForField, CONSULTANT_EDITABLE,
    toStoredValue, toDisplayValue, missingRequiredFields,
} from '../config/profileFields.js';
import {
    loadLiveCareer, buildCareerSnapshot, diffCareer, applyCareerSnapshot,
} from '../services/careerApproval.js';
import { canAccessConsultant } from '../utils/scope.js';
import { readPaging, pageResult } from '../utils/pagination.js';
import { logAction } from './auditLogController.js';
import { pruneResumes } from './resumeController.js';

const RESUME_FIELD = 'base_resume_artifact_id';

/**
 * Keep exactly one resume file per consultant after a request closes.
 * Whichever artifact the profile now points at is the only one that survives.
 */
const cleanupResumes = async (orgId, consultantId) => {
    const { rows } = await query(
        'SELECT base_resume_artifact_id FROM consultant_profiles WHERE user_id = $1 AND organization_id = $2',
        [consultantId, orgId],
    );
    await pruneResumes(orgId, consultantId, [rows[0]?.base_resume_artifact_id]);
};

/* ── validation ──────────────────────────────────────────────────────── */

// Built from the registry via joiForField, so a new consultant-editable field
// is accepted automatically, and a rule added there — a phone digit count, a
// URL host — takes effect here without touching this schema.
// `career` is validated a second time, properly, against each section's own
// schema inside submitChangeRequest — SECTIONS[name].schema knows the real
// per-item rules (required fields, max lengths) that a generic array-of-object
// check here cannot express. This first pass only keeps the request body a
// sane shape before that happens.
const careerPayloadSchema = Joi.object({
    skills: Joi.array().items(Joi.object().unknown(true)).max(200),
    education: Joi.array().items(Joi.object().unknown(true)).max(100),
    experience: Joi.array().items(Joi.object().unknown(true)).max(100),
    projects: Joi.array().items(Joi.object().unknown(true)).max(100),
    certifications: Joi.array().items(Joi.object().unknown(true)).max(100),
});

export const submitChangeSchema = Joi.object({
    ...Object.fromEntries(CONSULTANT_EDITABLE.map((name) => [name, joiForField(Joi, name)])),
    career: careerPayloadSchema,
}).or(...CONSULTANT_EDITABLE, 'career');

/**
 * ONE decision for the whole submission, not one per field.
 *
 * The review screen still shows every individual change for context — see
 * listChangeRequests — but the ACTION is a single button, and this is its
 * whole request body.
 */
export const reviewSchema = Joi.object({
    decision: Joi.string().valid('APPROVED', 'REJECTED').required(),
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

        // ── the career half ──────────────────────────────────────────
        //
        // Built and diffed BEFORE the "nothing changed" check below, so a
        // submission that only touched skills or added a job — no identity
        // field involved at all — is still recognised as a real change rather
        // than rejected as empty.
        let careerSnapshot = null;
        let careerSummary = [];
        if (req.body.career) {
            const built = await buildCareerSnapshot(req.body.career);
            if (!built.ok) return res.status(422).json({ error: built.error });

            const live = await loadLiveCareer(consultantId);
            const diff = diffCareer(live, built.snapshot);
            if (diff.changed) {
                careerSnapshot = built.snapshot;
                careerSummary = diff.summary;
            }
        }

        if (changed.length === 0 && !careerSnapshot) {
            return res.status(422).json({
                error: 'Nothing changed. Edit at least one field before submitting.',
            });
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
            if (careerSnapshot) {
                const cols = Object.keys(careerSnapshot);
                await client.query(
                    `INSERT INTO profile_change_request_career
                        (change_request_id, organization_id, ${cols.join(', ')})
                     VALUES ($1,$2,${cols.map((_, i) => `$${i + 3}::jsonb`).join(',')})`,
                    [id, orgId, ...cols.map((c) => JSON.stringify(careerSnapshot[c]))],
                );
            }
            return id;
        });

        const fieldLabels = changed.map((c) => PROFILE_FIELDS[c.field_name].label);
        const parts = [...fieldLabels, ...careerSummary];
        logAction({
            orgId, module: 'profile_changes', action: 'Submitted Profile Changes',
            entityType: 'ProfileChangeRequest', entityId: requestId,
            entityName: req.user.name ?? 'Consultant',
            performedBy: consultantId, performedByRole: 'CONSULTANT',
            description: `Submitted for approval: ${parts.join(', ') || 'no readable summary'}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            message: 'Changes submitted for approval.',
            requestId,
            fieldCount: changed.length,
            careerChanged: Boolean(careerSnapshot),
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

        // Any resume uploaded for the withdrawn request is now unreachable —
        // remove it so it neither takes disk space nor stays downloadable.
        cleanupResumes(req.user.orgId, req.user.id).catch((err) =>
            console.error('Resume cleanup after withdraw failed:', err.message));

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
        const paging = readPaging(req);

        // LEFT JOIN, not INNER: a request that only changed the career
        // record has ZERO rows in profile_change_request_fields, and an
        // INNER JOIN here made it vanish from every reviewer's queue
        // entirely — invisible, not merely unlabelled. It sat PENDING
        // forever because nobody could see it existed.
        const { rows } = await query(
            `SELECT COUNT(*) OVER () AS total_count,
                    c.id, c.status, c.submitted_at, c.reviewed_at, c.review_note,
                    c.consultant_id,
                    u.name AS consultant_name, u.email AS consultant_email,
                    -- so the queue can flag a suspended consultant rather than
                    -- letting the reviewer decide blind (C-2)
                    u.employment_status AS consultant_employment_status,
                    rev.name AS reviewed_by_name, rev.role AS reviewed_by_role,
                    rec.name AS recruiter_name,
                    -- H-2. An unassigned consultant's request is technically
                    -- visible to an ORG_ADMIN, but no recruiter will ever pick
                    -- it up because recruiters only see their own. Without a
                    -- flag it sits in the list looking like everyone else's and
                    -- waits for a reviewer who is never coming.
                    (a.recruiter_id IS NULL) AS is_unassigned,
                    COUNT(f.id)::int AS field_count,
                    COALESCE(json_agg(json_build_object(
                        'id', f.id,
                        'field_name', f.field_name,
                        'old_display', f.old_display,
                        'new_display', f.new_display
                    ) ORDER BY f.field_name) FILTER (WHERE f.id IS NOT NULL), '[]') AS fields,
                    (cc.change_request_id IS NOT NULL) AS has_career_changes
               FROM profile_change_requests c
               JOIN users u ON u.id = c.consultant_id
          LEFT JOIN profile_change_request_fields f ON f.change_request_id = c.id
          LEFT JOIN profile_change_request_career cc ON cc.change_request_id = c.id
          LEFT JOIN users rev ON rev.id = c.reviewed_by
          LEFT JOIN assignments a
                 ON a.consultant_id = c.consultant_id AND a.effective_to IS NULL
          LEFT JOIN users rec ON rec.id = a.recruiter_id
              WHERE c.organization_id = $1
                AND ($2::text = 'ALL' OR c.status = $2)
                AND ($3::text IS NULL OR a.recruiter_id = $3)
              GROUP BY c.id, u.name, u.email, u.employment_status,
                       rev.name, rev.role, rec.name, a.recruiter_id,
                       cc.change_request_id
              -- Unassigned first: they are the ones that will otherwise sit
              -- forever, so they are the ones an admin needs to see.
              ORDER BY (a.recruiter_id IS NULL) DESC, c.submitted_at ASC
              LIMIT $4 OFFSET $5`,
            [orgId, status, role === 'RECRUITER' ? userId : null,
                paging.limit, paging.offset],
        );

        // Career diffs computed against LIVE data, for the rows that have one.
        // Cheap in practice: at most one PENDING request per consultant (a
        // database constraint), so this is bounded by page size, not by the
        // whole org.
        for (const row of rows) {
            if (!row.has_career_changes) { row.career = null; continue; }
            const { rows: snap } = await query(
                'SELECT * FROM profile_change_request_career WHERE change_request_id = $1',
                [row.id],
            );
            const proposed = snap[0] ?? {};
            const cols = ['skills', 'education', 'experience', 'projects', 'certifications'];
            const snapshot = Object.fromEntries(
                cols.filter((c) => proposed[c] !== null && proposed[c] !== undefined)
                    .map((c) => [c, proposed[c]]),
            );
            const live = await loadLiveCareer(row.consultant_id);
            row.career = { snapshot, live, summary: diffCareer(live, snapshot).summary };
        }

        const result = pageResult(rows, paging);
        return res.json({ requests: result.data, page: result.page });
    } catch (err) {
        return next(err);
    }
};

/* ── reviewer: decide ────────────────────────────────────────────────── */

/**
 * POST /api/management/profile-changes/:id/review
 *
 * Body: { decision: 'APPROVED' | 'REJECTED', reviewNote }
 *
 * One decision for the whole submission — identity fields and the career
 * snapshot together. Approving writes both into their live tables in the
 * SAME transaction as closing the request, so a value can never be marked
 * approved without actually going live, or vice versa.
 */
export const reviewChangeRequest = async (req, res, next) => {
    try {
        const { orgId } = req.user;

        const { rows: reqRows } = await query(
            `SELECT c.*, u.name AS consultant_name, u.employment_status
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

        // C-2, defence in depth. Termination cancels pending requests in the
        // same transaction, so this should be unreachable — unless a reviewer
        // had the screen open when the termination landed and posts a stale
        // decision. Refuse rather than push values live for a non-employee.
        if (request.employment_status === 'TERMINATED') {
            return res.status(409).json({
                error: 'This consultant has been terminated. Their pending changes were cancelled.',
            });
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
        const { rows: careerRows } = await query(
            'SELECT * FROM profile_change_request_career WHERE change_request_id = $1',
            [req.params.id],
        );
        const careerProposed = careerRows[0] ?? null;

        const approving = req.body.decision === 'APPROVED';
        // Every field gets the SAME decision — this is the one place the old
        // per-field granularity collapses to a single button. Kept as an
        // array of individual decisions under the hood so the rest of this
        // function, including the stale-value guard below, needed no rewrite.
        const decisions = fieldRows.map((f) => ({ fieldName: f.field_name, decision: req.body.decision }));
        const approved = approving ? decisions : [];
        const rejected = approving ? [] : decisions;

        await withTransaction(async (client) => {
            // ── 0. Has the live value moved since this was submitted? ──
            //
            // The diff shown to the reviewer is honest: old_value is snapshotted
            // when the consultant submits, so the screen always shows what they
            // were changing FROM. What it cannot show is an admin editing the
            // same field in the meantime.
            //
            // Approving blind would then silently discard that admin's edit —
            // a lost update in the one workflow whose entire purpose is that a
            // second person sees the change before it goes live. So the live row
            // is re-read inside the transaction and compared against the
            // snapshot; anything that moved is refused rather than overwritten.
            //
            // This guard covers identity fields only. The equivalent risk on the
            // career side — an admin hand-editing a consultant's skills through
            // the management CRUD endpoints while a submission sits pending — is
            // accepted rather than guarded: the snapshot IS the consultant's
            // whole intended career state, and approving replaces the live rows
            // with it regardless of what an admin did in between. See
            // services/careerApproval.js.
            if (approved.length) {
                const { rows: liveRows } = await client.query(
                    'SELECT * FROM consultant_profiles WHERE user_id = $1 AND organization_id = $2',
                    [request.consultant_id, orgId],
                );
                const live = liveRows[0] ?? {};
                const byName = new Map(fieldRows.map((f) => [f.field_name, f]));

                const moved = approved.filter((d) => {
                    const snapshot = byName.get(d.fieldName)?.old_value ?? null;
                    const current = live[d.fieldName];
                    const asText = current === null || current === undefined
                        ? null
                        : String(current);
                    return asText !== snapshot;
                });

                if (moved.length) {
                    const err = new Error('stale');
                    err.stale = moved.map((d) => d.fieldName);
                    throw err;
                }
            }

            // 1. Copy approved identity fields into the live profile.
            if (approved.length) {
                const byName = new Map(fieldRows.map((f) => [f.field_name, f]));
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

            // 2. Replace the career tables with the approved snapshot.
            if (approving && careerProposed) {
                const cols = ['skills', 'education', 'experience', 'projects', 'certifications'];
                const snapshot = Object.fromEntries(
                    cols.filter((c) => careerProposed[c] !== null && careerProposed[c] !== undefined)
                        .map((c) => [c, careerProposed[c]]),
                );
                await applyCareerSnapshot(client, {
                    orgId, consultantId: request.consultant_id, snapshot,
                });
            }

            // 3. Record every per-field decision (still granular in storage,
            // even though the action that produced them was one button — the
            // audit trail should still read like a field-by-field record).
            for (const d of decisions) {
                await client.query(
                    `UPDATE profile_change_request_fields
                        SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
                      WHERE change_request_id = $4 AND field_name = $5`,
                    [d.decision, req.user.id, req.body.reviewNote || null, req.params.id, d.fieldName],
                );
            }

            // 4. Close the request.
            await client.query(
                `UPDATE profile_change_requests
                    SET status = $1, reviewed_by = $2, reviewed_at = now(),
                        review_note = $3, updated_by = $2
                  WHERE id = $4`,
                [req.body.decision, req.user.id, req.body.reviewNote || null, req.params.id],
            );
        });

        // The profile now points at whichever resume won. Delete the loser —
        // an approved upload supersedes the old file, a rejected one is
        // discarded. Never blocks the response.
        if (decisions.some((d) => d.fieldName === RESUME_FIELD)) {
            cleanupResumes(orgId, request.consultant_id).catch((err) =>
                console.error('Resume cleanup after review failed:', err.message));
        }

        const fieldLabels = decisions.map((d) => PROFILE_FIELDS[d.fieldName].label);
        const parts = [];
        if (fieldLabels.length) parts.push(`fields: ${fieldLabels.join(', ')}`);
        if (careerProposed) parts.push('career record');

        logAction({
            orgId, module: 'profile_changes',
            action: approving ? 'Approved Profile Changes' : 'Rejected Profile Changes',
            entityType: 'ProfileChangeRequest', entityId: req.params.id,
            entityName: request.consultant_name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `${approving ? 'Approved' : 'Rejected'} the whole submission for `
                + `"${request.consultant_name}" — ${parts.join('; ') || '(nothing readable to summarise)'}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            message: 'Review recorded.',
            status: req.body.decision,
            approved: approved.length,
            rejected: rejected.length,
        });
    } catch (err) {
        // Somebody edited the live profile while this review was open. Naming
        // the fields matters: the reviewer has to know WHAT moved to decide
        // whether their approval still stands.
        if (err.stale) {
            return res.status(409).json({
                error: 'The live profile changed while you were reviewing. '
                    + `Reload to see the current values before approving: ${err.stale.join(', ')}.`,
                staleFields: err.stale,
            });
        }
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
