/**
 * ── THE BACKGROUND WORKER ─────────────────────────────────────────────
 *
 * Claims rows from background_jobs, runs the handler named by `kind`, and
 * records what happened. Everything that costs money and cannot happen inside
 * an HTTP request goes through here.
 *
 * ── WHY A LOOP AND NOT A CRON EXPRESSION ──────────────────────────────
 *
 * The rest of this codebase schedules with node-cron, and for housekeeping that
 * is right — a sweep that runs every ten minutes is a sweep. This is different:
 * a consultant's queue item sits at PREPARING until a worker picks it up, and
 * cron's finest grain is one minute. Waiting up to sixty seconds to START work
 * that then takes thirty is most of the latency for no reason.
 *
 * ── WHY THE CLAIM LOOKS THE WAY IT DOES ───────────────────────────────
 *
 * `FOR UPDATE SKIP LOCKED` is the whole reason this is safe to run twice. The
 * obvious implementation — SELECT the pending rows, then UPDATE them to
 * RUNNING — is a race with a bill attached: two workers read the same row,
 * both write RUNNING, and the job runs twice on two paid model calls. SKIP
 * LOCKED makes the second worker step over a row the first is holding, inside
 * the database, where the decision is actually atomic.
 *
 * ── WHY THE LEASE HAS AN EXPIRY ───────────────────────────────────────
 *
 * A worker killed mid-job leaves its row RUNNING. A plain in-progress flag has
 * no way back from that and the job is lost permanently. `locked_until` turns
 * it into a question with an answer: the row is held until a time, and after
 * that time anyone may take it. This is the same lesson queue_items.leased_until
 * already encodes for the desktop app.
 *
 * ── WHY BACKOFF IS A COLUMN AND NOT A SLEEP ───────────────────────────
 *
 * `next_attempt_at` survives a restart; a sleeping promise does not. A worker
 * that sleeps also holds its place in the loop doing nothing, so one slow retry
 * delays every other job behind it.
 */
import cron from 'node-cron';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { query } from '../db.js';
import { schedulerTimezone } from '../config/discoverySchedule.js';

/** Identifies THIS process in `locked_by`. Host plus pid plus a random tail. */
export const WORKER_ID = `${os.hostname().slice(0, 24)}:${process.pid}:${randomUUID().slice(0, 8)}`;

const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/* ── the handler registry ──────────────────────────────────────────── */

/**
 * kind → async (job) => result
 *
 * A handler signals failure by THROWING. Set `err.retryable = false` on the
 * error to skip the remaining attempts and dead-letter immediately — the right
 * answer for "this resume will never parse", the wrong answer for "the provider
 * returned 503".
 *
 * Registered rather than imported so a test can install its own handler without
 * a module mock, and so adding a handler is adding a file.
 */
const HANDLERS = new Map();

export const registerHandler = (kind, fn) => {
    if (typeof fn !== 'function') throw new Error(`Handler for "${kind}" is not a function.`);
    HANDLERS.set(kind, fn);
};

export const registeredKinds = () => [...HANDLERS.keys()];

export const __clearHandlers = () => HANDLERS.clear();

/* ── putting work in ───────────────────────────────────────────────── */

/**
 * Queue a job.
 *
 * Takes an optional transaction client so a job can be enqueued in the SAME
 * transaction as the row it is about. That matters: enqueueing a contact
 * lookup outside the transaction that writes the application record means a
 * rollback leaves a job pointing at an application that does not exist.
 *
 * @returns the new job's id
 */
export const enqueue = async (
    { orgId, kind, payload = {}, maxAttempts = 3, runAt = null },
    client = null,
) => {
    const id = randomUUID();
    const exec = client ? client.query.bind(client) : query;

    await exec(
        `INSERT INTO background_jobs
            (id, organization_id, kind, payload, max_attempts, next_attempt_at)
         VALUES ($1,$2,$3,$4::jsonb,$5, COALESCE($6::timestamptz, now()))`,
        [id, orgId, kind, JSON.stringify(payload), maxAttempts, runAt],
    );
    return id;
};

