/**
 * Resume tailoring on request — found jobs go READY, and only jobs somebody
 * selects are tailored.
 *
 *   node tests/tailoringOnRequest.test.mjs
 *
 * Real database, mock model provider. What this exists to prove:
 *
 *   1. A found job is released straight to READY with the base resume, marked
 *      NOT_REQUESTED, and NO tailoring work is queued for it.
 *   2. Selecting a job moves READY -> PREPARING and queues exactly one job; the
 *      worker then returns it to READY. Nothing is tailored that was not asked for.
 *   3. It refuses what it should: a job the desktop app already took, one
 *      already tailored, one being tailored, someone else's job, and any request
 *      while tailoring is switched off.
 *   4. A job linked by hand follows the same road.
 *   5. What a resume cost reaches an org admin and NOBODY else — the field does
 *      not exist in a recruiter's or consultant's response.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';

import { randomUUID, createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { promoteToReady } from '../controllers/discoveryController.js';
import { requestTailoring } from '../controllers/tailoringRequestController.js';
import { listConsultantJobs } from '../controllers/consultantJobsController.js';
import { linkPosting } from '../controllers/postingLinkController.js';
import { handle as tailorHandler } from '../jobs/handlers/tailorResume.js';
import { checkTransition } from '../config/queueStates.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const mockRes = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};
const call = async (handler, req) => {
    const res = mockRes();
    let thrown = null;
    await handler(req, res, (e) => { thrown = e; });
    if (thrown) throw thrown;
    return res;
};

const made = { users: [], postings: [], items: [] };

const main = async () => {
    const { rows: [org] } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1');
    const orgId = org.id;
    const statusId = Object.fromEntries(
        (await query('SELECT id, name FROM lkp_queue_statuses')).rows.map((r) => [r.name, r.id]));

    const makeConsultant = async (label) => {
        const id = randomUUID();
        await query(
            `INSERT INTO users (id, organization_id, name, email, role,
                                password_enc, password_iv, password_tag, employment_status)
             VALUES ($1,$2,$3,$4,'CONSULTANT','x','x','x','ACTIVE')`,
            [id, orgId, label, `tor-${id}@example.invalid`],
        );
        await query('INSERT INTO consultant_profiles (user_id, organization_id) VALUES ($1,$2)', [id, orgId]);
        made.users.push(id);
        return id;
    };
    const makePosting = async (title) => {
        const id = randomUUID();
        await query(
            `INSERT INTO job_postings (id, organization_id, company, title, location_text,
                                       is_remote, description, source_url, fingerprint)
             VALUES ($1,$2,'Tailor Test Co',$3,'Austin, TX',FALSE,'Build data pipelines.',$4,$5)`,
            [id, orgId, title, `https://example.invalid/tor/${id}`,
                createHash('sha256').update(`tor-${id}`).digest('hex')],
        );
        made.postings.push(id);
        return id;
    };
    const makeItem = async (consultantId, postingId, status = 'QUEUED') => {
        const id = randomUUID();
        await query(
            `INSERT INTO queue_items (id, organization_id, consultant_id, posting_id, status_id, channel)
             VALUES ($1,$2,$3,$4,$5,'BOT')`,
            [id, orgId, consultantId, postingId, statusId[status]],
        );
        made.items.push(id);
        return id;
    };
    const state = async (id) => (await query(
        `SELECT st.name AS status, q.tailoring_state, q.tailoring_skip_reason
           FROM queue_items q JOIN lkp_queue_statuses st ON st.id = q.status_id WHERE q.id = $1`,
        [id])).rows[0];
    const jobsFor = async (itemId) => (await query(
        `SELECT count(*)::int AS n FROM background_jobs
          WHERE kind = 'tailorResume' AND payload->>'queueItemId' = $1`, [itemId])).rows[0].n;

    const consultantA = await makeConsultant('Tailor Test A');
    const consultantB = await makeConsultant('Tailor Test B');
    const asConsultant = (id, body) => ({
        user: { id, orgId, role: 'CONSULTANT' }, body, params: {}, query: {}, ip: '1.1.1.1',
    });
    const asAdmin = (body, params = {}) => ({
        user: { id: null, orgId, role: 'ORG_ADMIN' }, body, params, query: {}, ip: '1.1.1.1',
    });
    const asStranger = (body) => ({
        user: { id: randomUUID(), orgId, role: 'RECRUITER' }, body, params: {}, query: {}, ip: '1.1.1.1',
    });

    /* ── 1. found jobs go READY, untailored ─────────────────────────── */

    section('a found job goes straight to READY');

    const p1 = await makePosting('Data Engineer');
    const i1 = await makeItem(consultantA, p1);
    await promoteToReady(orgId);
    let s = await state(i1);
    check('it is READY, not PREPARING', s.status, 'READY');
    check('  marked as not tailored because nobody asked',
        [s.tailoring_state, s.tailoring_skip_reason], ['NOT_TAILORED', 'NOT_REQUESTED']);
    check('  and no tailoring work was queued', await jobsFor(i1), 0);
    const hist = (await query(
        `SELECT fs.name AS f, ts.name AS t FROM queue_item_transitions x
           LEFT JOIN lkp_queue_statuses fs ON fs.id = x.from_status_id
           JOIN lkp_queue_statuses ts ON ts.id = x.to_status_id
          WHERE x.queue_item_id = $1 ORDER BY x.created_at`, [i1])).rows;
    check('  the history says QUEUED then READY', hist.map((h) => `${h.f}>${h.t}`), ['QUEUED>READY']);

    check('the state machine allows READY to PREPARING', checkTransition('READY', 'PREPARING').ok, true);
    check('  but not FILLING to PREPARING', checkTransition('FILLING', 'PREPARING').ok, false);
    check('  and allows QUEUED to READY', checkTransition('QUEUED', 'READY').ok, true);

    /* ── 2. selecting a job tailors it, and only it ─────────────────── */

    section('selecting a job tailors that job only');

    const p2 = await makePosting('Analytics Engineer');
    const i2 = await makeItem(consultantA, p2);
    await promoteToReady(orgId);

    let r = await call(requestTailoring, asConsultant(consultantA, { queueItemIds: [i1] }));
    check('the request is accepted', [r.statusCode, r.body.requested, r.body.skipped], [200, 1, []]);
    s = await state(i1);
    check('the selected job stepped back to PREPARING', [s.status, s.tailoring_state], ['PREPARING', 'PENDING']);
    check('  with exactly one tailoring job queued', await jobsFor(i1), 1);
    check('the other job was left alone', (await state(i2)).status, 'READY');
    check('  with no tailoring work', await jobsFor(i2), 0);

    r = await call(requestTailoring, asConsultant(consultantA, { queueItemIds: [i1] }));
    check('asking again while it is being tailored is refused', [r.body.requested, r.body.skipped[0]?.reason],
        [0, 'Already being tailored.']);
    check('  and does not queue a second job', await jobsFor(i1), 1);

    const job = (await query(
        `SELECT * FROM background_jobs WHERE kind = 'tailorResume' AND payload->>'queueItemId' = $1`, [i1])).rows[0];
    await tailorHandler({ ...job, attempts: 1, max_attempts: 3 });
    s = await state(i1);
    check('the worker returns it to READY when done', s.status, 'READY');

    /* ── 3. what is refused ─────────────────────────────────────────── */

    section('what is refused');

    const p3 = await makePosting('ML Engineer');
    const i3 = await makeItem(consultantA, p3);
    await promoteToReady(orgId);
    await query('UPDATE queue_items SET status_id = $2 WHERE id = $1', [i3, statusId.FILLING]);
    r = await call(requestTailoring, asConsultant(consultantA, { queueItemIds: [i3] }));
    check('a job the desktop app already took is refused', [r.body.requested, /filling/.test(r.body.skipped[0]?.reason)],
        [0, true]);
    check('  and stays FILLING', (await state(i3)).status, 'FILLING');

    await query(`UPDATE queue_items SET status_id = $2, tailoring_state = 'TAILORED' WHERE id = $1`,
        [i3, statusId.READY]);
    r = await call(requestTailoring, asConsultant(consultantA, { queueItemIds: [i3] }));
    check('an already tailored job is refused', r.body.skipped[0]?.reason, 'Already tailored.');

    const p4 = await makePosting('BI Developer');
    const iB = await makeItem(consultantB, p4);
    await promoteToReady(orgId);
    r = await call(requestTailoring, asConsultant(consultantA, { queueItemIds: [iB] }));
    check('a consultant cannot tailor someone else\'s job', [r.body.requested, r.body.skipped[0]?.reason],
        [0, 'That job was not found.']);
    check('  it did not move', (await state(iB)).status, 'READY');

    r = await call(requestTailoring, asStranger({ queueItemIds: [iB] }));
    check('a recruiter not assigned to that consultant is refused too', r.body.requested, 0);

    r = await call(requestTailoring, asAdmin({ queueItemIds: [iB] }));
    check('an org admin may tailor for any consultant', [r.body.requested, (await state(iB)).status], [1, 'PREPARING']);

    const p5 = await makePosting('Platform Engineer');
    const i5 = await makeItem(consultantA, p5);
    await promoteToReady(orgId);
    const provider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = '';
    r = await call(requestTailoring, asConsultant(consultantA, { queueItemIds: [i5] }));
    check('with tailoring switched off the request is refused up front', r.statusCode, 409);
    check('  and nothing moved', [(await state(i5)).status, await jobsFor(i5)], ['READY', 0]);
    process.env.LLM_PROVIDER = provider;

    /* ── 4. a hand-linked job follows the same road ─────────────────── */

    section('a job linked by hand');

    const p6 = await makePosting('Backend Engineer');
    r = await call(linkPosting, asAdmin({ consultantId: consultantB, reason: null }, { id: p6 }));
    check('linking succeeds', r.statusCode, 201);
    s = await state(r.body.queueItemId);
    made.items.push(r.body.queueItemId);
    check('the linked job is READY and untailored', [s.status, s.tailoring_skip_reason], ['READY', 'NOT_REQUESTED']);
    check('  with no tailoring queued', await jobsFor(r.body.queueItemId), 0);

    /* ── 5. cost is for the org admin only ──────────────────────────── */

    section('what a resume cost reaches the org admin only');

    await query(
        `INSERT INTO resume_tailoring_runs
            (id, organization_id, queue_item_id, consultant_id, stage, attempt, provider, model,
             prompt_version, cost_usd, verdict)
         VALUES ($1,$2,$3,$4,'tailor',1,'mock','mock-model','v1',0.012,'CLEAN'),
                ($5,$2,$3,$4,'check',1,'mock','mock-model','v1',0.003,'CLEAN')`,
        [randomUUID(), orgId, i2, consultantA, randomUUID()],
    );

    const listFor = async (user, params = {}) => (await call(listConsultantJobs, {
        user, params, body: {}, query: {},
    })).body.jobs.find((j) => j.queue_item_id === i2);

    let row = await listFor({ id: null, orgId, role: 'ORG_ADMIN' }, { id: consultantA });
    check('the org admin sees the sum of every call', row.tailoring_cost_usd, 0.015);
    check('  and that it is fully priced', row.tailoring_cost_unknown, false);

    row = await listFor({ id: consultantA, orgId, role: 'CONSULTANT' });
    check('the consultant\'s response has no cost field at all', 'tailoring_cost_usd' in row, false);

    const rec = await call(listConsultantJobs, {
        user: { id: randomUUID(), orgId, role: 'RECRUITER' }, params: { id: consultantA }, body: {}, query: {},
    });
    check('a recruiter without access is refused before any cost is read', rec.statusCode, 403);

    await query(
        `INSERT INTO resume_tailoring_runs
            (id, organization_id, queue_item_id, consultant_id, stage, attempt, provider, model,
             prompt_version, cost_usd, verdict)
         VALUES ($1,$2,$3,$4,'tailor',2,'mock','unpriced-model','v1',NULL,'CLEAN')`,
        [randomUUID(), orgId, i2, consultantA],
    );
    row = await listFor({ id: null, orgId, role: 'ORG_ADMIN' }, { id: consultantA });
    check('a call on a model with no known price is reported as unknown, not free',
        row.tailoring_cost_unknown, true);

    /* ── done ───────────────────────────────────────────────────────── */

    await cleanup();
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
};

const cleanup = async () => {
    if (made.items.length) {
        await query(`DELETE FROM background_jobs WHERE kind = 'tailorResume' AND payload->>'queueItemId' = ANY($1::text[])`,
            [made.items]);
        await query('DELETE FROM resume_tailoring_runs WHERE queue_item_id = ANY($1::char(36)[])', [made.items]);
        await query('DELETE FROM queue_item_transitions WHERE queue_item_id = ANY($1::char(36)[])', [made.items]);
        await query('DELETE FROM queue_items WHERE id = ANY($1::char(36)[])', [made.items]);
    }
    if (made.postings.length) {
        await query('DELETE FROM job_matches WHERE posting_id = ANY($1::char(36)[])', [made.postings]);
        await query('DELETE FROM job_postings WHERE id = ANY($1::char(36)[])', [made.postings]);
    }
    if (made.users.length) await query('DELETE FROM users WHERE id = ANY($1::char(36)[])', [made.users]);
};

main().catch(async (err) => {
    console.error('\nSuite aborted:', err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});
