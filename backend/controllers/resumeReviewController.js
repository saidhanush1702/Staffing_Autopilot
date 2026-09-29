/**
 * ── THE FABRICATION REVIEW GATE ───────────────────────────────────────
 *
 * When the check finds a claim it cannot trace back to the base resume, the
 * queue item stops at RESUME_REVIEW instead of going out. This is what a person
 * uses to decide about it.
 *
 * ── WHY A HUMAN GATE AT ALL ───────────────────────────────────────────
 *
 * The flags come from two places and they are not equally certain. A RULE or
 * STRUCTURE flag is a fact — this number is not in the original, this employer
 * is not in the original — and a MODEL flag is an opinion, which can be wrong in
 * both directions. Auto-rejecting on an opinion throws away good tailoring;
 * auto-accepting makes the whole check decorative. A person deciding, with the
 * two documents side by side, is the only honest resolution.
 *
 * ── WHO DECIDES ───────────────────────────────────────────────────────
 *
 * Management approves. The consultant sees everything and may REJECT — "use my
 * base resume" — but cannot approve.
 *
 * That asymmetry is the same one every other approval flow here already has:
 * the consultant is the SUBJECT of the record, and management is the reviewer.
 * The consultant is also the person who would be asked about a fabricated claim
 * at interview, so their ability to veto it is the more important half.
 *
 * ── WHAT THE RULES SCREEN NEVER SHOWS ─────────────────────────────────
 *
 * The prompt. The flagged claims, their severity and the checker's reasoning
 * are all visible; the instruction set that produced them lives in
 * config/tailoringRules.js and is reachable from no route at any level.
 */
import Joi from 'joi';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { checkTransition } from '../config/queueStates.js';
import { flattenResumeText } from '../config/resumeSchema.js';
import { canAccessConsultant } from '../utils/scope.js';
import { enqueueOnce } from '../jobs/worker.js';
import { KIND as TAILOR_KIND } from '../jobs/handlers/tailorResume.js';
import { logAction } from './auditLogController.js';

export const reviewDecisionSchema = Joi.object({
    reason: Joi.string().trim().max(500).allow('', null).default(null),
});

const statusIds = async () => {
    const { rows } = await query('SELECT id, name FROM lkp_queue_statuses');
    return Object.fromEntries(rows.map((r) => [r.name, r.id]));
};

/**
 * Load a waiting item, refusing anything the caller may not see.
 *
 * An out-of-scope id returns null and the caller answers 404 rather than 403,
 * which is the convention already used across this codebase: a 403 confirms the
 * id exists, and existence is itself information about another agency's data.
 */
const loadItem = async (user, itemId, { consultantOnly = false } = {}) => {
    const { rows } = await query(
        `SELECT q.id, q.consultant_id, q.organization_id,
                st.name AS status, q.tailoring_state,
                p.company, p.title, p.description, p.source_url,
                u.name AS consultant_name
           FROM queue_items q
           JOIN lkp_queue_statuses st ON st.id = q.status_id
           JOIN job_postings p ON p.id = q.posting_id
           JOIN users u ON u.id = q.consultant_id
          WHERE q.id = $1 AND q.organization_id = $2`,
        [itemId, user.orgId],
    );
    const item = rows[0];
    if (!item) return null;

    if (consultantOnly) {
        return item.consultant_id === user.id ? item : null;
    }
    // A recruiter is narrowed to their own assigned consultants here rather
    // than at the route, because it cannot be expressed as a role guard.
    return (await canAccessConsultant(user, item.consultant_id)) ? item : null;
};

/** The tailored file made for this item, flagged and not yet attached. */
const loadArtifacts = async (itemId) => {
    const { rows } = await query(
        `SELECT r.id, r.original_name, r.ats_score_before, r.ats_score_after,
                r.provider, r.model, r.generated_at, r.size_bytes, r.sections,
                b.id AS base_id, b.original_name AS base_name
           FROM resume_artifacts r
      LEFT JOIN resume_artifacts b ON b.id = r.source_artifact_id
          WHERE r.queue_item_id = $1 AND r.kind = 'tailored'
          ORDER BY r.generated_at DESC NULLS LAST
          LIMIT 1`,
        [itemId],
    );
    return rows[0] ?? null;
};

