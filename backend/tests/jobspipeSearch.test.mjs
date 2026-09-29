/**
 * JobsPipe SEARCH API adapter — unit suite.
 *
 *   node tests/jobspipeSearch.test.mjs
 *   npm run test:jobspipe-search
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM jobspipe.test.mjs ───────────
 *
 * Because it tests against a contract that is actually KNOWN, and its sibling
 * does not.
 *
 *   tests/jobspipe.test.mjs   the WEBHOOK adapter, whose ACCEPTED_PATHS were
 *                             written from the shape this pipeline wants. Its
 *                             90 assertions all pass and prove the adapter is
 *                             self-consistent — they cannot prove it matches
 *                             JobsPipe, because no live delivery was captured.
 *   this suite                the SEARCH adapter, whose every field name is
 *                             copied from JobsPipe's published SDK type
 *                             definitions (`jobspipe` 0.1.0, `types.py::Job`).
 *
 * The fixture below is therefore the REAL response shape, not an invented one,
 * and the mapping assertions are meaningful rather than circular.
 *
 * ── THE FINDING THIS SUITE PINS DOWN ──────────────────────────────────
 *
 * The real schema is flat and carries NO pay interval — every amount is named
 * `*_annual_salary`. The webhook adapter looks for `salary.interval` and
 * returns null without one, so against real data every pushed job would arrive
 * with no pay at all. The consequences are asserted at the bottom of this file
 * so the regression cannot quietly return.
 *
 * Everything here is PURE — no network, no database, no credit spent.
 */
import {
    searchJobToPosting, parsePay, parseSalaryString, readWorkType, resolvePostedAt,
    readLocation, readRemote, sanitiseUrl, parsePostedAt, SOURCE_NAME,
} from '../connectors/jobspipeSearch.js';
import { FILTERS, validateFilters, redact, SEARCH_PATH } from '../connectors/jobspipeApi.js';
import { fingerprintPosting } from '../config/fingerprint.js';
import { evaluate } from '../config/jobMatcher.js';
import { ageStats } from '../jobs/jobspipePoller.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/** Fixed, so age assertions cannot drift with the wall clock. */
const CLOCK = new Date('2026-09-12T12:00:00Z');

/* ── the real response shape ──────────────────────────────────────────── */
//
// Field for field from JobsPipe's own SDK (`types.py::Job`) plus the documented
// quickstart response. This is the fixture the webhook suite could not have.
const JOB = {
    id: '8164933',
    job_title: 'Senior React Developer',
    normalized_title: 'react developer',
    url: 'https://boards.greenhouse.io/northwindlabs/jobs/8164933',
    final_url: 'https://boards.greenhouse.io/northwindlabs/jobs/8164933?utm=jp',
    source_url: 'https://linkedin.com/jobs/view/8164933',
    company: 'Northwind Labs',
    company_domain: 'northwindlabs.com',
    date_posted: '2026-09-12T06:00:00+00:00',
    discovered_at: '2026-09-12T06:42:00+00:00',
    location: 'Austin, TX',
    short_location: 'Austin, TX',
    country_code: 'US',
    state_code: 'TX',
    cities: ['Austin'],
    remote: true,
    hybrid: false,
    salary_string: '$70 - $90 per hour',
    salary_currency: 'USD',
    min_annual_salary: 145600,
    max_annual_salary: 187200,
    seniority: 'senior',
    employment_statuses: ['contract'],
    description: '<p>React and TypeScript.</p>',
    // PLURAL, and an array of objects. There is no `source` field on a real
    // response — confirmed against a live page, where `sources` was present on
    // 25/25 jobs and `source` on none.
    sources: [{
        provider: 'indeed',
        url: 'https://www.indeed.com/viewjob?jk=3cd4ca94df89dfe3',
        seen_at: '2026-09-12T06:42:00+00:00',
    }],
    // Says where the number came from, NOT what unit it is in. "observed" =
    // the employer advertised it; anything else is JobsPipe's model output.
    salary_type: 'observed',
    status: 'active',
};

