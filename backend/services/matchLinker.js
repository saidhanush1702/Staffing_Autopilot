/**
 * ── GIVING A POSTING TO A CONSULTANT ──────────────────────────────────
 *
 * The write half of matching: a `job_matches` row, a `queue_items` row, the
 * transition that explains it, and the lane the item starts in.
 *
 * The same steps the JobsPipe listener performs inline for a freshly delivered
 * job. This copy exists for the doors that link jobs that were ALREADY in the
 * pool — re-matching a consultant whose criteria just changed, and accepting a
 * recruiter's suggestion — where the listener's whole ingest (fingerprinting,
 * sightings) has nothing left to do.
 *
 * Idempotent by the same constraints the listener relies on: a consultant is
 * matched to a posting once, ever, so linking twice is a no-op, not a
 * duplicate.
 *
 * ── THREE OUTCOMES, THREE FUNCTIONS ───────────────────────────────────
 *
 *   linkPosting        AUTO      a match AND a queue item, now
 *   recordSuggestion   SUGGEST   a match with NO queue item, for a recruiter
 *   acceptSuggestion   (later)   turns a suggestion into a queue item
 *
 * `run` is the query function, injectable so the rules can be tested without a
 * database; it defaults to the real one.
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { laneFor } from '../config/queueLanes.js';

let statusIds = null;
const queuedStatusId = async (run) => {
    if (!statusIds) {
        const { rows } = await run('SELECT id, name FROM lkp_queue_statuses');
        statusIds = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    }
    return statusIds.QUEUED;
};

/** The queue item for a match that already exists. Shared by AUTO and an accepted suggestion. */
const enqueue = async (run, {
    orgId, consultantId, postingId, matchId, automatable, score, via,
}) => {
    const channel = await laneFor(orgId, automatable);
    const { rows: others } = await run(
        'SELECT 1 FROM queue_items WHERE posting_id = $1 AND consultant_id <> $2 LIMIT 1',
        [postingId, consultantId],
    );
    const isOverlap = others.length > 0;
    const statusId = await queuedStatusId(run);

    const inserted = await run(
        `INSERT INTO queue_items
            (id, organization_id, consultant_id, posting_id, match_id,
             status_id, is_overlap, run_id, channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)
         ON CONFLICT (consultant_id, posting_id) DO NOTHING
         RETURNING id`,
        [uuidv4(), orgId, consultantId, postingId, matchId, statusId, isOverlap, channel],
    );
    if (inserted.rowCount === 0) return { linked: false };

    const itemId = inserted.rows[0].id;
    await run(
        `INSERT INTO queue_item_transitions
            (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [uuidv4(), orgId, itemId, statusId,
            `${via} — score ${score}, ${channel} lane`.slice(0, 500)],
    );
    if (isOverlap) {
        await run('UPDATE queue_items SET is_overlap = TRUE WHERE posting_id = $1', [postingId]);
    }
    await run("UPDATE job_matches SET status = 'QUEUED' WHERE id = $1", [matchId]);
    return { linked: true, itemId, matchId };
};

/**
 * @returns {{ linked: boolean, itemId?: string, matchId?: string }}
 *   linked is false when this consultant already had the posting.
 */
export const linkPosting = async ({
    orgId, consultantId, versionId, postingId, automatable = false, verdict, via,
}, run = query) => {
    const matchId = uuidv4();
    const made = await run(
        `INSERT INTO job_matches
            (id, organization_id, consultant_id, posting_id,
             criteria_version_id, score, reason, status, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',NULL)
         ON CONFLICT (consultant_id, posting_id) DO NOTHING`,
        [matchId, orgId, consultantId, postingId, versionId,
            verdict.score, `${verdict.reason} [via ${via}]`.slice(0, 500)],
    );
    if (made.rowCount === 0) return { linked: false };

    return enqueue(run, {
        orgId, consultantId, postingId, matchId, automatable, score: verdict.score, via,
    });
};

/**
 * A plausible fit that is not certain: store the match for a recruiter and put
 * NOTHING in the consultant's queue.
 *
 * Keeping the row whatever happens next is what stops the same job being
 * suggested to the same consultant again after a recruiter has dismissed it —
 * the unique constraint on (consultant, posting) does the remembering.
 *
 * @returns {{ suggested: boolean, matchId?: string }}
 */
export const recordSuggestion = async ({
    orgId, consultantId, versionId, postingId, verdict, via,
}, run = query) => {
    const matchId = uuidv4();
    const made = await run(
        `INSERT INTO job_matches
            (id, organization_id, consultant_id, posting_id,
             criteria_version_id, score, reason, status, run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'SUGGESTED',NULL)
         ON CONFLICT (consultant_id, posting_id) DO NOTHING`,
        [matchId, orgId, consultantId, postingId, versionId,
            verdict.score, `${verdict.reason} [via ${via}]`.slice(0, 500)],
    );
    return made.rowCount > 0 ? { suggested: true, matchId } : { suggested: false };
};

/**
 * A recruiter says yes to a suggestion. It becomes a queue item through the
 * same door as an automatic match, and the match records who decided.
 *
 * @returns {{ linked: boolean, itemId?: string, reason?: string }}
 */
export const acceptSuggestion = async ({ orgId, matchId, actorName }, run = query) => {
    const { rows } = await run(
        `SELECT m.id, m.consultant_id, m.posting_id, m.score, m.status,
                COALESCE(pt.is_automatable, FALSE) AS automatable
           FROM job_matches m
           JOIN job_postings p ON p.id = m.posting_id
      LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
          WHERE m.id = $1 AND m.organization_id = $2`,
        [matchId, orgId],
    );
    const m = rows[0];
    if (!m) return { linked: false, reason: 'Suggestion not found.' };
    if (m.status !== 'SUGGESTED') return { linked: false, reason: `That match is already ${m.status.toLowerCase()}.` };

    await run(
        `UPDATE job_matches SET reason = LEFT(reason || $2, 500) WHERE id = $1`,
        [matchId, ` [linked by ${actorName ?? 'a recruiter'}]`],
    );
    return enqueue(run, {
        orgId,
        consultantId: m.consultant_id,
        postingId: m.posting_id,
        matchId,
        automatable: m.automatable,
        score: m.score,
        via: `Suggested match linked by ${actorName ?? 'a recruiter'}`,
    });
};

/** A recruiter says it is not a fit. The row stays, so it is not suggested again. */
export const dismissSuggestion = async ({ orgId, matchId, actorName, note }, run = query) => {
    const res = await run(
        `UPDATE job_matches
            SET status = 'NOT_A_FIT', reason = LEFT(reason || $3, 500)
          WHERE id = $1 AND organization_id = $2 AND status = 'SUGGESTED'`,
        [matchId, orgId, ` [not a fit — ${actorName ?? 'a recruiter'}${note ? `: ${note}` : ''}]`],
    );
    return { dismissed: res.rowCount > 0 };
};
