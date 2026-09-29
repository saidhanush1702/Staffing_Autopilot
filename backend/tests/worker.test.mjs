/**
 * Phase 7 — the background worker. Integration suite.
 *
 *   node tests/worker.test.mjs
 *
 * This one DOES touch the database, because everything worth testing about a
 * job queue is a property of the database: the claim is only safe because of
 * SKIP LOCKED, the lease is only recoverable because of an expiry column, and
 * the backoff is only durable because it is stored rather than slept.
 *
 * None of it touches the network or a model. Handlers are registered by the
 * test itself, which is why registerHandler() exists.
 *
 * Every job created here carries kind 'test.*' and is deleted at the end, so a
 * run leaves the database as it found it.
 */
import { query, pool } from '../db.js';
import {
    enqueue, enqueueOnce, claimBatch, runOnce, reclaimExpiredLeases,
    registerHandler, __clearHandlers, WORKER_ID,
} from '../jobs/worker.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const jobRow = async (id) => {
    const { rows } = await query(
        `SELECT status, attempts, max_attempts, last_error, result,
                locked_by, locked_until, next_attempt_at
           FROM background_jobs WHERE id = $1`,
        [id],
    );
    return rows[0];
};

/** Make a queued job claimable now, skipping whatever backoff was set. */
const makeDue = (id) => query(
    "UPDATE background_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
    [id],
);

const cleanup = () => query("DELETE FROM background_jobs WHERE kind LIKE 'test.%'");