/**
 * Queue a job at most once for a given key.
 *
 * Used where the same work could be requested twice — a discovery run that
 * overlaps a maintenance sweep, say — and running it twice would be paid for
 * twice. Cheaper than a unique index because "already done" should not block a
 * legitimate re-run weeks later.
 */
export const enqueueOnce = async (
    { orgId, kind, payload = {}, dedupeOn, maxAttempts = 3 },
    client = null,
) => {
    const exec = client ? client.query.bind(client) : query;

    const { rows } = await exec(
        `SELECT id FROM background_jobs
          WHERE organization_id = $1
            AND kind = $2
            AND status IN ('PENDING','RUNNING')
            AND payload->>$3 = $4
          LIMIT 1`,
        [orgId, kind, dedupeOn, String(payload[dedupeOn] ?? '')],
    );
    if (rows.length > 0) return rows[0].id;

    return enqueue({ orgId, kind, payload, maxAttempts }, client);
};

/* ── taking work out ───────────────────────────────────────────────── */

/**
 * Claim up to `limit` jobs for this worker.
 *
 * The whole claim is one statement so there is no window between choosing a row
 * and marking it taken.
 */
export const claimBatch = async (limit = 5, leaseMinutes = 10) => {
    const { rows } = await query(
        `UPDATE background_jobs j
            SET status = 'RUNNING',
                locked_by = $1,
                locked_until = now() + ($2 || ' minutes')::interval,
                attempts = j.attempts + 1,
                started_at = COALESCE(j.started_at, now())
          WHERE j.id IN (
                SELECT c.id
                  FROM background_jobs c
                 WHERE c.status = 'PENDING'
                   AND c.next_attempt_at <= now()
                 ORDER BY c.next_attempt_at, c.created_at
                 FOR UPDATE SKIP LOCKED
                 LIMIT $3
          )
        RETURNING j.id, j.organization_id, j.kind, j.payload,
                  j.attempts, j.max_attempts`,
        [WORKER_ID, String(leaseMinutes), limit],
    );
    return rows;
};

const markDone = (job, result) => query(
    `UPDATE background_jobs
        SET status = 'DONE', finished_at = now(),
            locked_by = NULL, locked_until = NULL,
            last_error = NULL, result = $2::jsonb
      WHERE id = $1`,
    [job.id, JSON.stringify(result ?? {})],
);

/**
 * Record a failure, and decide whether there is another attempt.
 *
 * Backoff is 30s, 2m, 8m, 32m... capped at an hour. Long enough that a provider
 * having a bad minute has recovered; short enough that a consultant's queue is
 * not idle for a day.
 */
const markFailed = async (job, err) => {
    const permanent = err?.retryable === false;
    const exhausted = job.attempts >= job.max_attempts;
    const message = String(err?.message ?? err ?? 'Unknown error').slice(0, 2000);

    if (permanent || exhausted) {
        await query(
            `UPDATE background_jobs
                SET status = 'DEAD', finished_at = now(),
                    locked_by = NULL, locked_until = NULL, last_error = $2
              WHERE id = $1`,
            [job.id, message],
        );
        return 'DEAD';
    }

    const delaySeconds = Math.min(30 * 4 ** (job.attempts - 1), 3600);
    await query(
        `UPDATE background_jobs
            SET status = 'PENDING',
                locked_by = NULL, locked_until = NULL,
                last_error = $2,
                next_attempt_at = now() + ($3 || ' seconds')::interval
          WHERE id = $1`,
        [job.id, message, String(delaySeconds)],
    );
    return 'PENDING';
};

/**
 * Return jobs whose lease has lapsed to the pool.
 *
 * `attempts` is NOT decremented. A worker that died holding a job may well have
 * died BECAUSE of that job, and giving it unlimited free retries is how one
 * poisonous row takes the queue down repeatedly.
 */
export const reclaimExpiredLeases = async () => {
    const { rowCount } = await query(
        `UPDATE background_jobs
            SET status = 'PENDING', locked_by = NULL, locked_until = NULL,
                last_error = COALESCE(last_error,
                    'The worker holding this job stopped responding; the lease expired.')
          WHERE status = 'RUNNING'
            AND locked_until IS NOT NULL
            AND locked_until < now()`,
    );
    return rowCount;
};

