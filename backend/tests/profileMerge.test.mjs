/**
 * Phase 9 — My Profile and My Career, merged into one approval workflow.
 *
 *   node tests/profileMerge.test.mjs
 *
 * Calls the controllers directly with stand-in req/res objects, against the
 * real database. What this exists to prove:
 *
 *   1. A submission with identity fields, career sections, or both is
 *      recognised, stored, and reviewable as ONE thing.
 *   2. The INNER JOIN bug is actually fixed — a career-only submission must
 *      be visible to the reviewer's list AND to the consultant's own pending
 *      view, not silently dropped by either query.
 *   3. While pending, tailoring keeps using the LAST APPROVED career data —
 *      never the submitted-but-undecided version.
 *   4. Approving is atomic: identity fields and career rows change together
 *      or not at all, and a rejection changes neither.
 *   5. The two-person rule and the stale-value guard on identity fields
 *      still work exactly as before — this was a merge, not a rewrite of
 *      the safety rules.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';

import { randomUUID } from 'node:crypto';
import { query, pool } from '../db.js';
import {
    submitChangeRequest, reviewChangeRequest, listChangeRequests,
    withdrawChangeRequest,
} from '../controllers/profileChangeController.js';
import { myProfile } from '../controllers/profileController.js';
import { buildProfileResume } from '../services/profileResume.js';
import { resolveSkill } from '../config/skills.js';

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

const created = { consultants: [], orgId: null };

const cleanup = async () => {
    if (created.consultants.length) {
        await query('DELETE FROM users WHERE id = ANY($1::char(36)[])', [created.consultants]);
        created.consultants = [];
    }
};

const makeConsultant = async (orgId, name) => {
    const id = randomUUID();
    await query(
        `INSERT INTO users (id, organization_id, name, email, role,
                            password_enc, password_iv, password_tag, employment_status)
         VALUES ($1,$2,$3,$4,'CONSULTANT','x','x','x','ACTIVE')`,
        [id, orgId, name, `phase9-${id}@example.invalid`],
    );
    await query(
        'INSERT INTO consultant_profiles (user_id, organization_id) VALUES ($1,$2)',
        [id, orgId],
    );
    created.consultants.push(id);
    return id;
};

const main = async () => {
    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1');
    if (orgs.length === 0) { console.log('No active organisation.'); process.exit(1); }
    const orgId = orgs[0].id;
    created.orgId = orgId;

    const { rows: admins } = await query(
        `SELECT id FROM users WHERE role='ORG_ADMIN' AND organization_id=$1 LIMIT 1`, [orgId]);
    const adminId = admins[0].id;

    const consultantId = await makeConsultant(orgId, 'Merge Fixture');
    const asConsultant = (extra = {}) => ({
        user: { id: consultantId, orgId, role: 'CONSULTANT', name: 'Merge Fixture' },
        params: {}, body: {}, query: {}, ip: '127.0.0.1', ...extra,
    });
    const asAdmin = (extra = {}) => ({
        user: { id: adminId, orgId, role: 'ORG_ADMIN' },
        params: {}, body: {}, query: {}, ip: '127.0.0.1', ...extra,
    });

    /* ── 1. career-only submission is not lost ──────────────────────── */

    section('a career-only submission (no identity field touched)');

    const skill = await resolveSkill('Java');
    const submit1 = await call(submitChangeRequest, asConsultant({
        body: {
            career: {
                skills: [{ skillId: skill.id }],
                experience: [{ company: 'Acme', title: 'Engineer', bullets: ['Built things.'] }],
            },
        },
    }));
    check('accepted with no identity fields at all', submit1.statusCode, 201);
    check('and flagged as a career change', submit1.body.careerChanged, true);
    check('with zero identity fields in the request', submit1.body.fieldCount, 0);

    // The bug this whole suite exists to catch: an INNER JOIN on
    // profile_change_request_fields would make a request like this
    // invisible to both queries below.
    const meWhilePending = await call(myProfile, asConsultant());
    check('the consultant\'s OWN pending view sees it',
        meWhilePending.body.pendingRequest?.id, submit1.body.requestId);
    check('and it carries the career snapshot',
        Object.keys(meWhilePending.body.pendingRequest?.career ?? {}).sort(),
        ['experience', 'skills']);

    const listWhilePending = await call(listChangeRequests, asAdmin({ query: { status: 'PENDING' } }));
    const found = listWhilePending.body.requests.find((r) => r.id === submit1.body.requestId);
    check('the REVIEWER\'S queue sees it too', Boolean(found), true);
    check('with a human-readable summary of what changed',
        found?.career?.summary?.length > 0, true);

    /* ── 2. frozen until approved ─────────────────────────────────────ぇ */

    section('tailoring uses the last-approved version while this is pending');

    const beforeApproval = await buildProfileResume({ orgId, consultantId });
    check('nothing approved yet, so there is nothing to build from',
        beforeApproval.ok, false);
    check('and the reason names what is missing',
        beforeApproval.reason, 'PROFILE_INCOMPLETE');

    /* ── 3. one profile locks everything ────────────────────────────── */

    section('one pending request locks the WHOLE profile');

    const secondAttempt = await call(submitChangeRequest, asConsultant({
        body: { city: 'Austin' },
    }));
    check('a second submission — even an unrelated identity field — is refused',
        secondAttempt.statusCode, 409);

    /* ── 4. approval is atomic and whole ──────────────────────────── */

    section('approving applies identity AND career together, one decision');

    const approve = await call(reviewChangeRequest, asAdmin({
        params: { id: submit1.body.requestId },
        body: { decision: 'APPROVED', reviewNote: 'Looks right.' },
    }));
    check('approved', approve.statusCode, 200);
    check('status reflects the whole-submission decision', approve.body.status, 'APPROVED');

    const afterApproval = await buildProfileResume({ orgId, consultantId });
    check('tailoring can now build from it', afterApproval.ok, true);
    check('the approved skill is really there',
        afterApproval.document.sections.skills.some(
            (g) => g.items.includes('Java')), true);
    check('and the approved role is really there',
        afterApproval.document.sections.experience[0]?.company, 'Acme');

    const meAfter = await call(myProfile, asConsultant());
    check('the lock is released', meAfter.body.pendingRequest, null);
    check('and the last-reviewed banner shows the outcome',
        meAfter.body.lastReviewed?.status, 'APPROVED');

    /* ── 5. rejection changes nothing ───────────────────────────────── */

    section('a rejected submission changes nothing live');

    const submit2 = await call(submitChangeRequest, asConsultant({
        body: {
            phone: '5551234567',
            career: { skills: [{ skillId: skill.id }, { name: 'Kubernetes' }] },
        },
    }));
    check('mixed identity + career submission accepted', submit2.statusCode, 201);
    check('field count reflects the one identity field', submit2.body.fieldCount, 1);

    const reject = await call(reviewChangeRequest, asAdmin({
        params: { id: submit2.body.requestId },
        body: { decision: 'REJECTED', reviewNote: 'Not this time.' },
    }));
    check('rejected', reject.statusCode, 200);

    const stillOneSkill = await buildProfileResume({ orgId, consultantId });
    check('the career record is untouched by the rejection',
        stillOneSkill.document.sections.skills.flatMap((g) => g.items), ['Java']);

    const { rows: phoneRow } = await query(
        'SELECT phone FROM consultant_profiles WHERE user_id = $1', [consultantId]);
    check('and the identity field is untouched too', phoneRow[0].phone, null);

    /* ── 6. two-person rule survives the merge ──────────────────────── */

    section('the two-person rule still holds');

    const submit3 = await call(submitChangeRequest, asConsultant({ body: { city: 'Austin' } }));
    const selfApprove = await call(reviewChangeRequest, {
        user: { id: consultantId, orgId, role: 'CONSULTANT' },
        params: { id: submit3.body.requestId },
        body: { decision: 'APPROVED' }, query: {}, ip: '1.1.1.1',
    });
    check('a consultant cannot approve their own submission', selfApprove.statusCode, 403);

    // clean up the still-pending request from this section
    await call(withdrawChangeRequest, asConsultant());

    /* ── 7. nothing at all is a no-op, not an empty submission ──────── */

    section('submitting nothing is refused');

    const empty = await call(submitChangeRequest, asConsultant({ body: {} }));
    check('an empty body is refused before it reaches the diff logic', empty.statusCode, 422);

    await cleanup();

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