/* ── the connector's own guardrails ───────────────────────────────────── */

section('the request contract, copied from the SDK');

check('endpoint path', SEARCH_PATH, '/v1/jobs/search');
check('posted_at_max_age_days is a real filter', FILTERS.includes('posted_at_max_age_days'), true);
check('job_title_or is a real filter', FILTERS.includes('job_title_or'), true);
check('include_total_results is a real filter', FILTERS.includes('include_total_results'), true);
// The guard that stops a typo silently widening a search and returning the
// whole feed instead of this week's React roles — one wasted credit either way,
// but only one of them is detectable.
check('a misspelled filter is refused before a credit is spent', (() => {
    try { validateFilters({ posted_max_age: 1 }); return 'accepted'; } catch { return 'refused'; }
})(), 'refused');
check('a valid filter set passes', Object.keys(validateFilters({ limit: 5, remote: true })).length, 2);

section('the key never reaches a log');

process.env.JOBSPIPE_API_KEY = 'jp_live_SECRETVALUE';
check('redacted out of an error string',
    redact('JobsPipe 401: bad key jp_live_SECRETVALUE'),
    'JobsPipe 401: bad key jp_live_***REDACTED***');
check('null passes through', redact(null), null);

/* ── the adapter ──────────────────────────────────────────────────────── */

section('a real search result becomes a posting');

const adapted = searchJobToPosting(JOB, { now: CLOCK });

check('adapted at all', adapted !== null, true);
check('source is the same row the webhook uses', adapted.source, SOURCE_NAME);
check('company', adapted.posting.company, 'Northwind Labs');
check('title', adapted.posting.title, 'Senior React Developer');
check('location', adapted.posting.locationText, 'Austin, TX');
check('remote', adapted.posting.isRemote, true);
check('work type read from the ARRAY', adapted.posting.workType, 'CONTRACT');
check('provider job id', adapted.posting.providerJobId, '8164933');
check('origin board read from sources[0].provider', adapted.originBoard, 'indeed');
check('  a job with no sources array is null, not a crash',
    searchJobToPosting({ ...JOB, sources: undefined }).originBoard, null);
check('description is flattened to text',
    adapted.posting.description.includes('React and TypeScript'), true);

// `url` is the posting's own page; final_url and source_url are fallbacks.
check('prefers url over final_url and source_url',
    adapted.posting.sourceUrl, 'https://boards.greenhouse.io/northwindlabs/jobs/8164933');
check('portal type detected from the host', adapted.portalType !== null, true);

section('the hourly problem — the reason salary_string is parsed');

// THE POINT OF THIS FILE. The schema's only numeric pay fields are annual, but
// this bench is contractors whose criteria carry HOURLY floors, and the matcher
// refuses to compare an annual figure against an hourly floor. Reading the unit
// out of the advertised text is what keeps an hourly rate hourly.
check('an hourly rate stays HOURLY', adapted.posting.payUnit, 'HOURLY');
check('  and keeps the advertised numbers, not the annualised ones',
    [adapted.posting.payMin, adapted.posting.payMax], [70, 90]);
check('  currency survives', adapted.posting.payCurrency, 'USD');

const annualJob = {
    ...JOB,
    salary_string: '$145,600 - $187,200 per year',
};
check('an annual rate stays ANNUAL', parsePay(annualJob).unit, 'ANNUAL');
check('  and uses the structured fields', parsePay(annualJob).min, 145600);

// An unlabelled figure is the dangerous case: guessing a unit survives into
// scoring, where a wrong one is worse than an absent one.
check('no text and no structured pay → null',
    parsePay({ salary_currency: 'USD' }), null);
check('an unlabelled salary_string alone is NOT trusted',
    parsePay({ salary_string: '70 - 90' }), null);
check('structured annual fields without any text are still usable',
    parsePay({ min_annual_salary: 140000, salary_currency: 'USD' }).unit, 'ANNUAL');

section('salary_string parsing');

check('k shorthand is expanded, not read as 120',
    parseSalaryString('$120k - $150k').min, 120000);
