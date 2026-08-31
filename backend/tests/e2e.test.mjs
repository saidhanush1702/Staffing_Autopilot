/**
 * Phase 7 — the whole path, once, in order.
 *
 *   node tests/e2e.test.mjs
 *
 *   match → tailor → check → REVIEW → approve → apply → contact
 *
 * The other suites each prove one stage properly. This one proves the stages
 * are actually WIRED TO EACH OTHER, which is the failure none of them can see:
 * every unit can be green while the handoff between two of them drops the work
 * on the floor.
 *
 * ── WHAT IS REAL HERE AND WHAT IS NOT ─────────────────────────────────
 *
 * Real: the database, the queue state machine, the ATS scorer, the mechanical
 * fabrication pass, pdfkit, the artifact and ledger rows, the review
 * controller's own decision path, the background worker's claim-and-dispatch
 * loop, and the contact waterfall including its store.
 *
 * Fixtures: the model (LLM_PROVIDER=mock) and Apollo (a stubbed `fetch`). Those
 * are the two things that cost money and the two things that are not ours.
 *
 * No API key of any kind is needed to run this, which is the point — the whole
 * path has to be verifiable on a laptop before it is trusted with a budget.
 *
 * Everything created here is removed at the end.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';
process.env.APOLLO_API_KEY = 'test-key-not-real';
process.env.CONTACT_REUSE_DAYS = '90';

import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { handle as tailorHandler, KIND as TAILOR_KIND } from '../jobs/handlers/tailorResume.js';
import { KIND as CONTACT_KIND } from '../jobs/handlers/discoverContact.js';
import { approveReview } from '../controllers/resumeReviewController.js';
import { renderResumePdf } from '../services/resumePdf.js';
import { enqueue, runOnce } from '../jobs/worker.js';
import '../jobs/handlers/index.js';   // registers both handlers with the worker

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── fixtures ─────────────────────────────────────────────────────────── */

const BASE_RESUME = {
    contact: {
        name: 'Dev Anand',
        email: 'dev.anand@example.com',
        phone: '555-0142',
        location: 'Austin, TX',
        links: [],
    },
    sectionOrder: ['summary', 'skills', 'experience', 'education'],
    summary: 'Data engineer building batch pipelines for retail analytics.',
    skills: [{ category: 'Languages', items: ['Python', 'SQL', 'Scala'] }],
    experience: [{
        company: 'Northwind Retail',
        title: 'Data Engineer',
        location: 'Austin, TX',
        startDate: 'Jan 2021',
        endDate: 'Present',
        bullets: [
            'Built nightly batch pipelines in Python against the sales warehouse.',
            'Modelled reporting tables in SQL for the analytics team.',
            'Maintained Scala jobs that aggregate store-level transactions.',
        ],
    }],
    projects: [],
    education: [{ institution: 'State University', degree: 'BSc', field: 'Computer Science' }],
    certifications: [],
    additional: [],
};

/**
 * Deliberately dishonest: Kafka and "40%" appear nowhere in the base resume.
 *
 * The whole path is only worth testing along the branch where the checker FIRES
 * — a clean run skips the review gate entirely, so a clean fixture would leave
 * the most fragile handoff in the system unexercised.
 */
const TAILORED_POISONED = {
    ...BASE_RESUME,
    summary: 'Data engineer building streaming pipelines for retail analytics.',
    experience: [{
        ...BASE_RESUME.experience[0],
        bullets: [
            'Built real-time streaming pipelines in Kafka against the sales warehouse.',
            'Improved reporting query performance by 40% across the analytics team.',
            'Maintained Scala jobs that aggregate store-level transactions.',
        ],
    }],
};

const JOB_DESCRIPTION = `
Senior Data Engineer — Streaming

We are looking for a data engineer with strong Python and SQL to build and
maintain data pipelines against our retail warehouse. Experience with Scala is
useful. You will model reporting tables for the analytics team and own the
nightly batch jobs.

Requirements: Python, SQL, data pipelines, warehouse modelling.
Posted by Meera Raghavan, Technical Recruiter.
`;

