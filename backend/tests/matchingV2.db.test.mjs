/**
 * Matching v2 — end to end against the database.
 *
 *   npm run migrate        (applies 060_matcher_v2.sql)
 *   node tests/matchingV2.db.test.mjs
 *
 * Needs migration 060: it adds the organisation's matcher version, the
 * "open to relocate" flag, and the SUGGESTED / NOT_A_FIT match states the
 * middle outcome is stored as. Without it this file says so and stops — it is
 * the one piece of the matching work that cannot be exercised before then, and
 * a test that failed for that reason would only teach people to ignore it.
 *
 * Everything runs inside a throwaway organisation's rows and is removed again.
 */
process.env.MATCH_REMATCH_ON_SAVE = '0';

import { createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { hasColumn } from '../services/benchExtras.js';
import { rematchConsultant } from '../services/rematch.js';
import { loadMatchableConsultants } from '../controllers/discoveryController.js';
import {
    listSuggestions, acceptSuggestionRoute, dismissSuggestionRoute,
    getMatchingSettings, putMatchingSettings, bench,
} from '../controllers/matchingController.js';
import { saveCriteria, getCriteria } from '../controllers/criteriaController.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

if (!(await hasColumn('organizations', 'matcher_version'))) {
    console.log('\n  SKIPPED — migration 060 has not been applied (run `npm run migrate`), so there is nothing here to test yet.');
    await pool.end();
    process.exit(0);
}

const ID = (n) => `b7a7c0de-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const ORG = ID(1);
const ADMIN = ID(2);
const C1 = ID(3);
const C2 = ID(4);

const fakeRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
};
const call = async (handler, req) => {
    const res = fakeRes();
    let failure = null;
    await handler(req, res, (err) => { failure = err; });
    if (failure) throw failure;
    return res;
};
const admin = { id: ADMIN, orgId: ORG, role: 'ORG_ADMIN' };

const cleanup = async () => {
    await query('DELETE FROM queue_item_transitions WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM queue_items WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM job_matches WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM job_postings WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM users WHERE organization_id = $1', [ORG]);
};

const posting = async (n, { title, location = 'Dallas, TX', description = '', ...rest }) => {
    const id = ID(30 + n);
    await query(
        `INSERT INTO job_postings (id, organization_id, company, title, location_text, is_remote, description,
                                   source_url, fingerprint)
         VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7,$8)`,
        [id, ORG, `Co ${n}`, title, location, description, `https://example.invalid/m2/${n}`,
            createHash('sha256').update(`m2-${n}`).digest('hex')],
    );
    return id;
};

