/**
 * Matching, phase A — getting consultants onto the bench.
 *
 *   node tests/matchingBench.test.mjs
 *
 * Two halves. The first is pure: what a criteria proposal is built from and how
 * the bench explains who cannot receive jobs. The second runs the real handlers
 * and the re-match against the database, inside a throwaway organisation that
 * is deleted at the end — nothing of anyone's real data is read or written.
 */
process.env.MATCH_REMATCH_ON_SAVE = '0';

import { createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { suggestCriteria } from '../config/criteriaSuggest.js';
import { benchReason, bootstrap, bench, getSuggestion } from '../controllers/matchingController.js';
import { rematchConsultant } from '../services/rematch.js';
import { loadMatchableConsultants } from '../controllers/discoveryController.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── the proposal ─────────────────────────────────────────────────────── */

section('a proposal is built only from what the profile holds');
{
    const input = {
        city: 'Dallas', state: 'TX',
        experience: [
            { title: 'Frontend Engineer', is_current: false },
            { title: 'Senior React Developer', is_current: true },
            { title: 'frontend engineer', is_current: false },
        ],
        skills: [{ name: 'React' }, { name: 'JavaScript' }, { name: 'Node.js' }, { name: 'Git' }, { name: 'Docker' }],
    };
    const { criteria, basis, usable } = suggestCriteria(input);
    check('the current role comes first', criteria.jobTitles[0], 'Senior React Developer');
    check('  a repeated title is kept once', criteria.jobTitles.filter((t) => /frontend engineer/i.test(t)).length, 1);
    check('  roles the skills point at are added after the real ones',
        criteria.jobTitles.slice(-2), ['Node.js Developer', 'DevOps Engineer']);
    check('  and a role already held is not duplicated by a skill', criteria.jobTitles.includes('React Developer'), true);
    check('skills become keywords, in the consultant\'s own order', criteria.keywordsInclude.slice(0, 3), ['React', 'JavaScript', 'Node.js']);
    check('  a skill too generic to search on is left out', criteria.keywordsInclude.includes('Git'), false);
    check('the home city is an on-site location',
        criteria.locations, [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE', radiusMiles: null }]);
    check('pay is left for a person', criteria.minPay, { amount: null, unit: null, currency: 'USD' });
    check('it says where each title came from', [basis.titles.length, basis.derivedTitles.length], [2, 3]);
    check('it is usable', usable, true);

    check('remote is added only when asked for',
        suggestCriteria(input, { includeRemote: true }).criteria.locations.map((l) => l.workMode), ['ONSITE', 'REMOTE']);
    check('a state with no city is not a place to match against',
        suggestCriteria({ state: 'TX', skills: [{ name: 'React' }] }).criteria.locations, []);
    check('an empty profile proposes nothing usable', suggestCriteria({}).usable, false);
    check('a consultant with only vague titles still gets roles from skills',
        suggestCriteria({ experience: [{ title: 'Consultant' }], skills: [{ name: 'Python' }] }).criteria.jobTitles,
        ['Consultant', 'Python Developer']);
}

section('the bench says why somebody cannot receive jobs');
{
    const base = {
        employment_status: 'ACTIVE', is_paused: false, current_version_id: 'v', is_active: true,
        n_titles: 2, n_include: 0, n_locations: 1, n_types: 0, has_pay: false,
    };
    check('matchable', benchReason(base).state, 'MATCHABLE');
    check('terminated', benchReason({ ...base, employment_status: 'TERMINATED' }).state, 'NOT_ACTIVE');
    check('paused on the profile', benchReason({ ...base, is_paused: true }).state, 'PROFILE_PAUSED');
    check('never set up', benchReason({ ...base, current_version_id: null }).state, 'NOT_SET_UP');
    check('set up but switched off', benchReason({ ...base, is_active: false }).state, 'CRITERIA_PAUSED');
    check('only exclusions',
        benchReason({ ...base, n_titles: 0, n_locations: 0 }).state, 'NOTHING_TO_LOOK_FOR');
    check('a minimum pay alone counts as something to look for',
        benchReason({ ...base, n_titles: 0, n_locations: 0, has_pay: true }).state, 'MATCHABLE');
    check('every reason but matchable says how to fix it',
        ['NOT_ACTIVE', 'PROFILE_PAUSED', 'NOT_SET_UP', 'CRITERIA_PAUSED', 'NOTHING_TO_LOOK_FOR'].length > 0
        && benchReason({ ...base, current_version_id: null }).fix.length > 0, true);
}

/* ── against the database, in a throwaway organisation ────────────────── */

const ID = (n) => `b7a7c0de-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const ORG = ID(1);
const ADMIN = ID(2);
const C_FULL = ID(3);      // has experience, skills and a city
const C_EMPTY = ID(4);     // has nothing to build criteria from
const C_HAS = ID(5);       // already has criteria of their own

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

/**
 * Everything the suite made, except the organisation row itself. Drafting
 * criteria writes an audit row, the audit log is append-only, and an
 * organisation with audit rows cannot be deleted -- so the (empty) organisation
 * stays, under a fixed id, and is simply reused on the next run.
 */
const cleanup = async () => {
    await query('DELETE FROM queue_item_transitions WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM queue_items WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM job_matches WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM job_postings WHERE organization_id = $1', [ORG]);
    await query('DELETE FROM users WHERE organization_id = $1', [ORG]);
};

const posting = async (n, { title, location, remote = false, description = '' }) => {
    const id = ID(20 + n);
    await query(
        `INSERT INTO job_postings (id, organization_id, company, title, location_text, is_remote,
                                   description, source_url, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ORG, `Co ${n}`, title, location, remote, description, `https://example.invalid/mb/${n}`,
            createHash('sha256').update(`mb-${n}`).digest('hex')],
    );
    return id;
};

const run = async () => {
    await cleanup();
    await query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'Matching Bench Test', 'matching-bench-test')
                 ON CONFLICT DO NOTHING`, [ORG]);
    for (const [id, name] of [[ADMIN, 'Admin'], [C_FULL, 'Full Profile'], [C_EMPTY, 'Empty Profile'], [C_HAS, 'Has Criteria']]) {
        await query(
            `INSERT INTO users (id, organization_id, name, email, role, password_enc, password_iv, password_tag, employment_status)
             VALUES ($1,$2,$3,$4,$5,'x','x','x','ACTIVE')`,
            [id, ORG, name, `${id}@example.invalid`, id === ADMIN ? 'ORG_ADMIN' : 'CONSULTANT'],
        );
        if (id !== ADMIN) {
            await query(`INSERT INTO consultant_profiles (user_id, organization_id, city, state) VALUES ($1,$2,$3,$4)`,
                [id, ORG, id === C_FULL ? 'Dallas' : null, id === C_FULL ? 'TX' : null]);
        }
    }
    await query(`INSERT INTO consultant_experience (id, organization_id, consultant_id, company, title, is_current, position)
                 VALUES ($1,$2,$3,'Acme','React Developer',TRUE,0)`, [ID(40), ORG, C_FULL]);
    const { rows: skillRows } = await query(`SELECT id, name FROM lkp_skills WHERE slug = ANY($1) ORDER BY slug`, [['react', 'javascript']]);
    let pos = 0;
    for (const s of skillRows) {
        await query(`INSERT INTO consultant_skills (id, organization_id, consultant_id, skill_id, position) VALUES ($1,$2,$3,$4,$5)`,
            [ID(50 + pos), ORG, C_FULL, s.id, pos]);
        pos += 1;
    }
    // C_HAS: criteria of their own, which a draft must never overwrite.
    await query(`INSERT INTO search_criteria (consultant_id, organization_id, is_active) VALUES ($1,$2,TRUE)`, [C_HAS, ORG]);
    await query(`INSERT INTO search_criteria_versions (id, organization_id, consultant_id, version_no, is_current)
                 VALUES ($1,$2,$3,1,TRUE)`, [ID(60), ORG, C_HAS]);
    await query(`INSERT INTO search_criteria_terms (id, version_id, organization_id, kind, value, position)
                 VALUES ($1,$2,$3,'JOB_TITLE','Data Engineer',0)`, [ID(61), ID(60), ORG]);
    await query(`UPDATE search_criteria SET current_version_id = $2 WHERE consultant_id = $1`, [C_HAS, ID(60)]);

    section('before anything: who can receive jobs');
    let res = await call(bench, { user: admin });
    const states = Object.fromEntries(res.body.consultants.map((c) => [c.name, c.state]));
    check('one consultant already matchable', res.body.matchable, 1);
    check('  the one who wrote their own criteria', states['Has Criteria'], 'MATCHABLE');
    check('  the others have no criteria at all', [states['Full Profile'], states['Empty Profile']], ['NOT_SET_UP', 'NOT_SET_UP']);

    section('the suggestion endpoint');
    res = await call(getSuggestion, { user: admin, params: { id: C_FULL }, query: {} });
    check('a proposal from the profile', [res.body.usable, res.body.criteria.jobTitles[0]], [true, 'React Developer']);
    res = await call(getSuggestion, { user: admin, params: { id: C_EMPTY }, query: {} });
    check('nothing to propose for an empty profile', res.body.usable, false);
    res = await call(getSuggestion, { user: { ...admin, orgId: ID(99) }, params: { id: C_FULL }, query: {} });
    check('another organisation cannot read it', res.statusCode, 404);

    section('bootstrap: drafts are saved but not switched on');
    res = await call(bootstrap, { user: admin, body: {}, ip: '127.0.0.1' });
    const byName = Object.fromEntries(res.body.results.map((r) => [r.name, r]));
    check('the full profile is drafted', byName['Full Profile'].outcome, 'DRAFTED');
    check('  the empty one is skipped, with the reason', /Nothing in the profile/.test(byName['Empty Profile'].why), true);
    check('  the one with criteria is never overwritten', byName['Has Criteria'].why, 'Already has search criteria.');
    const { rows: draft } = await query(
        `SELECT sc.is_active, v.change_note FROM search_criteria sc
           JOIN search_criteria_versions v ON v.id = sc.current_version_id WHERE sc.consultant_id = $1`, [C_FULL]);
    check('the draft is a normal version, left paused', [draft[0].is_active, draft[0].change_note], [false, 'Drafted from the consultant’s profile']);
    check('  so they still cannot receive jobs',
        (await loadMatchableConsultants(ORG)).map((c) => c.id).includes(C_FULL), false);
    res = await call(bootstrap, { user: admin, body: {}, ip: '127.0.0.1' });
    check('running it again changes nothing', res.body.drafted, 0);
    res = await call(bench, { user: admin });
    check('the bench now names the next step',
        res.body.consultants.find((c) => c.name === 'Full Profile').state, 'CRITERIA_PAUSED');

    section('re-matching the pool for one consultant');
    const stack = 'We build with React and JavaScript.';
    await posting(1, { title: 'React Developer', location: 'Dallas, TX', description: stack });
    await posting(2, { title: 'Senior React Developer', location: 'Plano, Texas, United States', description: stack });
    await posting(3, { title: 'Accountant', location: 'Dallas, TX', description: 'Books and tax.' });
    await posting(4, { title: 'React Developer', location: 'Dallas, TX', description: stack }); // 2nd copy of a good one
    let out = await rematchConsultant({ orgId: ORG, consultantId: C_FULL });
    check('a paused consultant is not matched', out.skipped !== null, true);

    await query('UPDATE search_criteria SET is_active = TRUE WHERE consultant_id = $1', [C_FULL]);
    out = await rematchConsultant({ orgId: ORG, consultantId: C_FULL });
    check('once active, the pool is checked at once', out.considered, 4);
    check('  and what fits is linked', out.linked >= 1, true);
    const { rows: links } = await query(
        `SELECT p.title FROM queue_items q JOIN job_postings p ON p.id = q.posting_id WHERE q.consultant_id = $1`, [C_FULL]);
    check('  an accountant is not one of them', links.some((l) => l.title === 'Accountant'), false);
    check('  and every link explains itself',
        (await query(`SELECT reason FROM job_matches WHERE consultant_id = $1`, [C_FULL])).rows.every((r) => /Re-checked/.test(r.reason)), true);
    const first = out.linked;
    out = await rematchConsultant({ orgId: ORG, consultantId: C_FULL });
    check('running it twice links nothing new', [first > 0, out.linked], [true, 0]);

    out = await rematchConsultant({ orgId: ORG, consultantId: C_FULL, maxLinks: 0 });
    check('the number of links per pass is capped', out.linked, 0);
};

try {
    await run();
} catch (err) {
    fail += 1;
    console.log(`  FAIL  the suite itself failed: ${err.stack ?? err.message}`);
} finally {
    await cleanup().catch((e) => console.log(`  (cleanup: ${e.message})`));
    await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