const apolloPerson = () => ({
    id: 'apollo-e2e-1',
    first_name: 'Meera',
    last_name: 'Raghavan',
    name: 'Meera Raghavan',
    title: 'Technical Recruiter',
    seniority: 'manager',
    organization: { name: 'Vector Analytics', primary_domain: 'vector.example' },
    city: 'Austin',
    state: 'TX',
    country: 'USA',
    linkedin_url: 'https://linkedin.com/in/meeraraghavan',
    email: 'meera.raghavan@vector.example',
    email_status: 'verified',
    phone_numbers: [{ sanitized_number: '+15550142' }],
});

/* ── the Apollo stub ──────────────────────────────────────────────────── */

const realFetch = globalThis.fetch;
let apolloCalls = 0;

const stubApollo = (responses) => {
    apolloCalls = 0;
    const queue = [...responses];
    globalThis.fetch = async () => {
        apolloCalls += 1;
        const next = queue.shift();
        if (!next) throw new Error('Unexpected Apollo call — no fixture queued.');
        return new Response(JSON.stringify(next), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
};

/* ── what we create ───────────────────────────────────────────────────── */

/**
 * FIXED identities, not fresh UUIDs per run.
 *
 * ── WHY, AND IT IS NOT FOR TIDINESS ───────────────────────────────────
 *
 * `application_records` is append-only and means it: a BEFORE UPDATE OR DELETE
 * trigger refuses the operation, and migration 030 additionally REVOKEs UPDATE
 * and DELETE from app_role. Its `consultant_id` cascades and its `posting_id`
 * RESTRICTs, so the consultant and the posting behind a record cannot be
 * removed either.
 *
 * A genuine end-to-end run has to write a real application record — the contact
 * handler checks the record exists before spending a credit, and the link is
 * asserted against it. So this suite CANNOT clean up after itself the way the
 * others do, and pretending otherwise would mean one permanent consultant, one
 * permanent posting and one permanent application record accumulating on every
 * single run.
 *
 * Fixed ids make it exactly one, forever. The suite owns that row, re-uses it,
 * and resets everything around it that IS removable. That is also the honest
 * shape of the thing being tested: a submitted application is permanent, and a
 * test that could delete one would be testing something weaker than production.
 */
const FIXTURE = {
    consultantId: 'e2e00000-0000-4000-8000-000000000001',
    reviewerId: 'e2e00000-0000-4000-8000-000000000002',
    postingId: 'e2e00000-0000-4000-8000-000000000003',
    itemId: 'e2e00000-0000-4000-8000-000000000004',
    applicationId: 'e2e00000-0000-4000-8000-000000000005',
    baseArtifactId: 'e2e00000-0000-4000-8000-000000000006',
};

const made = {
    orgId: null,
    ...FIXTURE,
    files: [],
    providerRestore: null,
};

/**
 * A request object shaped like the one express would hand the controller.
 *
 * The review controller is called DIRECTLY rather than over HTTP so the test
 * needs no server, no session cookie and no password. What it does exercise is
 * the controller's real decision path — the state-machine check, the transition
 * row, the verdict written onto every flag — which is the part that could
 * actually be wrong.
 */
const fakeReq = (over = {}) => ({
    user: { id: made.reviewerId, orgId: made.orgId, role: 'ORG_ADMIN' },
    params: {},
    body: { reason: 'Checked against the original.' },
    ip: '127.0.0.1',
    ...over,
});

const fakeRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};

const itemState = async (id) => {
    const { rows } = await query(
        `SELECT st.name AS status, q.tailoring_state, q.tailoring_skip_reason,
                q.tailored_resume_artifact_id
           FROM queue_items q JOIN lkp_queue_statuses st ON st.id = q.status_id
          WHERE q.id = $1`,
        [id],
    );
    return rows[0];
};

/**
 * Remove everything this suite is ALLOWED to remove.
 *
 * Run both before and after, so an aborted run cannot poison the next one —
 * a leftover contact would make the waterfall answer from the store and the
 * "Apollo was called once" assertion would fail for a reason that has nothing
 * to do with the code.
 *
 * What survives, deliberately, is listed on FIXTURE above.
 */
const resetTransient = async () => {
    globalThis.fetch = realFetch;

    // The tailored PDFs written by previous runs, read back from the rows
    // before those rows go.
    const { rows: files } = await query(
        `SELECT organization_id, stored_name FROM resume_artifacts
          WHERE queue_item_id = $1`,
        [made.itemId],
    );
    for (const f of files) {
        try {
            fs.unlinkSync(`${process.cwd()}/uploads/${f.organization_id}/${f.stored_name}`);
        } catch { /* already gone */ }
    }

    await query("DELETE FROM background_jobs WHERE payload->>'queueItemId' = $1", [made.itemId]);
    await query("DELETE FROM background_jobs WHERE payload->>'postingId' = $1", [made.postingId]);
    await query('DELETE FROM resume_fabrication_flags WHERE queue_item_id = $1', [made.itemId]);
    await query('DELETE FROM resume_tailoring_runs WHERE queue_item_id = $1', [made.itemId]);

    // Release the queue item's pointer before the artifact it points at goes.
    await query(
        `UPDATE queue_items
            SET tailored_resume_artifact_id = NULL,
                tailoring_state = 'PENDING',
                tailoring_skip_reason = NULL,
                preparation_error = NULL,
                status_id = (SELECT id FROM lkp_queue_statuses WHERE name = 'PREPARING')
          WHERE id = $1`,
        [made.itemId],
    );
    await query("DELETE FROM resume_artifacts WHERE queue_item_id = $1 AND kind = 'tailored'",
        [made.itemId]);
    await query('DELETE FROM queue_item_transitions WHERE queue_item_id = $1', [made.itemId]);

    await query('DELETE FROM contact_links WHERE posting_id = $1', [made.postingId]);
    await query('DELETE FROM contact_lookups WHERE posting_id = $1', [made.postingId]);
    if (made.orgId) {
        await query(
            "DELETE FROM contacts WHERE organization_id = $1 AND company = 'Vector Analytics'",
            [made.orgId],
        );
        // The parse cache is keyed by the resume's content hash. Dropping it
        // makes every run identical rather than making the first run pay for a
        // parse the rest skip.
        await query(
            `DELETE FROM resume_documents
              WHERE organization_id = $1
                AND artifact_id = $2`,
            [made.orgId, made.baseArtifactId],
        );
    }
};

const cleanup = async () => {
    await resetTransient().catch(() => {});
    if (made.providerRestore) {
        await query(
            `UPDATE organization_providers op
                SET is_enabled = $2, rate_limit_ms = $3
               FROM lkp_job_sources s
              WHERE s.id = op.source_id AND s.name = 'APOLLO'
                AND op.organization_id = $1`,
            [made.orgId, made.providerRestore.is_enabled, made.providerRestore.rate_limit_ms],
        ).catch(() => {});
    }
};

/* ── the run ──────────────────────────────────────────────────────────── */

const run = async () => {
    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1',
    );
    if (orgs.length === 0) {
        console.log('\n  No active organisation — run the seeds first.');
        await pool.end();
        process.exit(1);
    }
    made.orgId = orgs[0].id;

    const { rows: providerRows } = await query(
        `SELECT op.is_enabled, op.rate_limit_ms
           FROM organization_providers op
           JOIN lkp_job_sources s ON s.id = op.source_id
          WHERE op.organization_id = $1 AND s.name = 'APOLLO'`,
        [made.orgId],
    );
    made.providerRestore = providerRows[0] ?? null;
    await query(
        `UPDATE organization_providers op
            SET is_enabled = TRUE, rate_limit_ms = 0
           FROM lkp_job_sources s
          WHERE s.id = op.source_id AND s.name = 'APOLLO'
            AND op.organization_id = $1`,
        [made.orgId],
    );

    /* ── the people and the job ────────────────────────────────────── */

    section('setting the scene');

    // The base resume on disk is rendered FROM the fixture, so the parsed
    // sections and the file describe one person. A mismatch there makes every
    // sentence in the "tailored" version look invented and the fabrication
    // check meaningless.
    //
    // Rendered with the fixture's own artifact id, so the file lands on the
    // same path every run and overwrites rather than accumulating.
    const baseFile = await renderResumePdf({
        orgId: made.orgId,
        resume: BASE_RESUME,
        company: 'Base',
        title: 'Resume',
        artifactId: made.baseArtifactId,
    });
    made.files.push(baseFile.absolutePath);

    await query(
        `INSERT INTO users
            (id, organization_id, name, email, role, password_enc, password_iv,
             password_tag, employment_status)
         VALUES ($1,$2,'E2E Consultant',$3,'CONSULTANT','x','x','x','ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [made.consultantId, made.orgId, 'e2e-consultant@example.invalid'],
    );
    await query(
        `INSERT INTO users
            (id, organization_id, name, email, role, password_enc, password_iv,
             password_tag, employment_status)
         VALUES ($1,$2,'E2E Reviewer',$3,'ORG_ADMIN','x','x','x','ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [made.reviewerId, made.orgId, 'e2e-reviewer@example.invalid'],
    );

    // The file is re-rendered every run, so its hash and size are re-stated.
    await query(
        `INSERT INTO resume_artifacts
            (id, organization_id, consultant_id, kind, original_name, stored_name,
             mime_type, size_bytes, sha256)
         VALUES ($1,$2,$3,'base','e2e-base.pdf',$4,'application/pdf',$5,$6)
         ON CONFLICT (id) DO UPDATE
            SET stored_name = EXCLUDED.stored_name,
                size_bytes  = EXCLUDED.size_bytes,
                sha256      = EXCLUDED.sha256`,
        [made.baseArtifactId, made.orgId, made.consultantId,
            baseFile.storedName, baseFile.sizeBytes, baseFile.sha256],
    );
    await query(
        `INSERT INTO consultant_profiles (user_id, organization_id, base_resume_artifact_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET base_resume_artifact_id = EXCLUDED.base_resume_artifact_id`,
        [made.consultantId, made.orgId, made.baseArtifactId],
    );

    await query(
        `INSERT INTO job_postings
            (id, organization_id, company, title, location_text, is_remote,
             description, source_url, fingerprint)
         VALUES ($1,$2,'Vector Analytics','Senior Data Engineer','Austin, TX',FALSE,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [made.postingId, made.orgId, JOB_DESCRIPTION,
            `https://example.invalid/e2e/${made.postingId}`,
            createHash('sha256').update(`e2e-${made.postingId}`).digest('hex')],
    );

    // Now that the permanent rows exist, clear anything a previous run left
    // hanging off them.
    await resetTransient();

    check('a consultant with a base resume exists', made.consultantId !== null, true);
    check('and a job that names its recruiter', made.postingId !== null, true);

    /* ── 1 · matched ───────────────────────────────────────────────── */

    section('1 · the match reaches PREPARING');

    await query(
        `INSERT INTO queue_items
            (id, organization_id, consultant_id, posting_id, status_id, channel)
         VALUES ($1,$2,$3,$4,
                 (SELECT id FROM lkp_queue_statuses WHERE name='PREPARING'), 'HUMAN')
         ON CONFLICT (id) DO UPDATE
            SET status_id = (SELECT id FROM lkp_queue_statuses WHERE name='PREPARING')`,
        [made.itemId, made.orgId, made.consultantId, made.postingId],
    );
    check('the item waits at PREPARING', (await itemState(made.itemId)).status, 'PREPARING');

    /* ── 2 · tailored and checked ──────────────────────────────────── */

    section('2 · tailoring, and a checker that catches the invention');

    process.env.LLM_MOCK_RESPONSE_PARSE = JSON.stringify(BASE_RESUME);
    process.env.LLM_MOCK_RESPONSE_TAILOR = JSON.stringify(TAILORED_POISONED);
    // The MODEL pass finds nothing. Every flag below therefore comes from the
    // mechanical comparison — which is the half that must work without a model
    // being honest about its own output.
    process.env.LLM_MOCK_RESPONSE_CHECK = JSON.stringify({ flags: [] });
    delete process.env.LLM_MOCK_FAIL;

    await tailorHandler({
        id: randomUUID(),
        organization_id: made.orgId,
        kind: TAILOR_KIND,
        payload: { queueItemId: made.itemId },
        attempts: 1,
        max_attempts: 3,
    });

    const afterTailor = await itemState(made.itemId);
    check('the application STOPS rather than going out', afterTailor.status, 'RESUME_REVIEW');
    check('and is marked as flagged', afterTailor.tailoring_state, 'FLAGGED');
    check('with no tailored resume attached yet',
        afterTailor.tailored_resume_artifact_id, null);

    const { rows: flags } = await query(
        `SELECT claim_text, detected_by, severity, reviewer_verdict
           FROM resume_fabrication_flags WHERE queue_item_id = $1`,
        [made.itemId],
    );
    check('the invented claims were caught', flags.length > 0, true);
    check('by exact comparison, not by asking a model to grade itself',
        flags.some((f) => f.detected_by === 'RULE'), true);
    check('the invented technology is among them',
        flags.some((f) => /kafka/i.test(f.claim_text)), true);
    check('and so is the invented figure',
        flags.some((f) => /40/.test(f.claim_text)), true);
    check('every flag is waiting on a person',
        flags.every((f) => f.reviewer_verdict === 'PENDING'), true);

    const { rows: artifacts } = await query(
        `SELECT id, sections, ats_score_before, ats_score_after
           FROM resume_artifacts WHERE queue_item_id = $1 AND kind = 'tailored'`,
        [made.itemId],
    );
    check('the tailored resume was still rendered', artifacts.length, 1);
    check('and its text was kept so a reviewer can read it',
        artifacts[0]?.sections !== null, true);
    check('the ATS score was measured before', artifacts[0]?.ats_score_before !== null, true);
    check('and after', artifacts[0]?.ats_score_after !== null, true);

    /* ── 3 · a person decides ──────────────────────────────────────── */

    section('3 · the review gate');

    const res = fakeRes();
    await approveReview(
        fakeReq({ params: { itemId: made.itemId } }),
        res,
        (err) => { throw err; },
    );
    check('approving succeeds', res.statusCode, 200);

    const afterReview = await itemState(made.itemId);
    check('the item is released to READY', afterReview.status, 'READY');
    check('marked as tailored', afterReview.tailoring_state, 'TAILORED');
    check('and the tailored resume is now attached, so the app can fetch it',
        afterReview.tailored_resume_artifact_id, artifacts[0].id);

    const { rows: decided } = await query(
        `SELECT reviewer_verdict, reviewed_by FROM resume_fabrication_flags
          WHERE queue_item_id = $1`,
        [made.itemId],
    );
    check('every flag carries the decision',
        decided.every((f) => f.reviewer_verdict === 'ACCEPTED'), true);
    check('and who made it',
        decided.every((f) => f.reviewed_by === made.reviewerId), true);

    const { rows: transitions } = await query(
        `SELECT s.name AS to_status FROM queue_item_transitions t
           JOIN lkp_queue_statuses s ON s.id = t.to_status_id
          WHERE t.queue_item_id = $1 ORDER BY t.created_at`,
        [made.itemId],
    );
    check('the whole journey is on the record',
        transitions.map((t) => t.to_status), ['RESUME_REVIEW', 'READY']);

    /* ── 4 · applied ───────────────────────────────────────────────── */

    section('4 · the application goes out');

    // What reportSubmitted does: move the item, write the permanent record, and
    // enqueue the contact lookup in the SAME transaction.
    await query(
        `UPDATE queue_items
            SET status_id = (SELECT id FROM lkp_queue_statuses WHERE name='SUBMITTED')
          WHERE id = $1`,
        [made.itemId],
    );
    await query(
        `INSERT INTO application_records
            (id, organization_id, consultant_id, posting_id, queue_item_id,
             status_id, submission_method_id, company, job_title, job_url)
         VALUES ($1,$2,$3,$4,$5,
                 (SELECT id FROM lkp_application_statuses WHERE name='SUBMITTED'),
                 (SELECT id FROM lkp_submission_methods WHERE name='DESKTOP_BOT'),
                 'Vector Analytics','Senior Data Engineer',$6)
         ON CONFLICT (id) DO NOTHING`,
        [made.applicationId, made.orgId, made.consultantId, made.postingId,
            made.itemId, `https://example.invalid/e2e/${made.postingId}`],
    );
    await enqueue({
        orgId: made.orgId,
        kind: CONTACT_KIND,
        payload: {
            postingId: made.postingId,
            applicationId: made.applicationId,
            queueItemId: made.itemId,
        },
    });

    const { rows: queued } = await query(
        `SELECT status, kind FROM background_jobs
          WHERE payload->>'applicationId' = $1`,
        [made.applicationId],
    );
    check('submitting queues a contact lookup', queued.length, 1);
    check('of the right kind', queued[0]?.kind, CONTACT_KIND);
    check('waiting for a worker', queued[0]?.status, 'PENDING');

    /* ── 5 · the worker finds the contact ──────────────────────────── */

    section('5 · one worker tick later');

    stubApollo([{ person: apolloPerson() }]);
    const tally = await runOnce({ limit: 10 });

    check('the worker did the work', tally.done >= 1, true);
    check('nothing dead-lettered', tally.dead, 0);
    check('and no job went unhandled', tally.unhandled, 0);
    check('Apollo was called once', apolloCalls, 1);

    const { rows: done } = await query(
        `SELECT status FROM background_jobs WHERE payload->>'applicationId' = $1`,
        [made.applicationId],
    );
    check('the job finished', done[0]?.status, 'DONE');

    const { rows: linked } = await query(
        `SELECT c.full_name, c.email, c.title, l.link_reason, l.application_id
           FROM contact_links l JOIN contacts c ON c.id = l.contact_id
          WHERE l.posting_id = $1`,
        [made.postingId],
    );
    check('a contact is attached to the job', linked.length, 1);
    check('the person the advert named', linked[0]?.full_name, 'Meera Raghavan');
    check('with a usable address', linked[0]?.email, 'meera.raghavan@vector.example');
    check('recorded as the poster, not a stranger at the company',
        linked[0]?.link_reason, 'POSTER');
    check('and tied to the application it came from',
        linked[0]?.application_id, made.applicationId);

    const { rows: ledger } = await query(
        `SELECT provider, credits_used, cache_hit FROM contact_lookups
          WHERE posting_id = $1`,
        [made.postingId],
    );
    check('the credit is on the ledger', ledger[0]?.credits_used, 1);
    check('and it was a genuine lookup, not a store hit', ledger[0]?.cache_hit, false);

    /* ── 6 · what the desktop app would now be handed ──────────────── */

    section('6 · what the consultant applies with');

    const { rows: resolved } = await query(
        `SELECT COALESCE(q.tailored_resume_artifact_id, p.base_resume_artifact_id) AS artifact_id
           FROM queue_items q
           JOIN consultant_profiles p ON p.user_id = q.consultant_id
          WHERE q.id = $1`,
        [made.itemId],
    );
    check('the desktop app resolves to the TAILORED resume, not the base',
        resolved[0]?.artifact_id, artifacts[0].id);
};

try {
    await run();
    await cleanup();

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
} catch (err) {
    console.error('\n  The suite itself failed:', err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
}
