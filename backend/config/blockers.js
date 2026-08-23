/**
 * ── WHAT IS STANDING BETWEEN AN APPLICATION AND BEING SENT ────────────
 *
 * One place that decides whether a parked application can go, so the answer is
 * the same however it is asked — by the desktop app reporting a park, by a
 * consultant answering a question, or by a recruiter looking at a queue.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────
 *
 * An application waits on every question it could not answer. It is released
 * when NONE of them is still unanswered — not when the first one is answered,
 * which is what it used to do, and which cost one round trip per question on
 * the same job.
 */
import { query } from '../db.js';

/**
 * Record everything a form asked that we could not answer.
 *
 * @param client a transaction client, since this is written alongside the
 *   item's move to PARKED_UNKNOWN and neither should exist without the other
 */
export const recordBlockers = async (client, { orgId, itemId, asked }) => {
    for (const b of asked) {
        await client.query(
            `INSERT INTO queue_item_blockers
                (id, organization_id, queue_item_id, question_id,
                 asked_as, field_type, is_required)
             VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6)
             ON CONFLICT (queue_item_id, question_id) DO NOTHING`,
            [orgId, itemId, b.questionId, String(b.askedAs ?? '').slice(0, 2000),
                b.fieldType ?? null, b.required !== false],
        );
    }
};

/**
 * Queue items that are now fully answered and can go back to READY.
 *
 * Expressed as "has no blocker without an answer" rather than "count answers ===
 * count blockers", because the second is wrong the moment a question is asked
 * twice or an answer is superseded.
 */
export const releasableItems = async (orgId, consultantId = null) => {
    const { rows } = await query(
        `SELECT DISTINCT q.id
           FROM queue_items q
           JOIN lkp_queue_statuses st ON st.id = q.status_id
          WHERE q.organization_id = $1
            AND st.name = 'PARKED_UNKNOWN'
            AND ($2::text IS NULL OR q.consultant_id = $2)
            AND EXISTS (SELECT 1 FROM queue_item_blockers b WHERE b.queue_item_id = q.id)
            AND NOT EXISTS (
                SELECT 1
                  FROM queue_item_blockers b
                 WHERE b.queue_item_id = q.id
                   AND NOT EXISTS (
                       SELECT 1
                         FROM answers a
                         JOIN lkp_answer_statuses s ON s.id = a.status_id
                        WHERE a.question_id = b.question_id
                          AND a.consultant_id = q.consultant_id
                          AND a.is_current
                          AND s.name = 'APPROVED'
                          AND a.approved_text IS NOT NULL
                   )
            )`,
        [orgId, consultantId],
    );
    return rows.map((r) => r.id);
};

/**
 * Send every fully-answered application back to READY.
 *
 * Blockers are deleted rather than kept: they described what was missing, and
 * nothing is missing any more. The questions themselves stay in the bank, where
 * the next employer to ask them will find them already answered.
 *
 * @returns the number of applications released
 */
export const releaseAnswered = async (orgId, consultantId = null) => {
    const ids = await releasableItems(orgId, consultantId);
    if (ids.length === 0) return 0;

    await query(
        `UPDATE queue_items
            SET status_id = (SELECT id FROM lkp_queue_statuses WHERE name = 'READY'),
                park_reason = NULL,
                parked_question_id = NULL,
                became_ready_at = now(),
                updated_at = now()
          WHERE id = ANY($1::text[])`,
        [ids],
    );
    await query('DELETE FROM queue_item_blockers WHERE queue_item_id = ANY($1::text[])', [ids]);
    return ids.length;
};

/** What a consultant still has to answer, and which jobs are waiting on it. */
export const outstandingForConsultant = async (orgId, consultantId) => {
    const { rows } = await query(
        `SELECT b.question_id,
                MIN(b.asked_as)   AS asked_as,
                MIN(b.field_type) AS field_type,
                bool_or(b.is_required) AS is_required,
                COUNT(DISTINCT b.queue_item_id)::int AS waiting_jobs,
                MIN(p.company)    AS example_company,
                c.name            AS category,
                c.label           AS category_label
           FROM queue_item_blockers b
           JOIN queue_items q ON q.id = b.queue_item_id
           JOIN job_postings p ON p.id = q.posting_id
           JOIN questions qu ON qu.id = b.question_id
      LEFT JOIN lkp_question_categories c ON c.id = qu.category_id
          WHERE b.organization_id = $1
            AND q.consultant_id = $2
            AND NOT EXISTS (
                SELECT 1
                  FROM answers a
                  JOIN lkp_answer_statuses s ON s.id = a.status_id
                 WHERE a.question_id = b.question_id
                   AND a.consultant_id = $2
                   AND a.is_current
                   AND s.name = 'APPROVED'
                   AND a.approved_text IS NOT NULL
            )
       GROUP BY b.question_id, c.name, c.label
       ORDER BY COUNT(DISTINCT b.queue_item_id) DESC, MIN(b.asked_as)`,
        [orgId, consultantId],
    );
    return rows;
};
