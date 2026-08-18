/**
 * ── HOUSEKEEPING ──────────────────────────────────────────────────────
 *
 * Four things that must happen on a timer, or the queue quietly rots. Each one
 * fixes a state the system can otherwise get stuck in permanently:
 *
 *   EXPIRED LEASES    a crashed desktop app holds an item forever
 *   STALE PREPARATION an item that never prepared sits on a cap slot
 *   ABANDONED REVIEWS a filled application nobody looked at holds a slot
 *   DEAD POSTINGS     nothing ever set is_active back to false
 *
 * All four run on the scheduler's ordinary tick and are per organisation,
 * because every interval is a per-agency setting.
 *
 * ── WHY THESE ARE SWEEPS AND NOT TRIGGERS ─────────────────────────────
 *
 * Each is a transition between states, so each writes a transition row like any
 * other move. A database trigger could not — it has no idea which status ids
 * mean what, and the resulting history would have gaps exactly where somebody
 * later asks "why did this stop?".
 */
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { schedulerTimezone } from '../config/discoverySchedule.js';
import { promoteToReady } from '../controllers/discoveryController.js';

/** Status name → id, loaded once per sweep. */
const loadStatusIds = async () => {
    const { rows } = await query('SELECT id, name FROM lkp_queue_statuses');
    return Object.fromEntries(rows.map((r) => [r.name, r.id]));
};

