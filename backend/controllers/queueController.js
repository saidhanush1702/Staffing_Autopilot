/**
 * ── THE QUEUE, FROM THE PORTAL SIDE ───────────────────────────────────
 *
 * Recruiters and admins moving items by hand. The desktop app moves the same
 * items through `deviceController`, and both call the same guard — so there is
 * exactly one definition of what a legal move is, and neither surface can
 * reach a state the other would refuse.
 *
 * ── WHAT IS ABSENT ON PURPOSE ─────────────────────────────────────────
 *
 * There is no route that moves an item to a different consultant. R-03 is
 * enforced by there being nothing to call, not by a permission check that could
 * be misconfigured. A recruiter who wants somebody else to have a job skips it
 * here and lets discovery match it there.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { checkTransition, allowedFrom } from '../config/queueStates.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction } from './auditLogController.js';

export const transitionSchema = Joi.object({
    // Absent on /skip and /requeue, which imply their own target.
    to: Joi.string().max(30),
    reason: Joi.string().max(500).allow('', null),
}).min(1);

/** The item, plus enough context to authorise and audit the move. */
const loadItem = async (orgId, itemId) => {
    const { rows } = await query(
        `SELECT q.id, q.consultant_id, q.status_id, q.channel, q.leased_by, q.leased_until,
                st.name AS status,
                p.company, p.title,
                u.name AS consultant_name
           FROM queue_items q
           JOIN lkp_queue_statuses st ON st.id = q.status_id
           JOIN job_postings p ON p.id = q.posting_id
           JOIN users u ON u.id = q.consultant_id
          WHERE q.id = $1 AND q.organization_id = $2`,
        [itemId, orgId],
    );
    return rows[0] ?? null;
};

const statusIdFor = async (name) => {
    const { rows } = await query('SELECT id FROM lkp_queue_statuses WHERE name = $1', [name]);
    return rows[0]?.id ?? null;
};

/**
 * One move, authorised, guarded, recorded.
 *
 * The 404 for an unassigned consultant is deliberate rather than a 403: a
 * recruiter should not be able to learn that a queue item exists for somebody
 * outside their bench.
 */
