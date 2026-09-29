/**
 * ── LINKING A JOB TO A CONSULTANT BY HAND ─────────────────────────────
 *
 * The matcher is deterministic and it is strict, and both of those are on
 * purpose — but they mean it will refuse jobs a recruiter can see are right.
 *
 * On the live pool as this was written, 62% of postings matched nobody. Not
 * because the matcher was broken: a "React Developer" role in Irving, Texas
 * scored 60 against a consultant asking for React Developer in Hyderabad, and
 * the pass mark is 70. The title was perfect. The geography was not, and the
 * geography is most of the score.
 *
 * That is the correct answer for the automatic pass and the wrong answer for
 * a recruiter who knows the consultant would relocate, or that the role is
 * quietly remote, or that this client is worth the exception. This is the
 * override: a person names the consultant, and the job enters their queue
 * through the same door discovery uses.
 *
 * ── WHY IT GOES THROUGH THE SAME DOOR ─────────────────────────────────
 *
 * A manual link writes a `job_matches` row and a `queue_items` row exactly as
 * discovery does, and is released to READY the same way discovery releases a
 * job — carrying the base resume, tailoring not yet requested. Nothing
 * downstream can tell the difference, which is the point: a second path into
 * the queue would be a second set of bugs and a second thing to remember when
 * the rules change.
 *
 * A linked job is NOT tailored automatically. The person who linked it can ask
 * for tailoring from the consultant's job list, like any other job; linking a
 * job and paying to tailor it are two decisions.
 *
 * What IS recorded is that a person did it: the match's reason says so, the
 * transition row says so, and the audit log names them.
 */
import Joi from 'joi';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';
import { releaseItemToReady } from './discoveryController.js';
import { logAction } from './auditLogController.js';

export const linkSchema = Joi.object({
    consultantId: Joi.string().max(36).required(),
    reason: Joi.string().trim().max(500).allow('', null).default(null),
});

/**
 * GET /api/management/postings/:id/link-candidates?search=
 *
 * Who this job could be given to, and who already has it.
 *
 * Everyone is listed rather than only those who would have matched — the whole
 * reason this screen exists is that the matcher said no. What each row carries
 * instead is the CONTEXT for the decision: what that consultant is searching
 * for, where, and whether they already hold this job. A recruiter picking
 * blind from a list of names is no better off than the matcher was.
 */