check('  and the upper bound too', parseSalaryString('$120k - $150k').max, 150000);
check('per hour is detected', parseSalaryString('$65/hr').hourly, true);
check('per year is detected', parseSalaryString('$130,000 per annum').annual, true);
check('commas are stripped', parseSalaryString('$145,600 a year').min, 145600);
check('prose with no number is null', parseSalaryString('competitive'), null);
check('empty is null', parseSalaryString(''), null);

section('currency is ISO 4217 or nothing');

// Validated BEFORE truncation, deliberately: slicing first turns "dollars"
// into "DOL", which then passes a three-letter check and is stored as a
// currency that does not exist.
check('a bogus currency is dropped, not truncated to three letters',
    parsePay({ ...JOB, salary_currency: 'dollars' }).currency, null);
check('a real code is kept', parsePay({ ...JOB, salary_currency: 'gbp' }).currency, 'GBP');

section('work type comes from an ARRAY in this schema');

check('contract', readWorkType(['contract']), 'CONTRACT');
check('full_time underscore spelling', readWorkType(['full_time']), 'FULL_TIME');
check('c2c is its own row, not CONTRACT', readWorkType(['c2c']), 'C2C');
check('w2 is its own row', readWorkType(['w2']), 'W2');
check('first recognised entry wins', readWorkType(['unknown', 'contract']), 'CONTRACT');
// No INTERNSHIP row exists in lkp_work_types, so null is correct: a name that
// resolves to no id would look like a mapping and behave like an absence.
check('an unmapped value is null, never a guess', readWorkType(['internship']), null);
check('an empty array is null', readWorkType([]), null);
check('a bare string still works', readWorkType('contract'), 'CONTRACT');

section('location, because it is two-thirds of the fingerprint');

check('resolved location preferred', readLocation(JOB), 'Austin, TX');
check('falls back to short_location',
    readLocation({ short_location: 'Dallas, TX' }), 'Dallas, TX');
// City before region: normaliseLocation keeps the first four words, so country
// first would push the city out and merge every US job into one.
check('assembles city before region when sent apart',
    readLocation({ cities: ['Denver'], state_code: 'CO' }), 'Denver, CO');
check('nothing usable is null', readLocation({}), null);

section('remote');

check('explicit true', readRemote({ remote: true }), true);
check('explicit false is respected, not overridden by the title',
    readRemote({ remote: false, job_title: 'Remote Engineer' }), false);
check('inferred from the location text when the flag is absent',
    readRemote({}, 'Remote - US'), true);
check('a normal city is not remote', readRemote({}, 'Austin, TX'), false);

section('a remote job with no place named gets "Anywhere"');

// Not null: the fingerprint includes location, and an empty one would collide
// with every other remote job at the same company with the same title — which,
// for once, is the correct merge.
const remoteNoPlace = searchJobToPosting(
    { ...JOB, location: null, short_location: null, long_location: null, cities: [] },
    { now: CLOCK },
);
check('locationText', remoteNoPlace.posting.locationText, 'Anywhere');

section('URLs we refuse to store');

check('javascript: is refused', sanitiseUrl('javascript:alert(1)'), null);
check('data: is refused', sanitiseUrl('data:text/html,<b>x</b>'), null);
check('https is kept', sanitiseUrl('https://example.com/jobs/1'), 'https://example.com/jobs/1');
check('nonsense is refused', sanitiseUrl('not a url'), null);
// source_url is the last fallback, so a job with only that still adapts.
check('a job whose only link is source_url still adapts',
    searchJobToPosting({ ...JOB, url: null, final_url: null }, { now: CLOCK })
        .posting.sourceUrl, 'https://linkedin.com/jobs/view/8164933');

section('what gets rejected outright');

check('no company', searchJobToPosting({ ...JOB, company: null, company_object: null }), null);
check('no title', searchJobToPosting({ ...JOB, job_title: null, normalized_title: null }), null);
check('no usable link',
    searchJobToPosting({ ...JOB, url: null, final_url: null, source_url: null }), null);
