/**
 * Matching, phase D — deal-breakers: work authorization, engagement type, pay.
 *
 *   node tests/eligibility.test.mjs
 *
 * Pure. Each case is wording lifted from the kind of posting a staffing desk
 * reads all day, including the wording that LOOKS like a restriction and is not.
 */
import { requirementsOf, eligibility, statusClass } from '../config/eligibility.js';
import { evaluateV2 } from '../config/jobMatcherV2.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const post = (description, extra = {}) => ({ title: 'React Developer', description, ...extra });
const need = (d) => requirementsOf(post(d));

section('what a posting asks for');
check('US citizens only', need('US Citizens only.').citizenship, 'CITIZEN_ONLY');
check('"must be a U.S. citizen"', need('Applicants must be a U.S. citizen.').citizenship, 'CITIZEN_ONLY');
check('citizen or green card', need('Open to USC or GC holders.').citizenship, 'CITIZEN_OR_GC');
check('  written GC/USC', need('GC/USC only').citizenship, 'CITIZEN_OR_GC');
check('no sponsorship', need('We are unable to provide visa sponsorship.').citizenship, 'NO_SPONSORSHIP');
check('  another wording', need('Sponsorship is not available for this role.').citizenship, 'NO_SPONSORSHIP');
check('a clearance', need('Active TS/SCI clearance required.').clearance, true);
check('W2 only', need('W2 only, no C2C.').noC2C, true);
check('C2C only', need('Corp-to-corp only').c2cOnly, true);
check('no agencies', need('No third party vendors please.').noThirdParty, true);
check('an ordinary posting asks for nothing', Object.values(need('We build things with React.')).filter(Boolean), []);

section('wording that looks like a restriction and is not');
check('"we sponsor" opens it up', need('No restrictions. We sponsor H-1B.').citizenship, null);
check('"H1B ok" overrides a citizenship line', need('US citizens preferred. H1B ok, OPT ok.').citizenship, null);
check('"all visa types"', need('Open to all visa types.').openToAll, true);
check('"citizen" in another sense', need('Be a good corporate citizen.').citizenship, null);
check('"no sponsorship" does not fire on "no sponsorship fees"... only real phrasing counts', need('Candidates pay no fees.').citizenship, null);

section('who the consultant is');
check('statuses become classes', ['US Citizen', 'Green Card', 'H1-B', 'OPT', 'TN', 'Other', null].map(statusClass),
    ['CITIZEN', 'GC', 'VISA', 'VISA', 'VISA', 'VISA', null]);

section('authorization: a plain no, a "look at this", and not blocking on a guess');
{
    const e = (desc, workAuth, extra = {}) => eligibility(post(desc), { workAuth, ...extra });
    check('citizens only, consultant on H-1B → dropped', e('US citizens only', 'H1-B').verdict, 'DROP');
    check('  and the reason names both', /US citizen.*H1-B/.test(e('US citizens only', 'H1-B').reasons[0]), true);
    check('citizens only, consultant is a citizen → fine', e('US citizens only', 'US Citizen').verdict, 'OK');
    check('citizen or GC, consultant on OPT → dropped', e('USC or GC', 'OPT').verdict, 'DROP');
    check('citizen or GC, green card holder → fine', e('USC or GC', 'Green Card').verdict, 'OK');
    check('no sponsorship, H-1B → a person looks (a transfer is sometimes fine)', e('No sponsorship', 'H1-B').verdict, 'CAP');
    check('no sponsorship, citizen → fine', e('No sponsorship', 'US Citizen').verdict, 'OK');
    check('a restriction and an unrecorded status → never dropped on a guess', e('US citizens only', null).verdict, 'CAP');
    check('  and it says it could not check', /not recorded/.test(e('US citizens only', null).reasons[0]), true);
    check('a clearance and a non-citizen → dropped', e('Secret clearance needed', 'H1-B').verdict, 'DROP');
    check('a clearance and a citizen → confirm it is active', e('Secret clearance needed', 'US Citizen').verdict, 'CAP');
}

section('how they are engaged');
{
    const e = (desc, types) => eligibility(post(desc), { workAuth: 'US Citizen', workTypeNames: types });
    check('W2 only, consultant takes C2C only → dropped', e('W2 only', ['C2C']).verdict, 'DROP');
    check('W2 only, consultant takes C2C and W2 → fine', e('W2 only', ['C2C', 'W2']).verdict, 'OK');
    check('W2 only, consultant takes full-time → fine', e('W2 only', ['FULL_TIME']).verdict, 'OK');
    check('C2C only, consultant takes W2 only → dropped', e('C2C only', ['W2']).verdict, 'DROP');
    check('C2C only, consultant takes C2C → fine', e('C2C only', ['C2C']).verdict, 'OK');
    check('a consultant who stated nothing is not blocked', e('W2 only', []).verdict, 'OK');
    check('no third parties → a person looks', e('No third party agencies', ['W2']).verdict, 'CAP');
}

section('pay');
{
    const e = (extra, floor) => eligibility(post('', extra), { workAuth: 'US Citizen', minPay: floor });
    const floor = { amount: 60, unit: 'HOURLY' };
    check('stated pay below the floor → dropped', e({ payMax: 45, payUnit: 'HOURLY' }, floor).verdict, 'DROP');
    check('a range that reaches the floor → fine', e({ payMin: 50, payMax: 65, payUnit: 'HOURLY' }, floor).verdict, 'OK');
    check('a different unit is never compared', e({ payMax: 90000, payUnit: 'ANNUAL' }, floor).verdict, 'OK');
    check('no pay stated → not held against anyone', e({}, floor).verdict, 'OK');
}

section('through the whole matcher');
{
    const consultant = {
        jobTitles: ['React Developer'], keywordsInclude: [], keywordsExclude: [], excludedCompanies: [],
        skills: [{ name: 'React' }, { name: 'JavaScript' }],
        locations: [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE' }], workTypeNames: ['C2C'],
        minPay: { amount: 60, unit: 'HOURLY' }, totalYears: 5, workAuth: 'H1-B',
    };
    const job = (description, extra = {}) => ({
        company: 'Acme', title: 'React Developer', locationText: 'Dallas, TX', isRemote: false,
        description: `React and JavaScript. ${description}`, ...extra,
    });
    const run = (j, c = consultant) => evaluateV2(j, c, { workTypeName: 'CONTRACT' });

    check('a good job with no restrictions is queued', run(job('')).bucket, 'AUTO');
    check('the same job, citizens only: dropped before scoring', [run(job('US citizens only.')).bucket, run(job('US citizens only.')).stage], ['DROP', 'hard']);
    check('  and the reason is the restriction', /requires a US citizen/.test(run(job('US citizens only.')).reason), true);
    check('no sponsorship: a recruiter is asked instead of it being queued', run(job('No sponsorship.')).bucket, 'SUGGEST');
    check('  with the concern spelled out', /check: job offers no sponsorship; consultant is H1-B/.test(run(job('No sponsorship.')).reason), true);
    check('pay below the floor is dropped', run(job('', { payMax: 40, payUnit: 'HOURLY' })).bucket, 'DROP');
    check('W2 only, for a C2C-only consultant: dropped', run(job('W2 only.')).bucket, 'DROP');
    check('the same job for a US citizen is queued', run(job('No sponsorship.'), { ...consultant, workAuth: 'US Citizen' }).bucket, 'AUTO');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