const performMove = async (req, res, toState) => {
    const item = await loadItem(req.user.orgId, req.params.id);
    if (!item) return res.status(404).json({ error: 'Queue item not found.' });

    if (!(await canAccessConsultant(req.user, item.consultant_id))) {
        return res.status(404).json({ error: 'Queue item not found.' });
    }

    const reason = req.body.reason;
    const verdict = checkTransition(item.status, toState, { reason });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    // A device is mid-fill on this item. Its lease is the authority until it
    // lapses — yanking the item away while a browser is typing into a form is
    // how a half-filled application gets submitted.
    if (item.leased_by && item.leased_until && new Date(item.leased_until) > new Date()
        && !['CANCELLED', 'SKIPPED'].includes(toState)) {
        return res.status(409).json({
            error: 'The desktop app is working on this item. Try again shortly, '
                + 'or cancel it if it needs to stop now.',
        });
    }

    const toId = await statusIdFor(toState);

    await withTransaction(async (client) => {
        await client.query(
            `UPDATE queue_items
                SET status_id = $2,
                    skip_reason   = CASE WHEN $3 = 'SKIPPED'   THEN $4 ELSE skip_reason END,
                    cancel_reason = CASE WHEN $3 = 'CANCELLED' THEN $4 ELSE cancel_reason END,
                    cancelled_at  = CASE WHEN $3 = 'CANCELLED' THEN now() ELSE cancelled_at END,
                    cancelled_by  = CASE WHEN $3 = 'CANCELLED' THEN $5 ELSE cancelled_by END,
                    -- leaving a live state frees the slot; SUBMITTED keeps it,
                    -- because it was genuinely spent
                    became_ready_at = CASE WHEN $3 IN ('SKIPPED','CANCELLED','QUEUED')
                                           THEN NULL ELSE became_ready_at END,
                    leased_by = NULL, leased_until = NULL,
                    updated_by = $5, updated_at = now()
              WHERE id = $1`,
            [item.id, toId, toState, reason ?? null, req.user.id],
        );
        await client.query(
            `INSERT INTO queue_item_transitions
                (id, organization_id, queue_item_id, from_status_id, to_status_id,
                 reason, performed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [uuidv4(), req.user.orgId, item.id, item.status_id, toId,
                reason ?? `Moved to ${toState}`, req.user.id],
        );
    });

    logAction({
        orgId: req.user.orgId, module: 'queue',
        action: `Queue ${toState.toLowerCase()}`,
        entityType: 'QueueItem', entityId: item.id,
        entityName: `${item.title} at ${item.company}`,
        performedBy: req.user.id, performedByRole: req.user.role,
        description: `${item.status} → ${toState} for ${item.consultant_name}`
            + (reason ? ` — ${reason}` : ''),
        ipAddress: req.ip,
    }).catch(() => {});

    return res.json({ ok: true, from: item.status, to: toState });
};

/** POST /api/management/queue/:id/skip — reason mandatory (state machine). */
export const skipItem = (req, res, next) => performMove(req, res, 'SKIPPED').catch(next);

/** POST /api/management/queue/:id/requeue — the only way back from SKIPPED. */
export const requeueItem = (req, res, next) => performMove(req, res, 'QUEUED').catch(next);

/**
 * POST /api/management/queue/:id/cancel — ORG_ADMIN only.
 *
 * Distinct from skipping. Skipping is a decision about a job; cancelling voids
 * the item because the queue itself should not exist any more. Keeping them
 * apart is what makes "why did this person apply to so few jobs" answerable.
 */
export const cancelItem = (req, res, next) => performMove(req, res, 'CANCELLED').catch(next);

/** POST /api/management/queue/:id/transition — the general move. */
export const transitionItem = (req, res, next) => {
    if (!req.body.to) {
        return res.status(422).json({ error: 'A target state is required.' });
    }
    return performMove(req, res, String(req.body.to).toUpperCase()).catch(next);
};

/**
 * GET /api/management/queue/:id
 *
 * The item, why it was matched, and every move it has made. The history is the
 * answer to "what happened to this application?" and is the reason each
 * transition is written as its own row rather than overwriting a status.
 */
export const getQueueItem = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT q.*, st.name AS status_name, st.label AS status_label,
                    p.company, p.title, p.location_text, p.is_remote, p.source_url,
                    p.pay_min, p.pay_max, p.pay_unit, p.description,
                    pt.label AS portal_label, src.label AS source_label,
                    m.score, m.reason AS match_reason,
                    v.version_no AS criteria_version_no,
                    u.name AS consultant_name,
                    qn.question_text AS parked_question
               FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
               JOIN job_postings p ON p.id = q.posting_id
               JOIN users u ON u.id = q.consultant_id
          LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
          LEFT JOIN lkp_job_sources src ON src.id = p.first_source_id
          LEFT JOIN job_matches m ON m.id = q.match_id
          LEFT JOIN search_criteria_versions v ON v.id = m.criteria_version_id
          LEFT JOIN questions qn ON qn.id = q.parked_question_id
              WHERE q.id = $1 AND q.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );

        const item = rows[0];
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });
        if (!(await canAccessConsultant(req.user, item.consultant_id))) {
            return res.status(404).json({ error: 'Queue item not found.' });
        }

        const { rows: history } = await query(
            `SELECT t.created_at, t.reason,
                    fs.label AS from_label, ts.label AS to_label,
                    u.name AS performed_by_name
               FROM queue_item_transitions t
          LEFT JOIN lkp_queue_statuses fs ON fs.id = t.from_status_id
               JOIN lkp_queue_statuses ts ON ts.id = t.to_status_id
          LEFT JOIN users u ON u.id = t.performed_by
              WHERE t.queue_item_id = $1
              ORDER BY t.created_at ASC`,
            [req.params.id],
        );

        return res.json({
            item,
            history,
            // What this item may legally do next, so the screen renders the
            // real options rather than a guess that the server then refuses.
            allowedTransitions: allowedFrom(item.status_name),
        });
    } catch (err) {
        return next(err);
    }
};

/* ── application records, read side ───────────────────────────────────── */

/**
 * GET /api/management/consultants/:id/applications
 *
 * The permanent record of what was actually sent. Read-only by construction —
 * there is no route that edits or deletes one, and the database refuses it
 * regardless.
 *
 * `submitted_via` is returned because it is the difference between "software
 * watched this happen" and "somebody told us it happened", and a screen that
 * cannot show that overstates what the record knows.
 */
export const listApplications = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }

        const { rows } = await query(
            `SELECT a.id, a.company, a.job_title, a.job_url, a.portal_label,
                    a.submitted_at, a.notes,
                    s.name AS status, s.label AS status_label,
                    m.name AS submitted_via, m.label AS submitted_via_label,
                    m.is_witnessed,
                    u.name AS recorded_by_name,
                    d.machine_label,
                    (SELECT COUNT(*)::int FROM application_qa q
                      WHERE q.application_id = a.id) AS answer_count
               FROM application_records a
               JOIN lkp_application_statuses s ON s.id = a.status_id
               JOIN lkp_submission_methods m ON m.id = a.submission_method_id
          LEFT JOIN users u ON u.id = a.recorded_by
          LEFT JOIN devices d ON d.id = a.device_id
              WHERE a.consultant_id = $1 AND a.organization_id = $2
              ORDER BY a.submitted_at DESC
              LIMIT 200`,
            [req.params.id, req.user.orgId],
        );

        return res.json({ applications: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/applications/:id
 *
 * One record with the exact questions and answers, in the order the form asked
 * them. The question text is what the EMPLOYER wrote, not a link to the
 * question bank — so it stays true even after the canonical wording changes.
 */
export const getApplication = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT a.*, s.label AS status_label,
                    m.name AS submitted_via, m.label AS submitted_via_label, m.is_witnessed,
                    c.name AS consultant_name, u.name AS recorded_by_name,
                    d.machine_label
               FROM application_records a
               JOIN lkp_application_statuses s ON s.id = a.status_id
               JOIN lkp_submission_methods m ON m.id = a.submission_method_id
               JOIN users c ON c.id = a.consultant_id
          LEFT JOIN users u ON u.id = a.recorded_by
          LEFT JOIN devices d ON d.id = a.device_id
              WHERE a.id = $1 AND a.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );

        const application = rows[0];
        if (!application) return res.status(404).json({ error: 'Application record not found.' });
        if (!(await canAccessConsultant(req.user, application.consultant_id))) {
            return res.status(404).json({ error: 'Application record not found.' });
        }

        const { rows: qa } = await query(
            `SELECT position, question_text, answer_text, field_type
               FROM application_qa
              WHERE application_id = $1
              ORDER BY position ASC`,
            [req.params.id],
        );

        return res.json({ application, qa });
    } catch (err) {
        return next(err);
    }
};