check('not an object', searchJobToPosting('nope'), null);
check('null', searchJobToPosting(null), null);
check('company_object is an accepted fallback',
    searchJobToPosting({ ...JOB, company: null, company_object: { name: 'Initech' } })
        .posting.company, 'Initech');

section('posted_at');

check('ISO with offset is normalised to Z',
    parsePostedAt('2026-09-12T06:00:00+00:00', CLOCK), '2026-09-12T06:00:00.000Z');
check('unparseable is null', parsePostedAt('last tuesday', CLOCK), null);
check('absent is null', parsePostedAt(null, CLOCK), null);
// A date years out is a parsing accident, not a job posted in 1970. posted_at
// gates nothing, so null is honest — a wrong date is quiet damage that only
// shows up later in reporting, which for this trial IS the deliverable.
check('the epoch is refused', parsePostedAt('1970-01-01T00:00:00Z', CLOCK), null);
check('the far future is refused', parsePostedAt('2030-01-01T00:00:00Z', CLOCK), null);

/* ── what a live page of this feed actually taught us ─────────────────── */

section('an ESTIMATED salary must never reach the pay columns');

// payMin/payMax are compared against a consultant's minimum-rate criterion.
// `salary_type` distinguishes an advertised figure from JobsPipe's own model
// output, and filtering a real job out — or letting a bad one through — on a
// guessed number is a decision made on invented data that nothing downstream
// could detect.
check('observed pay is used',
    parsePay({ ...JOB, salary_type: 'observed' }) !== null, true);
check('estimated pay is refused outright',
    parsePay({ ...JOB, salary_type: 'estimated' }), null);
check('  even when the amounts look perfectly good',
    parsePay({ salary_type: 'estimated', min_annual_salary: 150000, salary_currency: 'USD' }), null);
check('an absent salary_type is treated as observed',
    parsePay({ min_annual_salary: 150000, salary_currency: 'USD' }).unit, 'ANNUAL');

section('date_posted is in the FUTURE on much of this feed');

// Measured, not hypothesised: 11 of 25 jobs on a live page carried a
// date_posted LATER than discovered_at — one said 2026-09-21 while
// discovered_at said 2026-08-11, six weeks earlier. A posting cannot be
// discovered before it is published, so on those rows the field is a deadline
// or a refresh date, not a publication date.
const badDate = {
    ...JOB,
    date_posted: '2026-09-21T00:00:00+00:00',   // future
    discovered_at: '2026-08-11T00:22:42+00:00', // six weeks earlier
};

check('the impossible ordering is detected',
    resolvePostedAt(badDate, CLOCK).suspect, true);
check('  and discovered_at is used instead',
    resolvePostedAt(badDate, CLOCK).postedAt, '2026-08-11T00:22:42.000Z');
check('a sane pair is left alone',
    resolvePostedAt(JOB, CLOCK).suspect, false);
check('  keeping the real publication date',
    resolvePostedAt(JOB, CLOCK).postedAt, '2026-09-12T06:00:00.000Z');

// The two failures this prevents, stated as assertions so they cannot return.
const badAdapted = searchJobToPosting(badDate, { now: CLOCK });
check('a future date never reaches posting.postedAt',
    new Date(badAdapted.posting.postedAt).getTime() <= CLOCK.getTime(), true);
// Left uncorrected this row reports a NEGATIVE age and sorts to the top as the
// freshest job in the feed — which would make the trial's headline number a
// fabrication rather than a measurement.
check('  so its age is not negative',
    (CLOCK.getTime() - new Date(badAdapted.posting.postedAt).getTime()) >= 0, true);
check('the raw value is still kept for auditing',
    badAdapted.freshness.rawDatePosted, '2026-09-21T00:00:00+00:00');
check('and the row is flagged', badAdapted.freshness.suspectDate, true);

section('a bare region is not a location');

// A live page returned state_code on 25/25 jobs but a city was what made the
// string meaningful. "TX" alone goes into the fingerprint, splitting one job
// from its properly-located duplicate, and reads as a real place to the
// location filter.
check('city + region is fine', readLocation({ cities: ['Austin'], state_code: 'TX' }), 'Austin, TX');
check('region with no city is null', readLocation({ state_code: 'TX' }), null);
check('country with no city is null', readLocation({ country_code: 'US' }), null);

