/**
 * ── EVERY JOB FOR ONE CONSULTANT, AND WHAT HAPPENED TO IT ─────────────
 *
 * One row per job, carrying the whole story: where it came from, what stage it
 * is at, whether the resume was tailored and how it scored, whether it was
 * submitted and by what, and who we found to follow up with.
 *
 * ── WHY THIS EXISTS WHEN A QUEUE AND AN APPLICATION LIST ALREADY DID ──
 *
 * Those two lists split a job in half at the moment it is submitted. Before
 * submission it is a queue item; after, it is an application record; and the
 * screens showing them shared no columns, so the obvious questions —
 * "what happened to that Northwind job?", "how many of her jobs actually went
 * out tailored?" — required opening two screens and matching rows up by company
 * name. The split is real in the DATABASE, for good reasons: an application
 * record is append-only and outlives the queue item it came from. It is not
 * real to the person asking.
 *
 * So the join happens here, once, instead of in a person's head every time.
 *
 * ── WHY SOME JOBS HAVE NO QUEUE ITEM ──────────────────────────────────
 *
 * A consultant can apply to something they found themselves, and a record of it
 * can be entered without the job ever having been matched or queued. Those are
 * unioned in as a second source rather than dropped — a jobs screen that
 * silently omits jobs is worse than no jobs screen.
 *
 * ── ONE HANDLER, THREE ROLES ──────────────────────────────────────────
 *
 * An owner, a recruiter and the consultant themselves all see the same screen,
 * because it is the same question. What differs is WHOSE jobs they may ask
 * about, and that is settled here at the top: a consultant is pinned to their
 * own id and cannot pass one, a recruiter is filtered by `canAccessConsultant`,
 * an owner reaches anyone in their organisation. Writing the screen twice would
 * have meant writing the scope rule twice.
 */
import { query } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';

/**
 * The stage a job is at, as one word, across both halves of its life.
 *
 * Derived here rather than in the client because three surfaces show it and
 * three copies of a derivation is three chances to disagree about what
 * "in progress" means.
 *
 * ── AN APPLICATION RECORD OUTRANKS THE QUEUE STATUS ───────────────────
 *
 * Checked first, and this is not a formality. Real data has applications whose
 * queue item was later CANCELLED, and one whose item still sits at
 * AWAITING_REVIEW. Reading the queue status alone would file those under
 * "cancelled" and "in progress" — but the application was SENT, to a real
 * employer, in the consultant's name, and no later change to a queue row
 * un-sends it. `application_records` is append-only precisely because it is the
 * thing that actually happened.
 *
 * The queue status is still carried on the row beside this, so a job that was
 * submitted and then cancelled reads as exactly that rather than being
 * flattened into one word.
 */
const STAGE_OF = (row) => {
    if (row.application_id) return 'SUBMITTED';
    switch (row.status_name) {
        case 'QUEUED': return 'MATCHED';
        case 'PREPARING': return 'PREPARING';
        case 'RESUME_REVIEW': return 'REVIEW';
        case 'READY':
        case 'FILLING':
        case 'PARKED_UNKNOWN':
        case 'AWAITING_REVIEW': return 'IN_PROGRESS';
        case 'SUBMITTED': return 'SUBMITTED';
        case 'CANCELLED':
        case 'SKIPPED': return 'CLOSED';
        default: return 'MATCHED';
    }
};

/**
 * Shared column list for the queue-backed half.
 *
 * The correlated sub-selects are counts, one per job, over indexed columns.
 * Written as sub-selects rather than joins on purpose: joining flags and
 * contact links would multiply rows and force a GROUP BY over thirty columns,
 * which is both slower to read and easy to get subtly wrong.
 */