const recordTransitions = async (orgId, items, fromId, toId, reason) => {
    for (const item of items) {
        await query(
            `INSERT INTO queue_item_transitions
                (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuidv4(), orgId, item.id, fromId, toId, reason],
        );
    }
};

/**
 * A lease the desktop app never gave back.
 *
 * The item returns to READY rather than being skipped: nothing is wrong with
 * the job, only with the machine that was holding it. An expiry rather than a
 * plain in-progress flag is the whole point — a flag has no way back from a
 * crash, and that item would never be applied to again.
 */
export const expireLeases = async (orgId, statusIds, leaseMinutes) => {
    const { rows } = await query(
        `UPDATE queue_items
            SET status_id = $2, leased_by = NULL, leased_until = NULL
          WHERE organization_id = $1
            AND status_id = $3
            AND leased_until IS NOT NULL
            AND leased_until < now()
          RETURNING id`,
        [orgId, statusIds.READY, statusIds.FILLING],
    );

    await recordTransitions(orgId, rows, statusIds.FILLING, statusIds.READY,
        `Lease expired after ${leaseMinutes} minutes — the device stopped responding`);
    return rows.length;
};

/**
 * An item that has been READY-adjacent but never actually prepared.
 *
 * Sent back to QUEUED so its cap slot is released and it is reconsidered on the
 * next promotion pass. Without this a preparation outage would hold a
 * consultant's slots indefinitely while producing nothing.
 */
export const expireUnprepared = async (orgId, statusIds, hours) => {
    const { rows } = await query(
        `UPDATE queue_items
            SET status_id = $2, became_ready_at = NULL, prepared_at = NULL,
                preparation_attempts = preparation_attempts + 1
          WHERE organization_id = $1
            AND status_id = $3
            AND queued_at < now() - ($4 || ' hours')::interval
          RETURNING id`,
        [orgId, statusIds.QUEUED, statusIds.PREPARING, String(hours)],
    );

    await recordTransitions(orgId, rows, statusIds.PREPARING, statusIds.QUEUED,
        `Preparation did not finish within ${hours} hours — returned to the queue`);
    return rows.length;
};

/**
 * A filled application nobody reviewed.
 *
 * Returns to READY, which releases the cap slot. Deliberately NOT skipped: the
 * consultant did not decline it, they simply have not looked yet, and recording
 * a decision they never made would be a lie in the history.
 */
export const expireReviews = async (orgId, statusIds, days) => {
    const { rows } = await query(
        `UPDATE queue_items
            SET status_id = $2, became_ready_at = NULL
          WHERE organization_id = $1
            AND status_id = $3
            AND updated_at < now() - ($4 || ' days')::interval
          RETURNING id`,
        [orgId, statusIds.READY, statusIds.AWAITING_REVIEW, String(days)],
    );

    await recordTransitions(orgId, rows, statusIds.AWAITING_REVIEW, statusIds.READY,
        `Not reviewed within ${days} days — the daily cap slot was released`);
    return rows.length;
};

/**
 * Postings no run has seen for a while.
 *
 * `is_active` existed from the start and nothing ever set it false, so queues
 * accumulated jobs that had long since been filled. Absence from recent runs is
 * the only signal available — the provider does not tell us a posting closed,
 * it simply stops returning it.
 *
 * Queue items are left alone. A job the consultant already has in front of them
 * is still worth applying to; this only stops dead postings being matched again.
 */
export const agePostings = async (orgId, staleDays) => {
    const { rowCount } = await query(
        `UPDATE job_postings
            SET is_active = FALSE
          WHERE organization_id = $1
            AND is_active
            AND last_seen_at < now() - ($2 || ' days')::interval`,
        [orgId, String(staleDays)],
    );
    return rowCount;
};

/** All four, for one organisation. Never throws — housekeeping must not break a tick. */
export const sweepOrganisation = async (org, statusIds) => {
    const result = {
        leases: 0, unprepared: 0, reviews: 0, postings: 0, errors: [],
    };
    const steps = [
        ['leases', () => expireLeases(org.id, statusIds, org.lease_expiry_minutes)],
        ['unprepared', () => expireUnprepared(org.id, statusIds, org.unprepared_expiry_hours)],
        ['reviews', () => expireReviews(org.id, statusIds, org.review_expiry_days)],
        ['postings', () => agePostings(org.id, org.posting_stale_days)],
    ];

    for (const [name, run] of steps) {
        try {
            result[name] = await run();
        } catch (err) {
            // One failing sweep must not stop the other three, and must not
            // stop the discovery tick it rides along with.
            result.errors.push(`${name}: ${err.message}`);
        }
    }
    return result;
};

/** Every active organisation, in sequence. */
export const sweepAll = async () => {
    const statusIds = await loadStatusIds();
    const { rows: orgs } = await query(
        `SELECT id, name, lease_expiry_minutes, unprepared_expiry_hours,
                review_expiry_days, posting_stale_days
           FROM organizations
          WHERE is_active`,
    );

    const totals = {
        leases: 0, unprepared: 0, reviews: 0, postings: 0, promoted: 0,
    };

    for (const org of orgs) {
        const r = await sweepOrganisation(org, statusIds);
        for (const k of ['leases', 'unprepared', 'reviews', 'postings']) totals[k] += r[k];
        for (const e of r.errors) console.error(`[maintenance] ${org.name} ${e}`);

        // Promotion runs here as well as at the end of a discovery cycle.
        // Without this, an organisation whose provider is switched off or out
        // of budget never promotes anything, so queued work sits untouched even
        // with cap slots free — the sweeps above would have just released some.
        try {
            const { promoted } = await promoteToReady(org.id);
            totals.promoted += promoted;
        } catch (err) {
            console.error(`[maintenance] ${org.name} promote: ${err.message}`);
        }
    }

    if (Object.values(totals).some((n) => n > 0)) {
        console.log(`[maintenance] leases ${totals.leases}, unprepared ${totals.unprepared}, `
            + `reviews ${totals.reviews}, postings aged ${totals.postings}, `
            + `promoted ${totals.promoted}`);
    }
    return totals;
};

/**
 * ── WHY THIS HAS ITS OWN TIMER ────────────────────────────────────────
 *
 * Housekeeping used to ride along with the discovery cycle, which meant it only
 * ran when `DISCOVERY_ENABLED=true`. That is a deployment decision about
 * whether this process fetches jobs — and it defaults to false. So on a
 * deployment that had not switched discovery on, leases never expired,
 * abandoned reviews never released their cap slot, and postings never aged out.
 *
 * None of that is discovery. It is repairing state the system already holds,
 * and it has to happen whether or not this process ever calls a provider.
 */
export const MAINTENANCE_CRON = '*/10 * * * *';

let task = null;

export const startQueueMaintenance = () => {
    if (task) return task;
    task = cron.schedule(
        MAINTENANCE_CRON,
        () => { sweepAll().catch((err) => console.error('[maintenance] failed:', err.message)); },
        { timezone: schedulerTimezone() },
    );
    console.log('   Queue maintenance ON — every 10 min (independent of DISCOVERY_ENABLED)');
    return task;
};

export const stopQueueMaintenance = () => {
    if (task) { task.stop(); task = null; }
};