const main = async () => {
    const { rows: orgs } = await query(
        'SELECT id, name FROM organizations WHERE is_active ORDER BY created_at LIMIT 1',
    );
    if (orgs.length === 0) {
        console.log('\nNo active organisation in the database — run the seeds first.');
        process.exit(1);
    }
    const orgId = orgs[0].id;
    console.log(`\nRunning against organisation "${orgs[0].name}"`);

    await cleanup();
    __clearHandlers();

    /* ── enqueue and claim ────────────────────────────────────────────── */

    section('enqueue and claim');

    const id1 = await enqueue({ orgId, kind: 'test.noop', payload: { hello: 'world' } });
    const before = await jobRow(id1);
    check('a new job starts PENDING with no attempts',
        [before.status, before.attempts], ['PENDING', 0]);

    const claimed = await claimBatch(10);
    const mine = claimed.find((j) => j.id === id1);
    check('the job is claimed', Boolean(mine), true);
    check('the payload survives the round trip', mine.payload, { hello: 'world' });

    const afterClaim = await jobRow(id1);
    check('claiming marks it RUNNING and counts the attempt',
        [afterClaim.status, afterClaim.attempts], ['RUNNING', 1]);
    check('and stamps this worker on it', afterClaim.locked_by, WORKER_ID);
    check('with a lease that expires', afterClaim.locked_until !== null, true);

    // A second claim must not see a row the first one holds. This is the
    // property that stops a paid job running twice.
    const second = await claimBatch(10);
    check('a claimed job is invisible to the next claim',
        second.some((j) => j.id === id1), false);

    await cleanup();

    /* ── two workers racing ───────────────────────────────────────────── */

    section('two workers racing the same rows');

    const raceIds = [];
    for (let i = 0; i < 12; i += 1) {
        raceIds.push(await enqueue({ orgId, kind: 'test.race', payload: { i } }));
    }

    // Fired together on purpose: sequential calls would pass even without
    // SKIP LOCKED, so they would prove nothing.
    const [a, b] = await Promise.all([claimBatch(12), claimBatch(12)]);
    const idsA = a.map((j) => j.id);
    const idsB = b.map((j) => j.id);
    const overlap = idsA.filter((id) => idsB.includes(id));

    check('no job is handed to both workers', overlap, []);
    check('between them they take every job',
        new Set([...idsA, ...idsB]).size, 12);

    await cleanup();

    /* ── failure, backoff, and success ────────────────────────────────── */

    section('a job that fails twice and then succeeds');

    let attemptsSeen = 0;
    registerHandler('test.flaky', async () => {
        attemptsSeen += 1;
        if (attemptsSeen < 3) throw new Error(`Simulated provider 503 (${attemptsSeen})`);
        return { recoveredOnAttempt: attemptsSeen };
    });

    const flakyId = await enqueue({ orgId, kind: 'test.flaky', maxAttempts: 3 });

    await runOnce();
    let row = await jobRow(flakyId);
    check('after the first failure it is PENDING again',
        [row.status, row.attempts], ['PENDING', 1]);
    check('the error is kept', /Simulated provider 503 \(1\)/.test(row.last_error), true);
    // Backoff is a stored time, not a sleep — which is why it survives a
    // restart, and why the test has to move the clock forward itself.
    check('and it is not immediately due again',
        new Date(row.next_attempt_at) > new Date(), true);

    await makeDue(flakyId);
    await runOnce();
    row = await jobRow(flakyId);
    check('after the second failure it is still retrying',
        [row.status, row.attempts], ['PENDING', 2]);

    await makeDue(flakyId);
    await runOnce();
    row = await jobRow(flakyId);
    check('the third attempt succeeds', [row.status, row.attempts], ['DONE', 3]);
    check('the handler result is stored', row.result, { recoveredOnAttempt: 3 });
    check('the lease is released', row.locked_by, null);
    check('and the stale error is cleared', row.last_error, null);

    /* ── running out of attempts ──────────────────────────────────────── */

    section('a job that never succeeds');

    registerHandler('test.doomed', async () => {
        throw new Error('This will never work.');
    });

    const doomedId = await enqueue({ orgId, kind: 'test.doomed', maxAttempts: 2 });

    await runOnce();
    check('first failure retries', (await jobRow(doomedId)).status, 'PENDING');

    await makeDue(doomedId);
    await runOnce();
    row = await jobRow(doomedId);
    check('out of attempts, it dead-letters',
        [row.status, row.attempts], ['DEAD', 2]);
    check('with the reason kept', row.last_error, 'This will never work.');

    await makeDue(doomedId);
    const afterDead = await runOnce();
    check('nothing ever picks up a DEAD job again',
        afterDead.claimed, 0);

    /* ── a failure not worth retrying ─────────────────────────────────── */

    section('a permanent failure skips the retries');

    registerHandler('test.permanent', async () => {
        // The shape a handler uses to say "this will never work" — an
        // unparseable resume, not a provider having a bad minute.
        const err = new Error('Legacy .doc files cannot be read reliably.');
        err.retryable = false;
        throw err;
    });

    const permId = await enqueue({ orgId, kind: 'test.permanent', maxAttempts: 5 });
    await runOnce();
    row = await jobRow(permId);
    check('it dies on the first attempt despite having five',
        [row.status, row.attempts, row.max_attempts], ['DEAD', 1, 5]);

    /* ── a kind nobody handles ────────────────────────────────────────── */

    section('a job kind with no handler');

    const orphanId = await enqueue({ orgId, kind: 'test.no-such-handler', maxAttempts: 3 });
    const tally = await runOnce();
    row = await jobRow(orphanId);
    check('it dead-letters immediately rather than retrying into a void',
        row.status, 'DEAD');
    check('and is counted as unhandled, not as an ordinary failure',
        tally.unhandled, 1);
    check('with a reason that names the missing handler',
        /No handler is registered for job kind "test.no-such-handler"/.test(row.last_error),
        true);

    /* ── lease recovery ───────────────────────────────────────────────── */

    section('a worker that died holding a job');

    const crashedId = await enqueue({ orgId, kind: 'test.crashed' });
    await claimBatch(10);

    // Exactly the state a killed process leaves behind: RUNNING, leased, and
    // nobody coming back for it.
    await query(
        "UPDATE background_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1",
        [crashedId],
    );

    const reclaimed = await reclaimExpiredLeases();
    row = await jobRow(crashedId);
    check('the expired lease is reclaimed', reclaimed >= 1, true);
    check('and the job is available again', row.status, 'PENDING');
    check('the lease is cleared', [row.locked_by, row.locked_until], [null, null]);
    // Not decremented on purpose: a worker that died holding a job may have
    // died BECAUSE of it, and free retries let one poisonous row loop forever.
    check('but the attempt still counts against it', row.attempts, 1);

    section('a live lease is left alone');

    const liveId = await enqueue({ orgId, kind: 'test.live' });
    await claimBatch(10);
    await reclaimExpiredLeases();
    check('a job whose lease has not expired stays RUNNING',
        (await jobRow(liveId)).status, 'RUNNING');

    /* ── de-duplication ───────────────────────────────────────────────── */

    section('enqueueOnce — not paying twice for the same work');

    const dupA = await enqueueOnce({
        orgId, kind: 'test.dedupe', payload: { queueItemId: 'abc' }, dedupeOn: 'queueItemId',
    });
    const dupB = await enqueueOnce({
        orgId, kind: 'test.dedupe', payload: { queueItemId: 'abc' }, dedupeOn: 'queueItemId',
    });
    check('the same key returns the existing job', dupA === dupB, true);

    const dupC = await enqueueOnce({
        orgId, kind: 'test.dedupe', payload: { queueItemId: 'xyz' }, dedupeOn: 'queueItemId',
    });
    check('a different key makes a new one', dupC !== dupA, true);

    const { rows: dupCount } = await query(
        "SELECT COUNT(*)::int AS n FROM background_jobs WHERE kind = 'test.dedupe'",
    );
    check('two jobs exist, not three', dupCount[0].n, 2);

    /* ── transactional enqueue ────────────────────────────────────────── */

    section('enqueue inside a transaction');

    const client = await pool.connect();
    let rolledBackId;
    try {
        await client.query('BEGIN');
        rolledBackId = await enqueue({ orgId, kind: 'test.rollback' }, client);
        await client.query('ROLLBACK');
    } finally {
        client.release();
    }
    // The reason enqueue() accepts a client at all: a contact lookup queued
    // outside the transaction that writes the application record would survive
    // a rollback and point at an application that does not exist.
    check('a rolled-back transaction leaves no job behind',
        await jobRow(rolledBackId), undefined);

    /* ── done ─────────────────────────────────────────────────────────── */

    await cleanup();
    __clearHandlers();

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));

    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch(async (err) => {
    console.error('\nSuite aborted:', err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});