const QUEUE_JOBS_SQL = `
    SELECT q.id                         AS queue_item_id,
           q.posting_id,
           q.is_overlap, q.channel,
           q.queued_at, q.prepared_at, q.became_ready_at, q.updated_at,
           q.skip_reason, q.park_reason, q.cancel_reason,
           q.preparation_error, q.preparation_attempts,
           q.tailoring_state, q.tailoring_skip_reason,
           q.tailored_resume_artifact_id,

           st.name AS status_name, st.label AS status_label,
           st.sort_order, st.is_terminal,

           p.company, p.title, p.location_text, p.is_remote, p.source_url,
           p.pay_min, p.pay_max, p.pay_unit, p.posted_at,
           src.label AS source_label,
           portal.label AS portal_label,

           m.score, m.reason AS match_reason,

           ta.id            AS tailored_artifact_id,
           ta.model         AS tailored_model,
           ta.provider      AS tailored_provider,
           ta.ats_score_before, ta.ats_score_after,
           ta.generated_at  AS tailored_at,

           a.id             AS application_id,
           a.submitted_at,
           a.notes          AS application_notes,
           ast.label        AS application_status_label,
           sm.label         AS submitted_via_label,
           sm.is_witnessed,
           dev.machine_label,
           rec.name         AS recorded_by_name,

           (SELECT COUNT(*)::int FROM resume_fabrication_flags f
             WHERE f.queue_item_id = q.id)                       AS flag_count,
           (SELECT COUNT(*)::int FROM contact_links cl
             WHERE cl.posting_id = q.posting_id)                 AS contact_count,
           (SELECT COUNT(*)::int FROM application_qa qa
             WHERE qa.application_id = a.id)                     AS answer_count
      FROM queue_items q
      JOIN lkp_queue_statuses st ON st.id = q.status_id
      JOIN job_postings p        ON p.id  = q.posting_id
 LEFT JOIN lkp_job_sources src   ON src.id = p.first_source_id
 LEFT JOIN lkp_portal_types portal ON portal.id = p.portal_type_id
 LEFT JOIN job_matches m         ON m.id  = q.match_id
 LEFT JOIN resume_artifacts ta   ON ta.id = COALESCE(
                                       q.tailored_resume_artifact_id,
                                       (SELECT r.id FROM resume_artifacts r
                                         WHERE r.queue_item_id = q.id AND r.kind = 'tailored'
                                         ORDER BY r.generated_at DESC NULLS LAST
                                         LIMIT 1))
 LEFT JOIN application_records a ON a.queue_item_id = q.id
 LEFT JOIN lkp_application_statuses ast ON ast.id = a.status_id
 LEFT JOIN lkp_submission_methods sm    ON sm.id  = a.submission_method_id
 LEFT JOIN devices dev ON dev.id = a.device_id
 LEFT JOIN users rec   ON rec.id = a.recorded_by
     WHERE q.consultant_id = $1 AND q.organization_id = $2`;

/**
 * Applications with no queue item behind them.
 *
 * `resume_artifacts` is joined through the record's OWN `resume_artifact_id`
 * here — there is no queue item to hang a tailored artifact off, so the only
 * honest source is the file the record says was sent.
 */
const LOOSE_APPLICATIONS_SQL = `
    SELECT NULL::char(36)        AS queue_item_id,
           a.posting_id,
           FALSE AS is_overlap, NULL AS channel,
           NULL::timestamptz AS queued_at, NULL::timestamptz AS prepared_at,
           NULL::timestamptz AS became_ready_at, a.created_at AS updated_at,
           NULL AS skip_reason, NULL AS park_reason, NULL AS cancel_reason,
           NULL AS preparation_error, 0 AS preparation_attempts,
           NULL AS tailoring_state, NULL AS tailoring_skip_reason,
           NULL::char(36) AS tailored_resume_artifact_id,

           NULL AS status_name, NULL AS status_label,
           99 AS sort_order, TRUE AS is_terminal,

           a.company, a.job_title AS title, p.location_text, p.is_remote,
           a.job_url AS source_url,
           p.pay_min, p.pay_max, p.pay_unit, p.posted_at,
           src.label AS source_label,
           a.portal_label,

           NULL::int AS score, NULL AS match_reason,

           ar.id AS tailored_artifact_id, ar.model AS tailored_model,
           ar.provider AS tailored_provider,
           ar.ats_score_before, ar.ats_score_after, ar.generated_at AS tailored_at,

           a.id AS application_id, a.submitted_at, a.notes AS application_notes,
           ast.label AS application_status_label,
           sm.label AS submitted_via_label, sm.is_witnessed,
           dev.machine_label, rec.name AS recorded_by_name,

           0 AS flag_count,
           (SELECT COUNT(*)::int FROM contact_links cl
             WHERE cl.posting_id = a.posting_id)  AS contact_count,
           (SELECT COUNT(*)::int FROM application_qa qa
             WHERE qa.application_id = a.id)      AS answer_count
      FROM application_records a
 LEFT JOIN job_postings p ON p.id = a.posting_id
 LEFT JOIN lkp_job_sources src ON src.id = p.first_source_id
 LEFT JOIN resume_artifacts ar ON ar.id = a.resume_artifact_id
                              AND ar.kind = 'tailored'
      JOIN lkp_application_statuses ast ON ast.id = a.status_id
      JOIN lkp_submission_methods sm    ON sm.id  = a.submission_method_id
 LEFT JOIN devices dev ON dev.id = a.device_id
 LEFT JOIN users rec   ON rec.id = a.recorded_by
     WHERE a.consultant_id = $1 AND a.organization_id = $2
       AND a.queue_item_id IS NULL`;