/**
 * One pass: claim a batch and run it.
 *
 * Jobs in a batch run CONCURRENTLY. They are independent by construction — each
 * one owns its row — and they are dominated by waiting on a provider, so running
 * them in sequence would make a batch of five take five times as long for no
 * safety gained.
 *
 * Never throws. A worker that dies on a bad job stops processing every other
 * job too, which is a far worse failure than the one it was reacting to.
 */
export const runOnce = async ({ limit, leaseMinutes } = {}) => {
    const batch = num(limit, num(process.env.WORKER_BATCH_SIZE, 5));
    const lease = num(leaseMinutes, num(process.env.WORKER_LEASE_MINUTES, 10));

    const tally = {
        claimed: 0, done: 0, retrying: 0, dead: 0, unhandled: 0,
    };

    let jobs;
    try {
        jobs = await claimBatch(batch, lease);
    } catch (err) {
        console.error('[worker] could not claim jobs:', err.message);
        return tally;
    }

    tally.claimed = jobs.length;
    if (jobs.length === 0) return tally;

    await Promise.all(jobs.map(async (job) => {
        const handler = HANDLERS.get(job.kind);

        if (!handler) {
            // A kind with no handler is a deployment mistake, not a transient
            // fault, so it dead-letters immediately rather than retrying three
            // times against a handler that is still not there.
            tally.unhandled += 1;
            const err = new Error(`No handler is registered for job kind "${job.kind}".`);
            err.retryable = false;
            await markFailed(job, err).catch(() => {});
            return;
        }

        try {
            const result = await handler(job);
            await markDone(job, result);
            tally.done += 1;
        } catch (err) {
            const outcome = await markFailed(job, err).catch(() => 'DEAD');
            if (outcome === 'DEAD') tally.dead += 1; else tally.retrying += 1;
            console.error(`[worker] ${job.kind} ${job.id} failed `
                + `(attempt ${job.attempts}/${job.max_attempts}): ${err.message}`);
        }
    }));

    return tally;
};

/* ── the loop ──────────────────────────────────────────────────────── */

let timer = null;
let running = false;
let leaseSweep = null;

/**
 * Start polling.
 *
 * Self-scheduling with setTimeout rather than setInterval: an interval fires on
 * a clock regardless of whether the previous pass finished, so a slow batch
 * overlaps the next one and the concurrency limit stops meaning anything.
 */
export const startWorker = () => {
    if (timer) return timer;

    if (process.env.WORKER_ENABLED !== 'true') {
        console.log('   Background worker OFF (set WORKER_ENABLED=true)');
        return null;
    }

    const interval = num(process.env.WORKER_INTERVAL_MS, 15_000);

    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const tally = await runOnce();
            if (tally.done || tally.dead || tally.retrying || tally.unhandled) {
                console.log(`[worker] done ${tally.done}, retrying ${tally.retrying}, `
                    + `dead ${tally.dead}, unhandled ${tally.unhandled}`);
            }
        } catch (err) {
            console.error('[worker] tick failed:', err.message);
        } finally {
            running = false;
            if (timer) timer = setTimeout(tick, interval);
        }
    };

    timer = setTimeout(tick, interval);

    // Lease recovery rides its own slower timer. It is repair, not throughput,
    // and running it on every 15-second tick is a pointless write.
    leaseSweep = cron.schedule('*/5 * * * *', () => {
        reclaimExpiredLeases()
            .then((n) => { if (n > 0) console.log(`[worker] reclaimed ${n} expired lease(s)`); })
            .catch((err) => console.error('[worker] lease sweep failed:', err.message));
    }, { timezone: schedulerTimezone() });

    console.log(`   Background worker ON — every ${interval}ms as ${WORKER_ID}`);
    return timer;
};

export const stopWorker = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (leaseSweep) { leaseSweep.stop(); leaseSweep = null; }
};

export const __test = { markFailed, markDone };