const run = async () => {
    await cleanup();
    await query(`INSERT INTO organizations (id, name, slug) VALUES ($1,'Matching Bench Test','matching-bench-test')
                 ON CONFLICT DO NOTHING`, [ORG]);
    for (const [id, name, role] of [[ADMIN, 'Admin', 'ORG_ADMIN'], [C1, 'Citizen Dev', 'CONSULTANT'], [C2, 'Visa Dev', 'CONSULTANT']]) {
        await query(
            `INSERT INTO users (id, organization_id, name, email, role, password_enc, password_iv, password_tag, employment_status)
             VALUES ($1,$2,$3,$4,$5,'x','x','x','ACTIVE')`,
            [id, ORG, name, `${id}@example.invalid`, role],
        );
    }
    const { rows: auth } = await query(`SELECT id, name FROM lkp_work_auth_statuses WHERE name IN ('US Citizen','H1-B')`);
    const authId = (n) => auth.find((a) => a.name === n)?.id ?? null;
    for (const [id, a] of [[C1, 'US Citizen'], [C2, 'H1-B']]) {
        await query(`INSERT INTO consultant_profiles (user_id, organization_id, city, state, work_auth_status_id)
                     VALUES ($1,$2,'Dallas','TX',$3)`, [id, ORG, authId(a)]);
    }
    const { rows: skills } = await query(`SELECT id, slug FROM lkp_skills WHERE slug = ANY($1)`, [['react', 'javascript']]);
    let pos = 0;
    for (const id of [C1, C2]) {
        pos = 0;
        for (const s of skills) {
            await query(`INSERT INTO consultant_skills (id, organization_id, consultant_id, skill_id, position)
                         VALUES (gen_random_uuid()::char(36),$1,$2,$3,$4)`, [ORG, id, s.id, pos]);
            pos += 1;
        }
    }

    section('criteria carry "open to relocate" (migration 060)');
    for (const id of [C1, C2]) {
        const res = await call(saveCriteria, {
            user: admin, ip: '127.0.0.1', params: { id },
            body: {
                jobTitles: ['React Developer'], keywordsInclude: ['React'], keywordsExclude: [], excludedCompanies: [],
                locations: [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE', radiusMiles: 25 }],
                workTypeIds: [], minPay: { amount: null, unit: null, currency: 'USD' },
                openToRelocate: id === C1, changeNote: 'matching v2 db test',
            },
        });
        check(`criteria saved for ${id === C1 ? 'the citizen' : 'the visa holder'}`, res.statusCode, 201);
        await query('UPDATE search_criteria SET is_active = TRUE WHERE consultant_id = $1', [id]);
    }
    let got = await call(getCriteria, { user: admin, params: { id: C1 } });
    check('  the flag is stored and read back', got.body.version.openToRelocate, true);
    got = await call(getCriteria, { user: admin, params: { id: C2 } });
    check('  and is false when not asked for', got.body.version.openToRelocate, false);

    section('the organisation chooses the matcher');
    let res = await call(getMatchingSettings, { user: admin });
    check('v1 by default', [res.body.version, res.body.available], [1, true]);
    check('a bench loaded under v1 carries v1', (await loadMatchableConsultants(ORG))[0].criteria.matcherVersion, 1);
    res = await call(putMatchingSettings, { user: admin, body: { version: 3 }, ip: '127.0.0.1' });
    check('an unknown version is refused', res.statusCode, 422);
    res = await call(putMatchingSettings, { user: admin, body: { version: 2 }, ip: '127.0.0.1' });
    check('switched to v2', res.body.version, 2);
    const loaded = await loadMatchableConsultants(ORG);
    check('the bench now carries v2, with skills, years and relocation',
        [loaded[0].criteria.matcherVersion, loaded[0].criteria.skills.length > 0, 'totalYears' in loaded[0].criteria,
            loaded.find((c) => c.id === C1).criteria.openToRelocate], [2, true, true, true]);
    check('  and work authorization', loaded.find((c) => c.id === C2).criteria.workAuth, 'H1-B');

    section('three outcomes, through the real re-match');
    const react = 'We build with React and JavaScript.';
    await posting(1, { title: 'React Developer', description: react });
    await posting(2, { title: 'Platform Developer', description: 'React plus Kubernetes, Go and Java services on Kafka.' });
    await posting(3, { title: 'Accountant', description: 'Books and tax.' });
    await posting(4, { title: 'React Developer', description: `${react} US citizens only.` });
    await posting(5, { title: 'React Developer', location: 'Seattle, WA (Hybrid)', description: react });

    let out = await rematchConsultant({ orgId: ORG, consultantId: C1 });
    check('the citizen is checked against the whole pool', out.considered, 5);
    check('  a clear fit is queued', out.linked >= 1, true);
    const statusOf = async (n, who) => (await query(
        `SELECT m.status FROM job_matches m WHERE m.posting_id = $1 AND m.consultant_id = $2`, [ID(30 + n), who])).rows[0]?.status;
    check('  the clear fit is QUEUED', await statusOf(1, C1), 'QUEUED');
    check('  the partial fit is SUGGESTED, with nothing in the queue',
        [await statusOf(2, C1),
            (await query(`SELECT 1 FROM queue_items WHERE posting_id = $1 AND consultant_id = $2`, [ID(32), C1])).rowCount], ['SUGGESTED', 0]);
    check('  an accountant is not stored at all', await statusOf(3, C1), undefined);
    check('  citizens-only is fine for the citizen', await statusOf(4, C1), 'QUEUED');
    check('  a hybrid role in another state: a suggestion, as they would relocate', await statusOf(5, C1), 'SUGGESTED');

    out = await rematchConsultant({ orgId: ORG, consultantId: C2 });
    check('the visa holder is not offered the citizens-only job', await statusOf(4, C2), undefined);
    check('  but is offered the ordinary one', await statusOf(1, C2), 'QUEUED');
    check('  and cannot be sent to Seattle, having said they will not relocate', await statusOf(5, C2), undefined);

    section('the recruiter\'s list');
    res = await call(listSuggestions, { user: admin, query: {} });
    check('suggestions are grouped by job', res.body.suggestions.every((s) => s.candidates.length >= 1), true);
    const platform = res.body.suggestions.find((s) => s.title === 'Platform Developer');
    check('the partial fit is on it, with a reason', [Boolean(platform), /React/.test(platform?.candidates[0].reason ?? '')], [true, true]);

    const matchId = platform.candidates[0].matchId;
    res = await call(acceptSuggestionRoute, { user: admin, params: { matchId }, ip: '127.0.0.1' });
    check('linking one puts it in the consultant\'s queue', [res.statusCode, res.body.linked], [201, true]);
    check('  and the match becomes QUEUED', (await query('SELECT status FROM job_matches WHERE id = $1', [matchId])).rows[0].status, 'QUEUED');
    res = await call(acceptSuggestionRoute, { user: admin, params: { matchId }, ip: '127.0.0.1' });
    check('  linking it twice is refused', res.statusCode, 409);

    const other = (await call(listSuggestions, { user: admin, query: {} })).body.suggestions
        .flatMap((s) => s.candidates).find((c) => c.consultantId === C1);
    if (other) {
        res = await call(dismissSuggestionRoute, { user: admin, params: { matchId: other.matchId }, body: { note: 'wrong stack' }, ip: '127.0.0.1' });
        check('"not a fit" is accepted', res.body.dismissed, true);
        out = await rematchConsultant({ orgId: ORG, consultantId: C1 });
        check('  and it is never suggested again', (await query('SELECT status FROM job_matches WHERE id = $1', [other.matchId])).rows[0].status, 'NOT_A_FIT');
    }

    res = await call(listSuggestions, { user: { ...admin, orgId: ID(99) }, query: {} });
    check('another organisation sees none of it', res.body.total, 0);

    section('the bench screen');
    res = await call(bench, { user: admin });
    check('both consultants are matchable', res.body.matchable, 2);
};

try {
    await run();
} catch (err) {
    fail += 1;
    console.log(`  FAIL  the suite itself failed: ${err.stack ?? err.message}`);
} finally {
    await cleanup().catch((e) => console.log(`  (cleanup: ${e.message})`));
    await query('UPDATE organizations SET matcher_version = 1 WHERE id = $1', [ORG]).catch(() => {});
    await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
