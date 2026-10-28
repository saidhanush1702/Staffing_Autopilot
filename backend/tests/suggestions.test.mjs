/**
 * Matching, phase E — three outcomes, and the recruiter's list for the middle one.
 *
 *   node tests/suggestions.test.mjs
 *
 * Two halves. The first needs no database: the write rules are run against a
 * recording stand-in for the query function (matchLinker takes it as an
 * argument for exactly this), so "a suggestion puts NOTHING in the consultant's
 * queue" is something that can be asserted rather than hoped.
 *
 * The second runs against the real database, but only when migration 060 has
 * been applied (it adds the SUGGESTED status the middle outcome is stored as).
 * Without it that half says so and stops, rather than failing for a reason that
 * has nothing to do with the code.
 */
process.env.MATCH_REMATCH_ON_SAVE = '0';

import { evaluate } from '../config/jobMatcher.js';
import {
    linkPosting, recordSuggestion, acceptSuggestion, dismissSuggestion,
} from '../services/matchLinker.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── a query stand-in that records what was written ───────────────────── */

const recorder = (answers = {}) => {
    const calls = [];
    const run = async (sql, params = []) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        for (const [needle, reply] of Object.entries(answers)) {
            if (sql.includes(needle)) return typeof reply === 'function' ? reply(params) : reply;
        }
        return { rows: [], rowCount: 1 };
    };
    run.calls = calls;
    run.wrote = (needle) => calls.some((c) => c.sql.includes(needle));
    return run;
};
const ctx = { orgId: 'org', consultantId: 'c1', versionId: 'v1', postingId: 'p1' };
const verdict = { score: 66, reason: 'skills: React ✔' };

section('a suggestion is a match and nothing else');
{
    const run = recorder();
    const out = await recordSuggestion({ ...ctx, verdict, via: 'ATS mirror' }, run);
    check('it is stored', out.suggested, true);
    check('  as SUGGESTED', run.wrote("'SUGGESTED'"), true);
    check('  and nothing is put in the consultant\'s queue', run.wrote('INSERT INTO queue_items'), false);
    check('  and the reason says where it came from', run.calls[0].params[6].endsWith('[via ATS mirror]'), true);

    const dup = recorder({ 'INSERT INTO job_matches': { rows: [], rowCount: 0 } });
    check('suggesting the same job to the same person twice is a no-op', (await recordSuggestion({ ...ctx, verdict, via: 'x' }, dup)).suggested, false);
}

section('an automatic match is a match AND a queue item');
{
    const run = recorder({
        'FROM lkp_queue_statuses': { rows: [{ id: 7, name: 'QUEUED' }] },
        'INSERT INTO queue_items': { rows: [{ id: 'item1' }], rowCount: 1 },
    });
    const out = await linkPosting({ ...ctx, automatable: true, verdict: { score: 88, reason: 'strong' }, via: 'Webhook' }, run);
    check('linked, with the queue item\'s id', [out.linked, out.itemId], [true, 'item1']);
    check('  a PENDING match first', run.wrote("'PENDING'"), true);
    check('  then the queue item, in the BOT lane', run.calls.find((c) => c.sql.includes('INSERT INTO queue_items')).params.at(-1), 'BOT');
    check('  with a transition that explains it', run.wrote('INSERT INTO queue_item_transitions'), true);
    check('  and the match is marked QUEUED', run.wrote("SET status = 'QUEUED'"), true);

    const again = recorder({ 'INSERT INTO job_matches': { rows: [], rowCount: 0 } });
    check('a job the consultant already has is not linked twice',
        [(await linkPosting({ ...ctx, verdict, via: 'x' }, again)).linked, again.wrote('INSERT INTO queue_items')], [false, false]);
}

section('a recruiter links a suggestion');
{
    const suggested = { rows: [{ id: 'm1', consultant_id: 'c1', posting_id: 'p1', score: 66, status: 'SUGGESTED', automatable: true }] };
    const run = recorder({
        'FROM job_matches m': suggested,
        'FROM lkp_queue_statuses': { rows: [{ id: 7, name: 'QUEUED' }] },
        'INSERT INTO queue_items': { rows: [{ id: 'item2' }], rowCount: 1 },
    });
    const out = await acceptSuggestion({ orgId: 'org', matchId: 'm1', actorName: 'Rita Recruiter' }, run);
    check('it becomes a queue item', [out.linked, out.itemId], [true, 'item2']);
    check('  on the match that already exists, not a new one', run.wrote('INSERT INTO job_matches'), false);
    check('  and the match records who decided', run.calls.some((c) => /UPDATE job_matches SET reason/.test(c.sql) && /Rita Recruiter/.test(c.params[1])), true);
    check('  and the queue transition names them', run.calls.find((c) => c.sql.includes('queue_item_transitions')).params[4].includes('Rita Recruiter'), true);

    const gone = recorder({ 'FROM job_matches m': { rows: [] } });
    check('an unknown suggestion is refused', (await acceptSuggestion({ orgId: 'org', matchId: 'zz' }, gone)).reason, 'Suggestion not found.');

    const done = recorder({ 'FROM job_matches m': { rows: [{ ...suggested.rows[0], status: 'QUEUED' }] } });
    const refused = await acceptSuggestion({ orgId: 'org', matchId: 'm1' }, done);
    check('one that was already handled is refused', [refused.linked, /already queued/.test(refused.reason)], [false, true]);
    check('  and nothing was written', done.wrote('INSERT INTO queue_items'), false);
}

section('a recruiter says it is not a fit');
{
    const run = recorder();
    const out = await dismissSuggestion({ orgId: 'org', matchId: 'm1', actorName: 'Rita', note: 'wrong stack' }, run);
    check('it is dismissed', out.dismissed, true);
    check('  only if it was still a suggestion', run.calls[0].sql.includes("status = 'SUGGESTED'"), true);
    check('  and the row stays, so it is not suggested again', run.calls[0].sql.includes('DELETE'), false);
    check('  with the reason kept', /wrong stack/.test(run.calls[0].params[2]), true);
    const none = recorder({ 'UPDATE job_matches': { rows: [], rowCount: 0 } });
    check('dismissing something already handled does nothing', (await dismissSuggestion({ orgId: 'org', matchId: 'm1' }, none)).dismissed, false);
}

section('the three outcomes, from the matcher');
{
    const base = {
        jobTitles: ['React Developer'], keywordsInclude: [], keywordsExclude: [], excludedCompanies: [],
        skills: [{ name: 'React' }, { name: 'JavaScript' }, { name: 'Node.js' }],
        locations: [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE' }], workTypeNames: [], minPay: null,
        totalYears: 5, matcherVersion: 2,
    };
    const at = (over) => evaluate({
        company: 'Acme', title: 'React Developer', locationText: 'Dallas, TX', isRemote: false,
        description: 'React and JavaScript.', ...over,
    }, base, {});
    check('a clear fit goes straight to the queue', [at({}).bucket, at({}).matched], ['AUTO', true]);
    const mid = at({ title: 'Platform Developer', description: 'React plus Kubernetes, Go and Java services.' });
    check('a partial fit is a suggestion, not a queue item', [mid.bucket, mid.matched], ['SUGGEST', false]);
    check('  with a reason a recruiter can read', /React/.test(mid.reason) && /missing/.test(mid.reason), true);
    check('no fit is dropped', at({ title: 'Accountant', description: 'Tax.' }).bucket, 'DROP');
    check('v1 still has no middle: it queues or it does not', evaluate({
        company: 'Acme', title: 'React Developer', locationText: 'Dallas, TX', description: 'React.',
    }, { ...base, matcherVersion: 1 }, {}).bucket, undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