/**
 * GET /api/management/consultants/:id/jobs
 * GET /api/portal/jobs
 */
export const listConsultantJobs = async (req, res, next) => {
    try {
        const mine = req.user.role === 'CONSULTANT';

        // A consultant's id comes from their session, never from the URL. The
        // portal route has no :id segment at all, so there is nothing to tamper
        // with — but pinning it here means that stays true if a route is ever
        // added carelessly.
        const consultantId = mine ? req.user.id : req.params.id;

        if (!mine) {
            const { rows } = await query(
                `SELECT id, name, email FROM users
                  WHERE id = $1 AND organization_id = $2 AND role = 'CONSULTANT'`,
                [consultantId, req.user.orgId],
            );
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Consultant not found in your organization.' });
            }
            if (!(await canAccessConsultant(req.user, consultantId))) {
                return res.status(403).json({ error: 'That consultant is not assigned to you.' });
            }
        }

        // The union is wrapped in a subquery because Postgres will not accept an
        // expression in ORDER BY over a set operation — only a bare output
        // column name. Sorting by "whenever this job last did anything" needs a
        // COALESCE across three timestamps, so the set is closed first and
        // ordered afterwards.
        const { rows } = await query(
            `SELECT * FROM (
                ${QUEUE_JOBS_SQL}
                UNION ALL
                ${LOOSE_APPLICATIONS_SQL}
             ) jobs
             ORDER BY COALESCE(submitted_at, updated_at, queued_at) DESC NULLS LAST
             LIMIT 500`,
            [consultantId, req.user.orgId],
        );

        const jobs = rows.map((row) => ({ ...row, stage: STAGE_OF(row) }));

        // ── WHAT EACH RESUME COST — ORG_ADMIN ONLY ────────────────────────
        //
        // The sum of every model call made for the job: the tailoring itself, the
        // fabrication check, and any retry or fallback attempt. Attached ONLY when
        // the caller is an org admin. It is not merely hidden in the interface —
        // for anybody else the field does not exist in the response, because a
        // number a recruiter or consultant should not see is not made safe by a
        // component that chooses not to draw it.
        //
        // `tailoring_cost_unknown` is true when any call was made on a model whose
        // price the table does not know. Showing a partial sum as the whole would
        // be a quiet lie, so the screen says "unknown" instead.
        if (req.user.role === 'ORG_ADMIN') {
            const itemIds = jobs.map((j) => j.queue_item_id).filter(Boolean);
            if (itemIds.length > 0) {
                const { rows: costs } = await query(
                    `SELECT queue_item_id,
                            COALESCE(SUM(cost_usd), 0)::float8      AS cost,
                            BOOL_OR(cost_usd IS NULL)               AS unknown
                       FROM resume_tailoring_runs
                      WHERE organization_id = $1 AND queue_item_id = ANY($2::char(36)[])
                      GROUP BY queue_item_id`,
                    [req.user.orgId, itemIds],
                );
                const byItem = new Map(costs.map((c) => [c.queue_item_id, c]));
                for (const job of jobs) {
                    const c = byItem.get(job.queue_item_id);
                    job.tailoring_cost_usd = c ? c.cost : null;
                    job.tailoring_cost_unknown = c ? c.unknown : false;
                }
            }
        }

        // Counted from the rows just returned rather than by a second set of
        // COUNT queries: two round trips can disagree with each other, and a
        // total that does not match the list underneath it is the kind of bug
        // nobody reports and everybody stops trusting the screen over.
        const summary = {
            total: jobs.length,
            byStage: {},
            tailored: 0,
            notTailored: 0,
            submitted: 0,
            withContacts: 0,
            avgAtsGain: null,
        };

        let gainSum = 0;
        let gainCount = 0;

        for (const job of jobs) {
            summary.byStage[job.stage] = (summary.byStage[job.stage] ?? 0) + 1;
            if (job.tailoring_state === 'TAILORED') summary.tailored += 1;
            if (job.tailoring_state === 'NOT_TAILORED') summary.notTailored += 1;
            if (job.application_id) summary.submitted += 1;
            if (job.contact_count > 0) summary.withContacts += 1;
            if (job.ats_score_before != null && job.ats_score_after != null) {
                gainSum += job.ats_score_after - job.ats_score_before;
                gainCount += 1;
            }
        }
        if (gainCount > 0) summary.avgAtsGain = Math.round(gainSum / gainCount);

        return res.json({ jobs, summary });
    } catch (err) {
        return next(err);
    }
};
