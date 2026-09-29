/**
 * ── ASKING FOR A RESUME TO BE TAILORED ────────────────────────────────
 *
 * Tailoring is not automatic. A found job goes to READY with the consultant's
 * base resume (see promoteToReady), and a person decides which jobs are worth a
 * tailored one. This is that decision.
 *
 *   POST /api/portal/jobs/tailor                   a consultant, their own jobs
 *   POST /api/management/jobs/tailor               a recruiter or admin, for a
 *                                                  consultant they can access
 *
 * ── WHAT HAPPENS TO AN ITEM ───────────────────────────────────────────
 *
 *   READY ──► PREPARING ──► READY          (tailored, checked, rendered)
 *                    └────► RESUME_REVIEW  (the check found a claim to look at)
 *
 * While it is PREPARING the desktop app cannot see it — the app only takes READY
 * and FILLING — so a job is never applied to half-way through being tailored.
 * When it returns to READY it carries the tailored resume.
 *
 * ── WHAT IS REFUSED, AND WHY ──────────────────────────────────────────
 *
 * Only READY items move. Once the desktop app has taken a job (FILLING) the
 * application is already under way with a resume it was given, and swapping the
 * file underneath it would send something the consultant never saw. Already
 * tailored jobs are refused too: paying twice for the same resume is exactly
 * the waste this feature exists to stop.
 *
 * If tailoring is switched off or the month's budget is spent, the request is
 * refused up front with the reason. Moving items to PREPARING only to have each
 * one fail straight back to READY untailored would look like it worked.
 */
import Joi from 'joi';
import { query, withTransaction } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';
import { checkTransition } from '../config/queueStates.js';
import { enqueueOnce } from '../jobs/worker.js';
import { KIND as TAILOR_KIND } from '../jobs/handlers/tailorResume.js';
import { stageStatus, spendThisPeriod } from '../connectors/llm/index.js';
import { logAction } from './auditLogController.js';
import { randomUUID } from 'node:crypto';

export const MAX_PER_REQUEST = 50;

export const tailorRequestSchema = Joi.object({
    queueItemIds: Joi.array().items(Joi.string().max(36)).min(1).max(MAX_PER_REQUEST).unique().required(),
});

export const requestTailoring = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;
        const isConsultant = req.user.role === 'CONSULTANT';
        const ids = req.body.queueItemIds;

        // Can this organisation tailor at all right now?
        const status = await stageStatus(orgId, 'tailor');
        if (!status.available) {
            return res.status(409).json({
                error: `Resume tailoring is not available: ${status.reason ?? 'no model is set up for it'}`,
            });
        }
        const budget = await spendThisPeriod(orgId);
        if (budget.exhausted) {
            return res.status(409).json({
                error: `This month's AI budget of $${budget.budget.toFixed(2)} is used up, so no more resumes can be tailored until it resets.`,
            });
        }

        const { rows: items } = await query(
            `SELECT q.id, q.consultant_id, q.tailoring_state,
                    st.name AS status, p.company, p.title
               FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
               JOIN job_postings p        ON p.id = q.posting_id
              WHERE q.id = ANY($1::char(36)[]) AND q.organization_id = $2`,
            [ids, orgId],
        );
        const byId = new Map(items.map((i) => [i.id, i]));

        const { rows: statuses } = await query('SELECT id, name FROM lkp_queue_statuses');
        const statusId = Object.fromEntries(statuses.map((r) => [r.name, r.id]));

        const requested = [];
        const skipped = [];
        const accessCache = new Map();
        const mayAct = async (consultantId) => {
            if (isConsultant) return consultantId === req.user.id;
            if (!accessCache.has(consultantId)) {
                accessCache.set(consultantId, await canAccessConsultant(req.user, consultantId));
            }
            return accessCache.get(consultantId);
        };

        for (const id of ids) {
            const item = byId.get(id);
            // Not found and not-yours read identically: which one it was is not
            // something a caller should be able to probe for.
            if (!item || !(await mayAct(item.consultant_id))) {
                skipped.push({ id, reason: 'That job was not found.' });
                continue;
            }
            const label = `${item.title} at ${item.company}`;

            if (item.tailoring_state === 'TAILORED') {
                skipped.push({ id, label, reason: 'Already tailored.' });
                continue;
            }
            const verdict = checkTransition(item.status, 'PREPARING');
            if (item.status !== 'READY' || !verdict.ok) {
                skipped.push({
                    id, label,
                    reason: item.status === 'PREPARING'
                        ? 'Already being tailored.'
                        : `It is ${item.status.toLowerCase().replace(/_/g, ' ')}, so it can no longer be tailored.`,
                });
                continue;
            }

            const moved = await withTransaction(async (client) => {
                // Conditional on still being READY: the desktop app may have
                // taken it between the SELECT above and this write, and that
                // move wins.
                const { rowCount } = await client.query(
                    `UPDATE queue_items
                        SET status_id = $2, tailoring_state = 'PENDING',
                            tailoring_skip_reason = NULL, preparation_error = NULL
                      WHERE id = $1 AND status_id = $3`,
                    [id, statusId.PREPARING, statusId.READY],
                );
                if (rowCount === 0) return false;

                await client.query(
                    `INSERT INTO queue_item_transitions
                        (id, organization_id, queue_item_id, from_status_id, to_status_id,
                         reason, performed_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                    [randomUUID(), orgId, id, statusId.READY, statusId.PREPARING,
                        `Resume tailoring requested by ${isConsultant ? 'the consultant' : 'a recruiter or admin'}`,
                        req.user.id],
                );

                // In the SAME transaction as the move: an item at PREPARING with
                // no job behind it is invisible work until a sweep returns it.
                await enqueueOnce({
                    orgId,
                    kind: TAILOR_KIND,
                    payload: { queueItemId: id },
                    dedupeOn: 'queueItemId',
                }, client);
                return true;
            });

            if (moved) requested.push({ id, label });
            else skipped.push({ id, label, reason: 'It was picked up by the desktop app first.' });
        }

        if (requested.length > 0) {
            logAction({
                orgId,
                module: 'queue',
                action: 'Requested Resume Tailoring',
                entityType: 'QueueItem',
                entityId: requested[0].id,
                entityName: requested.length === 1 ? requested[0].label : `${requested.length} jobs`,
                performedBy: req.user.id,
                performedByRole: req.user.role,
                description: `Asked for resumes to be tailored for ${requested.length} job(s): `
                    + requested.map((r) => r.label).join('; ').slice(0, 400),
                ipAddress: req.ip,
            }).catch(() => {});
        }

        return res.json({ requested: requested.length, skipped });
    } catch (err) {
        return next(err);
    }
};