export const linkCandidates = async (req, res, next) => {
    try {
        const { rows: posting } = await query(
            'SELECT id, company, title FROM job_postings WHERE id = $1 AND organization_id = $2',
            [req.params.id, req.user.orgId],
        );
        if (posting.length === 0) return res.status(404).json({ error: 'Posting not found.' });

        const search = (req.query.search ?? '').trim() || null;

        const { rows } = await query(
            `SELECT u.id, u.name, u.email,
                    p.city, p.state, p.is_paused,
                    -- Already in their queue? Then the button says so instead
                    -- of offering to do it again.
                    EXISTS (SELECT 1 FROM queue_items q
                             WHERE q.posting_id = $2 AND q.consultant_id = u.id) AS already_queued,
                    (SELECT st.name FROM queue_items q
                       JOIN lkp_queue_statuses st ON st.id = q.status_id
                      WHERE q.posting_id = $2 AND q.consultant_id = u.id LIMIT 1) AS queue_status,
                    -- What they are actually looking for, so the choice is
                    -- informed rather than a guess at a name.
                    (SELECT string_agg(t.value, ' · ' ORDER BY t.position)
                       FROM search_criteria_terms t
                      WHERE t.version_id = c.current_version_id
                        AND t.kind = 'JOB_TITLE') AS wanted_titles,
                    (SELECT string_agg(DISTINCT l.city, ' · ')
                       FROM search_criteria_locations l
                      WHERE l.version_id = c.current_version_id) AS wanted_locations,
                    c.is_active AS criteria_active
               FROM users u
          LEFT JOIN consultant_profiles p ON p.user_id = u.id
          LEFT JOIN search_criteria c ON c.consultant_id = u.id
              WHERE u.organization_id = $1
                AND u.role = 'CONSULTANT'
                -- A terminated or suspended consultant cannot be given work.
                -- Paused is different: it is shown, flagged, and allowed,
                -- because a recruiter overriding a pause for one job is a
                -- decision they are entitled to make.
                AND u.employment_status = 'ACTIVE'
                AND ($3::text IS NULL OR u.name ILIKE '%' || $3 || '%'
                                      OR u.email ILIKE '%' || $3 || '%')
              ORDER BY u.name
              LIMIT 200`,
            [req.user.orgId, req.params.id, search],
        );

        // A recruiter sees only their own consultants. Applied here rather than
        // in the query because assignment scope lives behind canAccessConsultant
        // and is not a column on this join.
        const visible = req.user.role === 'RECRUITER'
            ? (await Promise.all(rows.map(async (r) => (
                (await canAccessConsultant(req.user, r.id)) ? r : null
            )))).filter(Boolean)
            : rows;

        return res.json({
            posting: posting[0],
            consultants: visible,
            total: visible.length,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/postings/:id/link
 *
 * Put this job in that consultant's queue.
 */
export const linkPosting = async (req, res, next) => {
    try {
        const { consultantId, reason } = req.body;

        const { rows: posting } = await query(
            `SELECT p.id, p.company, p.title, p.portal_type_id,
                    COALESCE(pt.is_automatable, FALSE) AS automatable
               FROM job_postings p
          LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
              WHERE p.id = $1 AND p.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );
        if (posting.length === 0) return res.status(404).json({ error: 'Posting not found.' });

        if (!(await canAccessConsultant(req.user, consultantId))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }

        const { rows: who } = await query(
            `SELECT u.name, u.employment_status
               FROM users u WHERE u.id = $1 AND u.organization_id = $2 AND u.role = 'CONSULTANT'`,
            [consultantId, req.user.orgId],
        );
        if (who.length === 0) return res.status(404).json({ error: 'Consultant not found.' });
        if (who[0].employment_status !== 'ACTIVE') {
            return res.status(409).json({
                error: `${who[0].name} is ${who[0].employment_status.toLowerCase()} and cannot be given work.`,
            });
        }

        const { rows: existing } = await query(
            `SELECT q.id, st.name AS status FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
              WHERE q.posting_id = $1 AND q.consultant_id = $2`,
            [req.params.id, consultantId],
        );
        if (existing.length > 0) {
            return res.status(409).json({
                error: `${who[0].name} already has this job — it is ${existing[0].status}.`,
                queueItemId: existing[0].id,
            });
        }

        const job = posting[0];
        const note = String(reason ?? '').trim();
        const matchReason = `Linked by ${req.user.role === 'ORG_ADMIN' ? 'the owner' : 'a recruiter'}`
            + (note ? ` — ${note}` : '');

        const { rows: statuses } = await query('SELECT id, name FROM lkp_queue_statuses');
        const statusId = Object.fromEntries(statuses.map((r) => [r.name, r.id]));

        // R-01 / R-03: one posting legitimately reaches several consultants,
        // each applying under their own name. Flagged for visibility, never
        // blocked.
        const { rows: others } = await query(
            'SELECT 1 FROM queue_items WHERE posting_id = $1 AND consultant_id <> $2 LIMIT 1',
            [req.params.id, consultantId],
        );
        const isOverlap = others.length > 0;

        const matchId = randomUUID();
        const itemId = randomUUID();

        await withTransaction(async (client) => {
            await client.query(
                `INSERT INTO job_matches
                    (id, organization_id, consultant_id, posting_id, score, reason, status)
                 VALUES ($1,$2,$3,$4,$5,$6,'QUEUED')
                 ON CONFLICT (consultant_id, posting_id) DO NOTHING`,
                [matchId, req.user.orgId, consultantId, req.params.id,
                    // 100, and honestly so: a person looked at this job and
                    // this consultant and said yes. That is a stronger signal
                    // than anything the scorer produces, and recording it as a
                    // low score would make the queue sort it to the bottom.
                    100, matchReason.slice(0, 500)],
            );

            await client.query(
                `INSERT INTO queue_items
                    (id, organization_id, consultant_id, posting_id, match_id,
                     status_id, is_overlap, channel, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [itemId, req.user.orgId, consultantId, req.params.id, matchId,
                    // Created QUEUED and released to READY just below, in the
                    // same transaction, so the history reads exactly like a
                    // discovered job's: queued, then ready.
                    statusId.QUEUED, isOverlap,
                    job.automatable ? 'BOT' : 'HUMAN', req.user.id],
            );

            await client.query(
                `INSERT INTO queue_item_transitions
                    (id, organization_id, queue_item_id, from_status_id, to_status_id,
                     reason, performed_by)
                 VALUES ($1,$2,$3,NULL,$4,$5,$6)`,
                [randomUUID(), req.user.orgId, itemId, statusId.QUEUED,
                    `Linked to this consultant by hand${note ? ` — ${note}` : ''}`,
                    req.user.id],
            );

            if (isOverlap) {
                await client.query(
                    'UPDATE queue_items SET is_overlap = TRUE WHERE posting_id = $1',
                    [req.params.id],
                );
            }

            await releaseItemToReady(client, { orgId: req.user.orgId, itemId, statusId });
        });

        logAction({
            orgId: req.user.orgId,
            module: 'queue',
            action: 'Linked Job To Consultant',
            entityType: 'QueueItem',
            entityId: itemId,
            entityName: `${job.company} — ${job.title}`,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Linked "${job.title}" at ${job.company} to ${who[0].name} by hand, `
                + `outside the matcher.${note ? ` Reason: ${note}` : ''}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            ok: true,
            queueItemId: itemId,
            consultant: who[0].name,
            channel: job.automatable ? 'BOT' : 'HUMAN',
            isOverlap,
        });
    } catch (err) {
        return next(err);
    }
};