const loadFlags = async (itemId) => {
    const { rows } = await query(
        `SELECT id, claim_text, section, severity, detected_by, reason,
                reviewer_verdict, reviewed_at
           FROM resume_fabrication_flags
          WHERE queue_item_id = $1
          ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                   created_at`,
        [itemId],
    );
    return rows;
};

/* ── reading ───────────────────────────────────────────────────────── */

/**
 * GET /api/management/resume-reviews
 * GET /api/portal/resume-reviews
 *
 * What is waiting on a person. Ordered worst-first — an item with a fabricated
 * qualification should not sit behind ten items with a slightly bold verb.
 */
export const listReviews = async (req, res, next) => {
    try {
        const mine = req.user.role === 'CONSULTANT';

        const { rows } = await query(
            `SELECT q.id, q.consultant_id, u.name AS consultant_name,
                    p.company, p.title, q.updated_at,
                    COUNT(f.id)::int                                        AS flag_count,
                    COUNT(f.id) FILTER (WHERE f.severity = 'HIGH')::int     AS high_count,
                    COUNT(f.id) FILTER (WHERE f.detected_by <> 'MODEL')::int AS proven_count,
                    r.ats_score_before, r.ats_score_after
               FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
               JOIN job_postings p ON p.id = q.posting_id
               JOIN users u ON u.id = q.consultant_id
          LEFT JOIN resume_fabrication_flags f ON f.queue_item_id = q.id
          LEFT JOIN resume_artifacts r
                 ON r.queue_item_id = q.id AND r.kind = 'tailored'
              WHERE q.organization_id = $1
                AND st.name = 'RESUME_REVIEW'
                AND ($2::text IS NULL OR q.consultant_id = $2)
           GROUP BY q.id, u.name, p.company, p.title, q.updated_at,
                    r.ats_score_before, r.ats_score_after
           ORDER BY COUNT(f.id) FILTER (WHERE f.severity = 'HIGH') DESC,
                    q.updated_at ASC`,
            [req.user.orgId, mine ? req.user.id : null],
        );

        // A recruiter sees only their own consultants. Filtered after the query
        // rather than joined into it, because assignment scope lives behind
        // canAccessConsultant and is not a column on this join.
        const visible = req.user.role === 'RECRUITER'
            ? (await Promise.all(rows.map(async (r) => (
                (await canAccessConsultant(req.user, r.consultant_id)) ? r : null
            )))).filter(Boolean)
            : rows;

        return res.json({ items: visible, total: visible.length });
    } catch (err) {
        return next(err);
    }
};

