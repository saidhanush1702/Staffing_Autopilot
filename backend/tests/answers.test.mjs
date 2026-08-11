/**
 * Phase 4 — answer bank. HTTP-level suite against a running server.
 *
 *   node tests/answers.test.mjs        (backend on :5001, seeded demo data)
 *
 * Lives in the repo rather than a scratchpad, per ISSUES.md M-4: every earlier
 * suite was a throwaway script that no longer existed by the next session.
 *
 * FIXTURES: this creates its own consultant and recruiter rather than consuming
 * the seeded demo accounts, because those have been terminated by earlier suites
 * (ISSUES.md L-6). Terminated accounts cannot be reactivated, so a suite that
 * depends on named demo users breaks permanently the first time one is used.
 */
const BASE = process.env.TEST_API ?? 'http://localhost:5001/api';
let pass = 0; let fail = 0;

const login = async (email, password) => {
    const r = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
    return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
};

const call = async (cookie, method, path, body) => {
    const r = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await r.json(); } catch { /* no body */ }
    return { status: r.status, body: json };
};

const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
    ok ? pass += 1 : fail += 1;
};

const section = (t) => console.log(`\n— ${t} —`);

const run = async () => {
    const admin = await login('admin@molina.local', 'Admin@123');
    const apex = await login('admin@apex.local', 'Admin@123');
    const superadmin = await login('superadmin@staffing.local', 'SuperAdmin@123');

    const stamp = Date.now();
    let seq = 0;
    const mk = async (role, name) => {
        // Counter as well as timestamp: two consultants created in the same
        // millisecond would otherwise collide on email.
        seq += 1;
        const email = `p4-${role.toLowerCase()}-${stamp}-${seq}@molina.local`;
        const r = await call(admin, 'POST', '/management/users', {
            name, email, phone: '5550100000', role, password: 'Consultant@123',
        });
        if (r.status !== 201) throw new Error(`create ${role} -> ${r.status} ${JSON.stringify(r.body)}`);
        const users = (await call(admin, 'GET', `/management/users?limit=200&role=${role}`)).body.users;
        return { id: users.find((u) => u.email === email).id, email };
    };

    const rec = await mk('RECRUITER', 'Phase Four Recruiter');
    const con = await mk('CONSULTANT', 'Phase Four Consultant');
    const other = await mk('CONSULTANT', 'Phase Four Other');
    await call(admin, 'PUT', `/management/assignments/recruiter/${rec.id}`, { consultantIds: [con.id] });

    const recCk = await login(rec.email, 'Consultant@123');
    const conCk = await login(con.email, 'Consultant@123');
    const otherCk = await login(other.email, 'Consultant@123');

    section('seeded question bank');
    const lookups = (await call(admin, 'GET', '/lookups')).body;
    check('answerStatuses in lookups', lookups.answerStatuses.length, 4);
    check('questionCategories in lookups', lookups.questionCategories.length, 4);
    check('SALARY is owner-only',
        lookups.questionCategories.find((c) => c.name === 'SALARY').requires_owner_approval, true);
    check('GENERAL is not',
        lookups.questionCategories.find((c) => c.name === 'GENERAL').requires_owner_approval, false);

    const mine = (await call(conCk, 'GET', '/portal/questions')).body;
    check('consultant has outstanding questions', mine.outstanding.length > 0, true);
    check('none answered yet', mine.answers.length, 0);
    const general = mine.outstanding.find((q) => q.category_name === 'GENERAL');
    const salary = mine.outstanding.find((q) => q.category_name === 'SALARY');
    const workAuth = mine.outstanding.find((q) => q.category_name === 'WORK_AUTH');
    check('bank has a GENERAL question', !!general, true);
    check('bank has a SALARY question', !!salary, true);
    check('bank has a WORK_AUTH question', !!workAuth, true);

    section('answering');
    let r = await call(conCk, 'POST', '/portal/answers',
        { questionId: general.id, answerText: '7 years' });
    check('submit', r.status, 201);
    check('  revision 1', r.body.revisionNo, 1);
    r = await call(conCk, 'POST', '/portal/answers',
        { questionId: general.id, answerText: '7 years' });
    check('identical resubmit refused', r.status, 409);
    r = await call(conCk, 'POST', '/portal/answers',
        { questionId: general.id, answerText: '8 years' });
    check('changed resubmit', r.status, 201);
    check('  revision 2', r.body.revisionNo, 2);
    const bank = (await call(conCk, 'GET', '/portal/questions')).body;
    check('exactly one current row for that question',
        bank.answers.filter((a) => a.question_id === general.id).length, 1);
    check('  and it is revision 2',
        bank.answers.find((a) => a.question_id === general.id).revision_no, 2);
    r = await call(conCk, 'POST', '/portal/answers', { questionId: general.id, answerText: '   ' });
    check('blank answer refused', r.status, 422);

    await call(conCk, 'POST', '/portal/answers',
        { questionId: salary.id, answerText: '$75/hr' });
    await call(conCk, 'POST', '/portal/answers',
        { questionId: workAuth.id, answerText: 'US citizen, no sponsorship needed' });

    section('R-07 routing');
    const inbox = (await call(recCk, 'GET', '/management/answers')).body;
    const items = inbox.data;
    const byQ = (qid) => items.find((i) => i.questionId === qid);
    check('recruiter sees the GENERAL item', !!byQ(general.id), true);
    check('  and it is actionable', byQ(general.id).canReview, true);
    check('recruiter SEES the SALARY item', !!byQ(salary.id), true);
    check('  but it is locked', byQ(salary.id).canReview, false);
    check('  with a reason', typeof byQ(salary.id).lockedReason, 'string');
    check('WORK_AUTH also locked', byQ(workAuth.id).canReview, false);

    r = await call(recCk, 'POST', `/management/answers/${byQ(salary.id).id}/review`,
        { decision: 'APPROVE' });
    check('recruiter approving SALARY -> 403', r.status, 403);
    r = await call(recCk, 'POST', `/management/answers/${byQ(workAuth.id).id}/review`,
        { decision: 'APPROVE' });
    check('recruiter approving WORK_AUTH -> 403', r.status, 403);
    r = await call(admin, 'POST', `/management/answers/${byQ(salary.id).id}/review`,
        { decision: 'APPROVE' });
    check('ORG_ADMIN approving SALARY -> 200', r.status, 200);

    section('reviewing');
    r = await call(recCk, 'POST', `/management/answers/${byQ(general.id).id}/review`,
        { decision: 'APPROVE' });
    check('approve as-is', r.status, 200);
    check('  not marked corrected', r.body.wasCorrected, false);

    const q2 = mine.outstanding.filter((q) => q.category_name === 'GENERAL' && q.id !== general.id)[0];
    await call(conCk, 'POST', '/portal/answers', { questionId: q2.id, answerText: 'yes maybe' });
    const inbox2 = (await call(recCk, 'GET', '/management/answers')).body;
    const it2 = inbox2.data.find((i) => i.questionId === q2.id);
    r = await call(recCk, 'POST', `/management/answers/${it2.id}/review`,
        { decision: 'APPROVE', correctedText: 'Yes' });
    check('correct and approve', r.status, 200);
    check('  marked corrected', r.body.wasCorrected, true);
    const afterCorrect = (await call(conCk, 'GET', '/portal/questions')).body
        .answers.find((a) => a.question_id === q2.id);
    check('  consultant original preserved', afterCorrect.proposed_text, 'yes maybe');
    check('  approved text is the reviewer edit', afterCorrect.approved_text, 'Yes');

    const q3 = mine.outstanding.filter((q) => q.category_name === 'GENERAL'
        && ![general.id, q2.id].includes(q.id))[0];
    await call(conCk, 'POST', '/portal/answers', { questionId: q3.id, answerText: 'dunno' });
    const it3 = (await call(recCk, 'GET', '/management/answers')).body.data
        .find((i) => i.questionId === q3.id);
    r = await call(recCk, 'POST', `/management/answers/${it3.id}/review`, { decision: 'REJECT' });
    check('reject with no note -> 422', r.status, 422);
    r = await call(recCk, 'POST', `/management/answers/${it3.id}/review`,
        { decision: 'REJECT', note: 'Please give a specific answer.' });
    check('reject with a note', r.status, 200);
    const rejected = (await call(conCk, 'GET', '/portal/questions')).body
        .answers.find((a) => a.question_id === q3.id);
    check('  consultant sees the note', rejected.review_note, 'Please give a specific answer.');
    r = await call(recCk, 'POST', `/management/answers/${it3.id}/review`,
        { decision: 'APPROVE' });
    check('deciding an already-decided answer -> 409', r.status, 409);
    r = await call(conCk, 'POST', '/portal/answers',
        { questionId: q3.id, answerText: 'About 4 years.' });
    check('consultant can re-answer after rejection', r.status, 201);

    section('permissions — negatives');
    r = await call(otherCk, 'GET', '/portal/questions');
    check('another consultant sees their own only', r.status, 200);
    check('  and has nothing answered', r.body.answers.length, 0);
    r = await call(conCk, 'GET', '/management/answers');
    check('consultant cannot open the inbox -> 403', r.status, 403);
    r = await call(conCk, 'POST', `/management/answers/${it3.id}/review`, { decision: 'APPROVE' });
    check('consultant cannot review -> 403', r.status, 403);
    r = await call(apex, 'POST', `/management/answers/${it3.id}/review`, { decision: 'APPROVE' });
    check('cross-tenant review -> 404', r.status, 404);
    r = await call(superadmin, 'GET', '/management/answers');
    check('super admin -> 403', r.status, 403);

    const rec2 = await mk('RECRUITER', 'Phase Four Recruiter Two');
    const rec2Ck = await login(rec2.email, 'Consultant@123');
    r = await call(rec2Ck, 'GET', '/management/answers');
    check('unassigned recruiter sees an empty inbox',
        r.body.data.length, 0);
    const stillPending = (await call(admin, 'GET', '/management/answers')).body.data
        .find((i) => i.status === 'PENDING');
    if (stillPending) {
        r = await call(rec2Ck, 'POST', `/management/answers/${stillPending.id}/review`,
            { decision: 'APPROVE' });
        check('unassigned recruiter reviewing -> 404', r.status, 404);
    }

    section('question bank');
    // The bank persists between runs and correctly 409s a duplicate, so these
    // fixtures carry the run stamp — otherwise the suite passes once and then
    // fails forever on its own leftovers.
    const salaryQ = `What is your desired base salary for role ${stamp}?`;
    r = await call(admin, 'POST', '/management/questions', { questionText: salaryQ });
    check('new question auto-categorised', r.status, 201);
    check('  as SALARY (owner-only)', r.body.question.category_name, 'SALARY');
    r = await call(admin, 'POST', '/management/questions',
        { questionText: `what is your DESIRED base salary for role ${stamp}???` });
    check('same question in different wording -> 409 duplicate', r.status, 409);
    r = await call(admin, 'POST', '/management/questions',
        { questionText: `Describe a time you handled a difficult stakeholder ${stamp}.` });
    check('unclassifiable question accepted', r.status, 201);
    check('  and routed to owner review, not GENERAL',
        lookups.questionCategories.find((c) => c.name === r.body.question.category_name)
            .requires_owner_approval, true);
    r = await call(recCk, 'POST', '/management/questions', { questionText: 'Recruiter cannot add this one directly.' });
    check('recruiter cannot edit the shared bank -> 403', r.status, 403);
    r = await call(recCk, 'POST', `/management/consultants/${con.id}/questions`,
        { questionText: 'Have you used Kubernetes in production?' });
    check('recruiter CAN raise one at their consultant', r.status, 201);
    r = await call(recCk, 'POST', `/management/consultants/${other.id}/questions`,
        { questionText: 'Should not be allowed.' });
    check('  but not at an unassigned consultant -> 404', r.status, 404);

    section('lifecycle');
    await call(conCk, 'POST', '/portal/answers',
        { questionId: mine.outstanding.filter((q) => q.category_name === 'GENERAL')[3].id,
            answerText: 'pending at termination' });
    const t = await call(admin, 'POST', `/management/users/${con.id}/terminate`, { reason: 'phase 4 test' });
    check('terminate', t.status, 200);
    check('  cancels pending answers', t.body.cancelledAnswers > 0, true);
    // Filtered by the consultant's own bank rather than by display name — an
    // earlier aborted run can leave a same-named fixture behind, and matching
    // on name would then count somebody else's pending answers as leftovers.
    const leftover = (await call(admin, 'GET', `/management/consultants/${con.id}/answers`))
        .body.answers.filter((a) => a.status_name === 'PENDING');
    check('  none left pending for this consultant', leftover.length, 0);

    section('audit');
    const logs = (await call(admin, 'GET', '/management/audit-logs/answers')).body;
    const entries = logs.logs ?? logs.auditLogs ?? [];
    const actions = [...new Set(entries.map((e) => e.action))];
    console.log(`  actions: ${actions.join(' | ')}`);
    check('submission audited', actions.includes('Submitted Answer'), true);
    check('approval audited', actions.includes('Approved Answer'), true);
    check('rejection audited', actions.includes('Rejected Answer'), true);
    const corr = entries.find((e) => (e.description ?? '').includes('CORRECTED'));
    check('correction records before AND after text', !!corr, true);
    if (corr) console.log(`  sample: ${corr.description}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(`fixtures left behind: ${con.email}, ${other.email}, ${rec.email}, ${rec2.email}`);
    process.exit(fail ? 1 : 0);
};

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
