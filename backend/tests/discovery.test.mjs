/**
 * Phase 5 — job discovery. Unit suite.
 *
 *   node tests/discovery.test.mjs
 *
 * Everything here is pure: fingerprinting, the Google Jobs adapter, and the
 * matcher. Nothing touches the network or the database.
 *
 * That is deliberate. The acquisition layer is now a paid API, so a suite that
 * called it would cost credits to run and would fail on the day the vendor had
 * an outage — neither of which is a regression in this codebase. The adapter is
 * tested against captured response shapes instead, which is the part that
 * actually breaks when a contract drifts.
 */
import { fingerprintPosting, normaliseTitle, normaliseCompany, normaliseLocation } from '../config/fingerprint.js';
import { evaluate, scoreMatch } from '../config/jobMatcher.js';
import {
    jobResultToPosting, resultsToPostings, detectSource, detectPortalType,
    parsePay, parsePostedAt, PRIORITY_SOURCES,
} from '../connectors/googleJobs.js';
import { __test as serpTest, providerConfig } from '../connectors/serpapi.js';
import {
    clampCycleHours, isDue, nextRunAfter, runsPerDay,
} from '../config/discoverySchedule.js';
import { checkTransition, countsAgainstCap } from '../config/queueStates.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── fingerprint / R-15 ───────────────────────────────────────────────── */

section('fingerprint — the same job seen twice');

const linkedinView = {
    company: 'Acme Technologies, Inc.',
    title: 'Senior React Developer (Remote) - Urgent Hiring',
    locationText: 'Remote',
    isRemote: true,
};
const builtinView = {
    company: 'Acme Technologies',
    title: 'Senior React Developer',
    locationText: 'Anywhere',
    isRemote: true,
};
check('legal suffix + decoration + remote synonym all collapse',
    fingerprintPosting(linkedinView) === fingerprintPosting(builtinView), true);

check('company suffix stripped', normaliseCompany('Globex Corp.'), 'globex');
check('hiring noise stripped', normaliseTitle('Java Developer - URGENT HIRING'), 'java developer');
check('remote synonyms unify', normaliseLocation('Work From Home'), 'remote');
check('city kept', normaliseLocation('Dallas, TX', false), 'dallas tx');

section('fingerprint — genuinely different jobs stay apart');
const senior = { company: 'Acme', title: 'Senior React Developer', locationText: 'Dallas', isRemote: false };
const junior = { company: 'Acme', title: 'React Developer', locationText: 'Dallas', isRemote: false };
const other = { company: 'Acme', title: 'Senior React Developer', locationText: 'Boston', isRemote: false };
check('seniority is not noise', fingerprintPosting(senior) !== fingerprintPosting(junior), true);
check('location is part of the key (R-15)', fingerprintPosting(senior) !== fingerprintPosting(other), true);

/* ── the Google Jobs adapter ──────────────────────────────────────────── */

section('adapter — a complete result');