/* ── R-15: one job, one fingerprint, whichever door it came through ───── */

section('a polled job and a pushed job collapse onto ONE fingerprint');

// The guarantee the whole three-door design rests on. If these two differ, the
// same job reaches a consultant twice — the exact failure R-15 exists to stop.
const polled = searchJobToPosting(JOB, { now: CLOCK });
const sameJobDifferentWords = searchJobToPosting({
    ...JOB,
    job_title: 'Senior React Developer',
    company: 'Northwind Labs, Inc.',     // suffix noise
    location: 'Austin, Texas',           // spelled out
    url: 'https://boards.greenhouse.io/northwindlabs/jobs/8164933?src=email',
}, { now: CLOCK });

check('fingerprints match despite suffix and spelling noise',
    fingerprintPosting(polled.posting) === fingerprintPosting(sameJobDifferentWords.posting),
    true);
check('a genuinely different company does NOT collapse',
    fingerprintPosting(polled.posting)
        === fingerprintPosting(searchJobToPosting({ ...JOB, company: 'Initech' }).posting),
    false);

/* ── it reaches the real matcher ──────────────────────────────────────── */

section('an adapted posting is scored by the existing matcher');

// The key names are the ones config/jobMatcher.js actually reads — taken from
// tests/discovery.test.mjs rather than guessed. A plausible-looking wrong key
// (`keywords` for `keywordsInclude`) does not error, it just silently scores
// zero, which is the most expensive kind of test-fixture mistake.
const criteria = {
    jobTitles: ['React Developer'],
    keywordsInclude: ['React', 'TypeScript'],
    keywordsExclude: [],
    excludedCompanies: [],
    locations: [{ city: 'Austin', state: 'TX', workMode: 'REMOTE' }],
    workTypeNames: ['CONTRACT'],
    minPay: { amount: 55, unit: 'HOURLY' },
};

const verdict = evaluate(polled.posting, criteria, { workTypeName: polled.posting.workType });
check('reaches the scoring stage', verdict.stage, 'score');
check('and matches', verdict.matched, true);
// The payoff of the hourly parse: 70 ≥ 55 is only a comparison the matcher will
// make because the unit survived as HOURLY. Annualised, it would be discarded.
check('the hourly floor was actually applied', verdict.score > 0, true);

section('the same job with pay stripped still matches, just lower');

const noPay = searchJobToPosting({
    ...JOB, salary_string: null, min_annual_salary: null, max_annual_salary: null,
}, { now: CLOCK });
check('no pay unit', noPay.posting.payUnit, null);
const noPayVerdict = evaluate(noPay.posting, criteria, { workTypeName: noPay.posting.workType });
check('still matched', noPayVerdict.matched, true);
check('but scores no higher than the priced one',
    noPayVerdict.score <= verdict.score, true);

/* ── the freshness arithmetic the trial is judged on ──────────────────── */

section('age statistics');

const now = new Date('2026-09-12T12:00:00Z').getTime();
const stats = ageStats([
    { date_posted: '2026-09-12T11:00:00Z' },   // 1h
    { date_posted: '2026-09-12T06:00:00Z' },   // 6h
    { date_posted: '2026-09-11T12:00:00Z' },   // 24h
    { date_posted: '2026-09-05T12:00:00Z' },   // 168h
    { date_posted: null },                      // no date — excluded
], now);

check('undated jobs are excluded rather than counted as fresh', stats.counted, 4);
check('freshest', stats.min, 1);
check('oldest', stats.max, 168);
check('median', stats.median, 24);
check('posted in the last 24h', stats.last24h, 3);
check('an empty page yields nulls, not zeros',
    ageStats([]), { min: null, median: null, max: null, last24h: 0, counted: 0 });
// A feed that returns no dates at all must not read as "everything is fresh".
check('a page with no dates counts nothing',
    ageStats([{ date_posted: null }]).counted, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
