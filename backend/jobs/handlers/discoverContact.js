/**
 * ── FIND THE CONTACT, AFTER THE APPLICATION IS ALREADY IN ─────────────
 *
 * Enqueued from `reportSubmitted`, inside the same transaction as the
 * `application_records` insert, and run later on the worker.
 *
 * ── WHY IT RUNS HERE AND NOT IN THE REQUEST ───────────────────────────
 *
 * The desktop app is holding an HTTP connection open at the moment a submission
 * is reported, and behind that connection is a consultant watching a spinner. An
 * Apollo call takes seconds when it works and twenty when it does not. Putting
 * it in the request means a provider having a bad afternoon shows up as the
 * submission itself failing — and the app retries, which is how one application
 * becomes three records.
 *
 * Enqueueing inside the caller's transaction is the other half of that. A job
 * written outside it would survive a rollback and point at an application that
 * does not exist; a job written inside it disappears with the record it is about.
 *
 * ── WHY MOST FAILURES DO NOT RETRY ────────────────────────────────────
 *
 * "Apollo knows nobody at this company" is an answer, not a fault, and asking
 * again tomorrow will produce the same answer for another credit. So only a
 * genuine provider failure throws — the case where trying again later is
 * actually likely to work. Everything else returns a result the ledger already
 * holds and the job ends DONE.
 */
import { query } from '../../db.js';
import { discoverContacts } from '../../services/contactDiscovery.js';

export const KIND = 'discoverContact';

/**
 * The steps where trying again is worth a worker slot.
 *
 * A budget ceiling is not one of them: the budget resets on the first of the
 * month, which is far past the last retry, so retrying only spends attempts to
 * be told the same thing.
 */
const RETRYABLE_STEPS = new Set(['matchPerson', 'searchPeople']);

/**
 * @param job  payload: { postingId, applicationId?, queueItemId?, manual? }
 */
export const handle = async (job) => {
    const orgId = job.organization_id;
    const { postingId, applicationId = null, queueItemId = null } = job.payload ?? {};

    if (!postingId) {
        const err = new Error('The job payload has no postingId.');
        err.retryable = false;
        throw err;
    }

    // The application may have been deleted between submission and this job
    // running. Nothing to attach a contact to, and nothing worth retrying.
    if (applicationId) {
        const { rows } = await query(
            'SELECT 1 FROM application_records WHERE id = $1 AND organization_id = $2',
            [applicationId, orgId],
        );
        if (rows.length === 0) {
            return { skipped: true, reason: 'The application record is gone.' };
        }
    }

    const result = await discoverContacts({
        orgId, postingId, applicationId, queueItemId,
    });

    if (!result.ok && RETRYABLE_STEPS.has(result.step)) {
        // The lookup is already in contact_lookups with its error, so this
        // throw adds a retry rather than a second record of the same failure.
        throw new Error(`Apollo lookup failed at ${result.step}: ${result.note}`);
    }

    return {
        ok: result.ok,
        step: result.step,
        cacheHit: result.cacheHit,
        credits: result.credits,
        contacts: result.contacts.length,
        note: result.note,
    };
};