/** GET .../resume-reviews/count — for the sidebar badge. */
export const reviewCount = async (req, res, next) => {
    try {
        const mine = req.user.role === 'CONSULTANT';
        const { rows } = await query(
            `SELECT COUNT(*)::int AS n
               FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
              WHERE q.organization_id = $1 AND st.name = 'RESUME_REVIEW'
                AND ($2::text IS NULL OR q.consultant_id = $2)`,
            [req.user.orgId, mine ? req.user.id : null],
        );
        return res.json({ count: rows[0]?.n ?? 0 });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/resume-reviews/:itemId
 * GET /api/portal/resume-reviews/:itemId
 *
 * Everything needed to decide: the job, both resumes, and every flag with the
 * reason it was raised.
 */
export const getReview = async (req, res, next) => {
    try {
        const mine = req.user.role === 'CONSULTANT';
        const item = await loadItem(req.user, req.params.itemId, { consultantOnly: mine });
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        const [artifact, flags] = await Promise.all([
            loadArtifacts(item.id),
            loadFlags(item.id),
        ]);

        // The structured form of the base resume, so the client can show the two
        // side by side rather than making the reviewer download a PDF to compare.
        const { rows: docRows } = await query(
            `SELECT d.sections
               FROM resume_documents d
               JOIN resume_artifacts b ON b.sha256 = d.sha256
                                      AND b.organization_id = d.organization_id
              WHERE b.id = $1
              LIMIT 1`,
            [artifact?.base_id ?? '-'],
        );

        return res.json({
            item: {
                id: item.id,
                status: item.status,
                tailoringState: item.tailoring_state,
                consultantId: item.consultant_id,
                consultantName: item.consultant_name,
                company: item.company,
                title: item.title,
                sourceUrl: item.source_url,
            },
            artifact,
            baseSections: docRows[0]?.sections ?? null,
            // Both texts flattened the SAME way the fabrication checker
            // flattened them, so a flag's claim_text is a substring of the
            // text it is highlighted in. Re-extracting from the PDF instead
            // would move line breaks and silently break the highlight on
            // exactly the long, specific claims that matter most.
            baseText: docRows[0]?.sections ? flattenResumeText(docRows[0].sections) : null,
            tailoredText: artifact?.sections ? flattenResumeText(artifact.sections) : null,
            flags,
            // What the reviewer can actually do from here. Sent by the server so
            // the client never has to encode the permission rule a second time.
            canApprove: !mine,
            canReject: true,
            canRetry: !mine,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── deciding ──────────────────────────────────────────────────────── */

/**
 * Record a decision on every flag and move the item.
 *
 * The flags are updated as well as the item, because "who accepted this claim,
 * and when" is the question that matters six months later — a queue item that
 * merely says READY answers none of it.
 */
const decide = async ({
    req, item, to, tailoringState, skipReason, verdict, attachArtifactId, reason,
}) => {
    const ids = await statusIds();
    const check = checkTransition(item.status, to, { reason });
    if (!check.ok) return { error: check.error, status: check.status };

    await withTransaction(async (client) => {
        await client.query(
            `UPDATE queue_items
                SET status_id = $2,
                    tailoring_state = $3,
                    tailoring_skip_reason = $4,
                    tailored_resume_artifact_id = $5,
                    became_ready_at = CASE WHEN $6 = 'READY' THEN now() ELSE became_ready_at END,
                    updated_by = $7
              WHERE id = $1`,
            [item.id, ids[to], tailoringState, skipReason,
                attachArtifactId ?? null, to, req.user.id],
        );

        await client.query(
            `INSERT INTO queue_item_transitions
                (id, organization_id, queue_item_id, from_status_id, to_status_id,
                 reason, performed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [randomUUID(), req.user.orgId, item.id, ids[item.status], ids[to],
                String(reason).slice(0, 500), req.user.id],
        );

        if (verdict) {
            await client.query(
                `UPDATE resume_fabrication_flags
                    SET reviewer_verdict = $2, reviewed_by = $3, reviewed_at = now()
                  WHERE queue_item_id = $1 AND reviewer_verdict = 'PENDING'`,
                [item.id, verdict, req.user.id],
            );
        }
    });

    return { ok: true };
};

/**
 * POST /api/management/resume-reviews/:itemId/approve
 *
 * The reviewer read the flags and is satisfied. The tailored resume is attached
 * and the item goes to READY — which is the first moment the desktop app can
 * reach that file.
 */
export const approveReview = async (req, res, next) => {
    try {
        const item = await loadItem(req.user, req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });
        if (item.status !== 'RESUME_REVIEW') {
            return res.status(409).json({ error: `This item is ${item.status}, not awaiting review.` });
        }

        const artifact = await loadArtifacts(item.id);
        if (!artifact) {
            return res.status(409).json({
                error: 'There is no tailored resume on this item to approve.',
            });
        }

        const reason = req.body?.reason?.trim()
            || 'The tailored resume was reviewed and approved.';

        const result = await decide({
            req,
            item,
            to: 'READY',
            tailoringState: 'TAILORED',
            skipReason: null,
            verdict: 'ACCEPTED',
            attachArtifactId: artifact.id,
            reason,
        });
        if (result.error) return res.status(result.status).json({ error: result.error });

        logAction({
            orgId: req.user.orgId,
            module: 'resumes',
            action: 'Approved Tailored Resume',
            entityType: 'QueueItem',
            entityId: item.id,
            entityName: `${item.company} — ${item.title}`,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Approved the tailored resume for ${item.consultant_name} `
                + `despite the fabrication check's flags. ${reason}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ ok: true, status: 'READY', tailoringState: 'TAILORED' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/resume-reviews/:itemId/reject
 * POST /api/portal/resume-reviews/:itemId/reject
 *
 * Use the base resume instead. Open to the consultant as well as management —
 * the person whose name is on the document gets to decline what was written
 * under it.
 *
 * The tailored file is deliberately NOT deleted. It is the evidence of what the
 * model produced and why it was refused, which is exactly what anyone tuning
 * the prompt will need.
 */
export const rejectReview = async (req, res, next) => {
    try {
        const mine = req.user.role === 'CONSULTANT';
        const item = await loadItem(req.user, req.params.itemId, { consultantOnly: mine });
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });
        if (item.status !== 'RESUME_REVIEW') {
            return res.status(409).json({ error: `This item is ${item.status}, not awaiting review.` });
        }

        const reason = req.body?.reason?.trim()
            || 'The tailored resume was rejected; the base resume will be used.';

        const result = await decide({
            req,
            item,
            to: 'READY',
            tailoringState: 'NOT_TAILORED',
            skipReason: 'REVIEW_REJECTED',
            verdict: 'REJECTED',
            // Nothing attached, so the desktop app's COALESCE falls through to
            // the base resume — which is the whole point of rejecting.
            attachArtifactId: null,
            reason,
        });
        if (result.error) return res.status(result.status).json({ error: result.error });

        logAction({
            orgId: req.user.orgId,
            module: 'resumes',
            action: 'Rejected Tailored Resume',
            entityType: 'QueueItem',
            entityId: item.id,
            entityName: `${item.company} — ${item.title}`,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Rejected the tailored resume for ${item.consultant_name}. `
                + `The base resume will be sent instead. ${reason}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ ok: true, status: 'READY', tailoringState: 'NOT_TAILORED' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/resume-reviews/:itemId/retry
 *
 * Try again. The item returns to PREPARING and a fresh job is queued.
 *
 * The old flags are cleared rather than kept: they describe a document that is
 * about to be replaced, and leaving them would make the next review show
 * findings against a resume nobody can see any more.
 */
export const retryReview = async (req, res, next) => {
    try {
        const item = await loadItem(req.user, req.params.itemId);
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });
        if (item.status !== 'RESUME_REVIEW') {
            return res.status(409).json({ error: `This item is ${item.status}, not awaiting review.` });
        }

        const reason = req.body?.reason?.trim() || 'Sent back for another tailoring attempt.';
        const ids = await statusIds();

        const check = checkTransition(item.status, 'PREPARING', { reason });
        if (!check.ok) return res.status(check.status).json({ error: check.error });

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE queue_items
                    SET status_id = $2, tailoring_state = 'PENDING',
                        tailoring_skip_reason = NULL, preparation_error = NULL,
                        updated_by = $3
                  WHERE id = $1`,
                [item.id, ids.PREPARING, req.user.id],
            );
            await client.query(
                `INSERT INTO queue_item_transitions
                    (id, organization_id, queue_item_id, from_status_id, to_status_id,
                     reason, performed_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                [randomUUID(), req.user.orgId, item.id, ids.RESUME_REVIEW, ids.PREPARING,
                    String(reason).slice(0, 500), req.user.id],
            );
            await client.query(
                'DELETE FROM resume_fabrication_flags WHERE queue_item_id = $1',
                [item.id],
            );
            await enqueueOnce({
                orgId: req.user.orgId,
                kind: TAILOR_KIND,
                payload: { queueItemId: item.id },
                dedupeOn: 'queueItemId',
            }, client);
        });

        logAction({
            orgId: req.user.orgId,
            module: 'resumes',
            action: 'Retried Resume Tailoring',
            entityType: 'QueueItem',
            entityId: item.id,
            entityName: `${item.company} — ${item.title}`,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Sent the tailored resume for ${item.consultant_name} back `
                + `for another attempt. ${reason}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ ok: true, status: 'PREPARING' });
    } catch (err) {
        return next(err);
    }
};