/** A captured-shape SerpApi `jobs_results` entry. */
const result = {
    title: 'Senior React Developer',
    company_name: 'Globex',
    location: '   Dallas, TX   ',
    via: 'via LinkedIn',
    share_link: 'https://www.google.com/search?q=senior+react+developer',
    description: '<p>Build <b>things</b>. Ship <i>often</i>.</p>',
    job_id: 'eyJqb2JfdGl0bGUiOiJTZW5pb3IgUmVhY3QgRGV2ZWxvcGVyIn0=',
    extensions: ['3 days ago', 'Full-time', '$60–$75 an hour'],
    detected_extensions: {
        posted_at: '3 days ago',
        schedule_type: 'Contractor',
        salary: '$60–$75 an hour',
    },
    apply_options: [
        { title: 'Indeed', link: 'https://www.indeed.com/viewjob?jk=abc' },
        { title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/123456' },
    ],
    job_highlights: [
        { title: 'Qualifications', items: ['5+ years of React', 'TypeScript'] },
    ],
};

const NOW = new Date('2026-08-11T12:00:00Z');
const adapted = jobResultToPosting(result, { now: NOW });

check('company', adapted.posting.company, 'Globex');
check('title', adapted.posting.title, 'Senior React Developer');
check('location is trimmed', adapted.posting.locationText, 'Dallas, TX');
check('source read from `via`', adapted.source, 'LINKEDIN');
check('portal type read from the apply host', adapted.portalType, 'LINKEDIN');
check('work type mapped', adapted.posting.workType, 'CONTRACT');
check('pay unit', adapted.posting.payUnit, 'HOURLY');
check('pay range', [adapted.posting.payMin, adapted.posting.payMax], [60, 75]);
check('provider job id kept', adapted.posting.providerJobId, result.job_id);
check('posted_at resolved against `now`',
    adapted.posting.postedAt, new Date('2026-08-08T12:00:00Z').toISOString());

// The apply link matching the detected board wins over the first one listed —
// a LinkedIn posting should send a person to LinkedIn, not to Indeed.
check('apply URL prefers the detected board',
    adapted.posting.sourceUrl, 'https://www.linkedin.com/jobs/view/123456');

check('description is de-tagged and keeps highlights',
    adapted.posting.description,
    'Build things. Ship often.\n\nQualifications:\n• 5+ years of React\n• TypeScript');

section('adapter — attribution');

const via = (v, options = []) => detectSource({ via: v, apply_options: options, share_link: 'https://x/y' });

check('"via Built In" → BUILTIN', via('via Built In').source, 'BUILTIN');
check('"via BuiltIn Chicago" → BUILTIN', via('via BuiltIn Chicago').source, 'BUILTIN');
check('"via Linkedin Jobs" → LINKEDIN', via('via Linkedin Jobs').source, 'LINKEDIN');
check('"via Wellfound" → WELLFOUND', via('via Wellfound').source, 'WELLFOUND');
check('"via The Ladders" → THELADDERS', via('via The Ladders').source, 'THELADDERS');
check('"via CrunchBoard" → CRUNCHBOARD', via('via CrunchBoard').source, 'CRUNCHBOARD');
check('"via Indeed" → INDEED', via('via Indeed').source, 'INDEED');

// The whole point of the correction: an unrecognised board is still a real job.
check('an unknown board falls back to OTHER, never a drop',
    via('via Some Niche Board').source, 'OTHER');

// `via` is a display string; the apply host is the steadier signal.
check('an unrecognised `via` is rescued by the apply host',
    via('via Jobs Portal', [{ title: 'x', link: 'https://www.dice.com/job/1' }]).source, 'DICE');

check('the five named boards are the priority set', PRIORITY_SOURCES,
    ['LINKEDIN', 'WELLFOUND', 'BUILTIN', 'THELADDERS', 'CRUNCHBOARD']);

section('adapter — portal type is the ATS, not the board');

check('Greenhouse', detectPortalType('https://boards.greenhouse.io/acme/jobs/1'), 'GREENHOUSE');
check('Lever', detectPortalType('https://jobs.lever.co/acme/abc'), 'LEVER');
check('Workday', detectPortalType('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1'), 'WORKDAY');
check('Ashby', detectPortalType('https://jobs.ashbyhq.com/acme/1'), 'ASHBY');
// A host that is neither a board nor a known ATS is almost always the
// employer's own site, which is more useful to record than a shrug.
check('an unknown host reads as the company careers page',
    detectPortalType('https://careers.globex.com/apply/9'), 'COMPANY_SITE');
check('no URL at all is OTHER', detectPortalType(null), 'OTHER');

// A job listed on LinkedIn but applied for through Greenhouse is both, and the
// two fields must not collapse into one.
const split = jobResultToPosting({
    title: 'Platform Engineer',
    company_name: 'Initech',
    via: 'via LinkedIn',
    apply_options: [{ title: 'Greenhouse', link: 'https://boards.greenhouse.io/initech/jobs/7' }],
}, { now: NOW });
check('source and portal type are independent',
    [split.source, split.portalType], ['LINKEDIN', 'GREENHOUSE']);

section('adapter — what it refuses');

check('a result with no company is rejected',
    jobResultToPosting({ title: 'Orphan', share_link: 'https://x/y' }), null);
check('a result with no title is rejected',
    jobResultToPosting({ company_name: 'Globex', share_link: 'https://x/y' }), null);
check('a result nobody can open is rejected',
    jobResultToPosting({ company_name: 'Globex', title: 'Dev' }), null);
check('a bad entry does not lose the good ones in the same page',
    resultsToPostings([{ title: 'Orphan' }, result], { now: NOW }).length, 1);

section('adapter — remote detection');

check('work_from_home is authoritative', jobResultToPosting({
    company_name: 'X', title: 'Dev', share_link: 'https://x/y',
    detected_extensions: { work_from_home: true },
}).posting.isRemote, true);

// Location is part of the R-15 fingerprint; leaving it null would make every
// remote job at a company collide differently from the "Anywhere" ones.
check('a remote job with no location reads as "Anywhere"', jobResultToPosting({
    company_name: 'X', title: 'Dev', share_link: 'https://x/y',
    detected_extensions: { work_from_home: true },
}).posting.locationText, 'Anywhere');

check('"Remote" in the title is enough', jobResultToPosting({
    company_name: 'X', title: 'Dev (Remote)', location: 'United States', share_link: 'https://x/y',
}).posting.isRemote, true);

/* ── pay parsing ──────────────────────────────────────────────────────── */

section('pay — parsed strictly or not at all');

const pay = (s) => { const p = parsePay(s); return p ? [p.min, p.max, p.unit] : null; };

check('K range, annual', pay('$120K–$150K a year'), [120000, 150000, 'ANNUAL']);
check('hourly range', pay('$60–$75 an hour'), [60, 75, 'HOURLY']);
check('single figure fills both ends', pay('$95,000 a year'), [95000, 95000, 'ANNUAL']);
check('decimals survive', pay('$25.50 an hour'), [25.5, 25.5, 'HOURLY']);
check('no currency symbol is still parseable', pay('35–40 an hour'), [35, 40, 'HOURLY']);
check('"Up to" is a ceiling with no floor', pay('Up to $180K a year'), [null, 180000, 'ANNUAL']);
check('"From" is a floor with no ceiling', pay('From $100K a year'), [100000, null, 'ANNUAL']);

// The rule that matters: a number without a period is worse than nothing,
// because the minimum-pay filter would compare it against the wrong floor.
check('an amount with no period is discarded, not guessed', pay('$150,000'), null);
check('prose with no number is discarded', pay('Competitive salary'), null);
check('a monthly figure is discarded — the schema has no unit for it',
    pay('$8,000 a month'), null);
check('empty input', pay(null), null);

// "401k" in trailing prose used to parse as $401,000 and become the maximum.
check('trailing benefits prose cannot inflate the range',
    pay('$120,000 - $150,000 a year plus 401k matching'), [120000, 150000, 'ANNUAL']);

check('currency is recorded', parsePay('£70K a year').currency, 'GBP');
check('C$ is not mistaken for USD', parsePay('C$90K a year').currency, 'CAD');

check('salary is found in `extensions` when detected_extensions has none',
    jobResultToPosting({
        company_name: 'X', title: 'Dev', share_link: 'https://x/y',
        extensions: ['2 days ago', 'Full-time', '$110K–$130K a year'],
    }).posting.payMin, 110000);

/* ── posted date ──────────────────────────────────────────────────────── */

section('posted date');

const days = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

check('"3 days ago"', parsePostedAt('3 days ago', NOW).toISOString(), days(3));
check('"22 hours ago"', parsePostedAt('22 hours ago', NOW).toISOString(),
    new Date(NOW.getTime() - 22 * 3_600_000).toISOString());
check('"30+ days ago" floors at 30', parsePostedAt('30+ days ago', NOW).toISOString(), days(30));
check('"an hour ago"', parsePostedAt('an hour ago', NOW).toISOString(),
    new Date(NOW.getTime() - 3_600_000).toISOString());
check('"Just posted" is now', parsePostedAt('Just posted', NOW).toISOString(), NOW.toISOString());
check('unparseable is null, not today', parsePostedAt('sometime', NOW), null);
check('absent is null', parsePostedAt(null, NOW), null);

/* ── the provider client ──────────────────────────────────────────────── */

section('provider — the API key must never be stored');

const withKey = 'https://serpapi.com/search.json?engine=google_jobs&q=dev&api_key=SECRET123';
check('api_key is redacted', serpTest.redactUrl(withKey).includes('SECRET123'), false);
check('  and replaced with a marker', serpTest.redactUrl(withKey).includes('api_key=***'), true);
check('  while the rest of the URL survives',
    serpTest.redactUrl(withKey).includes('engine=google_jobs'), true);
check('a malformed URL is still redacted',
    serpTest.redactUrl('not a url?api_key=SECRET123').includes('SECRET123'), false);

section('provider — request building');

process.env.SERPAPI_KEY = 'TESTKEY';
const cfg = providerConfig();
const url = new URL(serpTest.buildUrl({ q: 'react developer', location: 'Dallas' }, cfg));
check('engine is google_jobs', url.searchParams.get('engine'), 'google_jobs');
check('query passed through', url.searchParams.get('q'), 'react developer');
check('location passed through', url.searchParams.get('location'), 'Dallas');
check('key attached', url.searchParams.get('api_key'), 'TESTKEY');
// Google discontinued offset pagination; a `start` param would be silently ignored.
check('no offset pagination', url.searchParams.has('start'), false);
check('page 2 carries the token',
    new URL(serpTest.buildUrl({ q: 'x', nextPageToken: 'TOK' }, cfg)).searchParams.get('next_page_token'),
    'TOK');

section('provider — recency filter');

// `chips` is DEPRECATED by Google and now ignored in silence — a request that
// sends it looks configured and returns unfiltered results. The live mechanism
// is `uds`, so `chips` must never appear on a request again.
check('chips is never sent', url.searchParams.has('chips'), false);

const filtered = new URL(serpTest.buildUrl(
    { q: 'react developer', uds: 'UDS_HANDLE', qOverride: 'react developer in the last 3 days' },
    cfg,
));
check('uds is sent when we hold a handle', filtered.searchParams.get('uds'), 'UDS_HANDLE');
// Google rewrites the query alongside the filter; the filter link sends both.
check('  and the rewritten query goes with it',
    filtered.searchParams.get('q'), 'react developer in the last 3 days');
check('without a handle the plain query is sent',
    url.searchParams.get('q'), 'react developer');

section('provider — harvesting the filter handle');

// The handle arrives free on any ordinary response, which is what makes
// filtering cost nothing: the first call returns jobs AND the handle.
const nested = {
    filters: [{
        name: 'Date posted',
        options: [
            { name: 'Yesterday', parameters: { uds: 'U_DAY', q: 'dev since yesterday' } },
            { name: 'Last 3 days', parameters: { uds: 'U_3D', q: 'dev in the last 3 days' } },
        ],
    }],
};
check('handle read from the nested shape',
    serpTest.extractDateFilter(nested, 'day'), { uds: 'U_DAY', q: 'dev since yesterday' });
check('  and the right window is picked',
    serpTest.extractDateFilter(nested, '3days').uds, 'U_3D');

// SerpApi has emitted both shapes. Reading only one would look identical to
// "this filter is unavailable" against the other.
const flat = {
    filters: [{ name: 'Date posted', options: [{ name: 'Yesterday', uds: 'F_DAY', q: 'x' }] }],
};
check('handle read from the flat shape', serpTest.extractDateFilter(flat, 'day').uds, 'F_DAY');

check('no filters array is null, not a crash', serpTest.extractDateFilter({}, 'day'), null);
check('a window Google does not offer is null',
    serpTest.extractDateFilter(nested, 'week'), null);
check('an unknown window name is null', serpTest.extractDateFilter(nested, '4hours'), null);

section('schedule — per-organisation intervals');

const CLOCK = new Date('2026-08-12T12:00:00Z');
const hoursAgo = (h) => new Date(CLOCK.getTime() - h * 3_600_000);

check('an interval below the minimum is clamped', clampCycleHours(0), 1);
check('an interval above the maximum is clamped', clampCycleHours(99), 24);
check('a valid interval is kept', clampCycleHours(4), 4);
check('nonsense falls back to the default', clampCycleHours('abc'), 6);

// An organisation that has never run automatically is due at once — which is
// what an admin expects the moment they switch the cycle on.
check('never run means due now', isDue(null, 4, CLOCK), true);
check('an hour into a 4-hour cycle is not due', isDue(hoursAgo(1), 4, CLOCK), false);
check('four hours into a 4-hour cycle is due', isDue(hoursAgo(4), 4, CLOCK), true);
// The tick window counts as slack, otherwise a 1-hour cycle drifts to 1h15m.
check('just inside the tick window still counts as due',
    isDue(hoursAgo(3.9), 4, CLOCK), true);
check('a 24-hour cycle is not due after 12 hours', isDue(hoursAgo(12), 24, CLOCK), false);

check('next run is measured from the last run',
    nextRunAfter(hoursAgo(1), 4, CLOCK).toISOString(),
    new Date('2026-08-12T15:00:00Z').toISOString());
check('an overdue cycle is due immediately, not in the past',
    nextRunAfter(hoursAgo(9), 4, CLOCK).toISOString(), CLOCK.toISOString());

check('runs per day at 6 hours', runsPerDay(6), 4);
check('runs per day at 1 hour', runsPerDay(1), 24);

/* ── the queue state machine ──────────────────────────────────────────── */

section('queue states — the pipeline');

const move = (from, to, opts) => {
    const r = checkTransition(from, to, opts);
    return r.ok ? 'ok' : r.status;
};

check('QUEUED → PREPARING', move('QUEUED', 'PREPARING'), 'ok');
check('PREPARING → READY', move('PREPARING', 'READY'), 'ok');
check('READY → FILLING', move('READY', 'FILLING'), 'ok');
check('FILLING → AWAITING_REVIEW', move('FILLING', 'AWAITING_REVIEW'), 'ok');
check('AWAITING_REVIEW → SUBMITTED', move('AWAITING_REVIEW', 'SUBMITTED'), 'ok');

section('queue states — what is refused');

// The whole reason the machine exists: a status column with no rules is how
// SUBMITTED ends up preceding FILLING in a history nobody can explain.
check('QUEUED → SUBMITTED is refused', move('QUEUED', 'SUBMITTED'), 409);
check('READY → AWAITING_REVIEW skips filling', move('READY', 'AWAITING_REVIEW'), 409);
check('nothing leaves SUBMITTED', move('SUBMITTED', 'SKIPPED', { reason: 'x' }), 409);
// An application that reached an employer cannot be un-sent.
check('  not even to CANCELLED', move('SUBMITTED', 'CANCELLED', { reason: 'x' }), 409);
check('nothing leaves CANCELLED', move('CANCELLED', 'QUEUED'), 409);
check('a state cannot move to itself', move('READY', 'READY'), 409);
check('an unknown state is rejected', move('READY', 'NONSENSE'), 400);

section('queue states — reasons and recovery');

check('skipping without a reason is refused', move('READY', 'SKIPPED'), 422);
check('  and accepted with one', move('READY', 'SKIPPED', { reason: 'not a fit' }), 'ok');
check('cancelling needs a reason too', move('READY', 'CANCELLED'), 422);
check('a skipped item can be re-queued', move('SKIPPED', 'QUEUED'), 'ok');

// Every one of these is a real recovery path, not a theoretical edge.
check('FILLING → READY (crashed app, lease expired)', move('FILLING', 'READY'), 'ok');
check('AWAITING_REVIEW → READY (nobody reviewed it)', move('AWAITING_REVIEW', 'READY'), 'ok');
check('PARKED_UNKNOWN → READY (the answer was approved)', move('PARKED_UNKNOWN', 'READY'), 'ok');
check('PREPARING → QUEUED (preparation failed, retry)', move('PREPARING', 'QUEUED'), 'ok');
// The HUMAN lane: nothing filled the form, the consultant applied themselves.
check('READY → SUBMITTED (human lane)', move('READY', 'SUBMITTED'), 'ok');

section('queue states — which states hold a daily cap slot');

// A slot is spent on reaching READY, never at queue creation. Counting at
// creation would let a failed preparation burn a consultant's whole day.
check('QUEUED does not hold a slot', countsAgainstCap('QUEUED'), false);
check('PREPARING does not hold a slot', countsAgainstCap('PREPARING'), false);
check('READY holds a slot', countsAgainstCap('READY'), true);
check('FILLING holds a slot', countsAgainstCap('FILLING'), true);
check('AWAITING_REVIEW holds a slot', countsAgainstCap('AWAITING_REVIEW'), true);
check('SUBMITTED holds a slot — it was genuinely spent', countsAgainstCap('SUBMITTED'), true);
check('SKIPPED releases the slot', countsAgainstCap('SKIPPED'), false);
check('CANCELLED releases the slot', countsAgainstCap('CANCELLED'), false);

/* ── matching ─────────────────────────────────────────────────────────── */

section('matching — which consultant is this job useful for');

const criteria = {
    jobTitles: ['React Developer', 'Frontend Engineer'],
    keywordsInclude: ['React', 'TypeScript'],
    keywordsExclude: ['Unpaid', 'Internship'],
    excludedCompanies: ['Acme Staffing'],
    locations: [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE' }],
    workTypeNames: ['CONTRACT', 'W2'],
    minPay: { amount: 55, unit: 'HOURLY' },
};
const good = {
    company: 'Globex', title: 'React Developer',
    description: 'React and TypeScript, modern stack',
    locationText: 'Dallas, TX', isRemote: false,
    payMin: 65, payMax: 75, payUnit: 'HOURLY',
};

const verdict = evaluate(good, criteria, { workTypeName: 'CONTRACT' });
check('a good job matches', verdict.matched, true);
check('  and reaches the scoring stage', verdict.stage, 'score');
console.log(`    score ${verdict.score} — ${verdict.reason}`);

check('excluded company is a HARD no',
    evaluate({ ...good, company: 'Acme Staffing LLC' }, criteria).stage, 'hard');
check('excluded keyword is a HARD no',
    evaluate({ ...good, description: 'Unpaid internship' }, criteria).stage, 'hard');
check('unrelated title stops at the cheap pre-filter (R-16)',
    evaluate({ ...good, title: 'Sous Chef' }, criteria).stage, 'prefilter');
check('wrong city stops at the pre-filter',
    evaluate({ ...good, locationText: 'Boston, MA' }, criteria).stage, 'prefilter');

check('remote job matches a remote criterion',
    evaluate({ ...good, locationText: 'Remote', isRemote: true },
        { ...criteria, locations: [{ city: null, state: null, workMode: 'REMOTE' }] }).matched, true);

const belowFloor = evaluate({ ...good, payMin: 20, payMax: 25 }, criteria, { workTypeName: 'CONTRACT' });
check('pay below the floor scores lower', belowFloor.score < verdict.score, true);

const mismatchedUnit = evaluate(
    { ...good, payMin: 120000, payMax: 130000, payUnit: 'ANNUAL' }, criteria, { workTypeName: 'CONTRACT' },
);
check('annual pay is NOT compared against an hourly floor',
    /below/.test(mismatchedUnit.reason), false);

check('wrong work type is penalised but not fatal',
    evaluate(good, criteria, { workTypeName: 'PART_TIME' }).score < verdict.score, true);

check('priority order rewards the first-choice title',
    scoreMatch({ ...good, title: 'React Developer' }, criteria).score
    >= scoreMatch({ ...good, title: 'Frontend Engineer' }, criteria).score, true);

check('empty criteria do not match everything',
    evaluate(good, {
        jobTitles: [], keywordsInclude: [], keywordsExclude: [],
        excludedCompanies: [], locations: [], workTypeNames: [], minPay: null,
    }).matched, false);

/* ── end to end, without the network ──────────────────────────────────── */

section('a provider result reaches the matcher intact');

const endToEnd = jobResultToPosting({
    title: 'React Developer',
    company_name: 'Globex',
    location: 'Dallas, TX',
    via: 'via Built In',
    description: 'Working in React and TypeScript on a modern stack.',
    detected_extensions: { schedule_type: 'Contractor', salary: '$65–$80 an hour' },
    apply_options: [{ title: 'Built In', link: 'https://builtin.com/job/react-developer/1' }],
}, { now: CLOCK });

check('adapted', endToEnd !== null, true);
check('  matches the same criteria a scraped posting did',
    evaluate(endToEnd.posting, criteria, { workTypeName: endToEnd.posting.workType }).matched, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
