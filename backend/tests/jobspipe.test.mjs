/**
 * JobsPipe real-time ingestion — unit suite.
 *
 *   node tests/jobspipe.test.mjs
 *   npm run test:jobspipe
 *
 * ── WHY THIS IS NOT pytest ────────────────────────────────────────────
 *
 * The specification asked for pytest against a FastAPI route. This backend is
 * Node/Express, so there is no Python to test and no FastAPI app to spin up.
 * The suite is written in the convention the six suites beside it already use
 * — a plain script, a `check` helper, and a non-zero exit on any failure —
 * because `npm test` runs `node --test tests/` over the whole directory and a
 * file that needed a framework nobody has installed would simply not run.
 *
 * ── WHAT IS AND IS NOT COVERED ────────────────────────────────────────
 *
 * Everything here is PURE: the adapter, and the existing de-duplication and
 * matching functions it feeds. Nothing touches the network or the database.
 *
 * That is the same line tests/discovery.test.mjs draws, for the same reason: a
 * suite that stood up Postgres would fail on a laptop with no database, which
 * is not a regression in this code. The parts that genuinely break when a
 * contract drifts — field names moving, a unit going missing, a fingerprint
 * splitting one job into two — are all in the pure half, and they are what is
 * exercised below.
 *
 * The half that is NOT covered here is the transactional path (upsertPosting,
 * the queue insert, promoteToReady). It is reached instead by the "Send test
 * delivery" button on the JobsPipe screen, which calls the real ingestJob
 * against the real database — see controllers/jobspipeListener.js.
 */
import {
    jobspipeToPosting, unwrap, unwrapBatch, parsePay, parsePublishedAt,
    readWorkType, SOURCE_NAME, __test,
} from '../connectors/jobspipe.js';
import { fingerprintPosting } from '../config/fingerprint.js';
import { evaluate, preFilter, MATCH_THRESHOLD } from '../config/jobMatcher.js';
import { jobResultToPosting } from '../connectors/googleJobs.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/** Fixed, so "2 hours ago" style assertions cannot drift with the wall clock. */
const CLOCK = new Date('2026-09-09T12:00:00Z');

/* ── the canonical delivery ───────────────────────────────────────────── */

/** The shape connectors/jobspipe.js documents, used as the baseline. */
const delivery = {
    event: 'job.created',
    delivery_id: 'dlv_01HTEST',
    job: {
        id: 'jp_9f21c',
        title: 'Senior React Developer',
        company: { name: 'Acme Technologies, Inc.' },
        location: { city: 'Austin', region: 'TX', remote: false },
        employment_type: 'contract',
        description_html: '<p>Building <strong>React</strong> and TypeScript apps.</p>'
            + '<ul><li>GraphQL</li></ul>',
        apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
        salary: { min: 65, max: 85, currency: 'USD', interval: 'hourly' },
        published_at: '2026-09-09T09:55:00Z',
        source: 'linkedin',
    },
};

section('the documented payload maps onto our posting shape');

const adapted = jobspipeToPosting(delivery, { now: CLOCK });

check('adapted at all', adapted !== null, true);
check('source is the webhook row', adapted.source, SOURCE_NAME);
check('company', adapted.posting.company, 'Acme Technologies, Inc.');
check('title', adapted.posting.title, 'Senior React Developer');
check('location assembled from city + region', adapted.posting.locationText, 'Austin, TX');
check('not remote', adapted.posting.isRemote, false);
check('work type', adapted.posting.workType, 'CONTRACT');
check('pay min', adapted.posting.payMin, 65);
check('pay max', adapted.posting.payMax, 85);
check('pay unit', adapted.posting.payUnit, 'HOURLY');
check('pay currency', adapted.posting.payCurrency, 'USD');
check('provider job id', adapted.posting.providerJobId, 'jp_9f21c');
check('posted at', adapted.posting.postedAt, '2026-09-09T09:55:00.000Z');
check('origin board kept for attribution', adapted.originBoard, 'linkedin');

// The portal decides the BOT/HUMAN lane, and is read from the apply link's
// host by googleJobs.js — reused rather than reimplemented.
check('portal type read from the apply host', adapted.portalType, 'GREENHOUSE');

// Markup must not survive: include/exclude keywords are matched against this
// text, and a <strong> tag makes "strong" a keyword hit.
check('description is stripped of markup',
    adapted.posting.description.includes('<'), false);
check('  and keeps the words', adapted.posting.description.includes('React'), true);

/* ── the fields that MUST be present ──────────────────────────────────── */

section('a payload that cannot be de-duplicated is rejected, not half-stored');

const without = (path) => {
    const copy = structuredClone(delivery);
    const parts = path.split('.');
    let node = copy.job;
    for (const p of parts.slice(0, -1)) node = node[p];
    delete node[parts.at(-1)];
    return copy;
};

check('no company → null', jobspipeToPosting(without('company')), null);
check('no title → null', jobspipeToPosting(without('title')), null);
// source_url is NOT NULL in job_postings, and a posting nobody can open is not
// a lead.
check('no apply url → null', jobspipeToPosting(without('apply_url')), null);
check('empty object → null', jobspipeToPosting({}), null);
check('null → null', jobspipeToPosting(null), null);
check('a string → null', jobspipeToPosting('nope'), null);

// Untrusted input reaches an anchor on the queue screen.
const jsUrl = structuredClone(delivery);
jsUrl.job.apply_url = 'javascript:alert(1)';
check('a javascript: apply link is refused', jobspipeToPosting(jsUrl), null);

const ftpUrl = structuredClone(delivery);
ftpUrl.job.apply_url = 'ftp://files.example.com/job';
check('a non-http scheme is refused', jobspipeToPosting(ftpUrl), null);

/* ── the field names that move ────────────────────────────────────────── */

section('alternate spellings, because push feeds rename fields between tiers');

const flat = {
    job_id: 'jp_flat',
    job_title: 'Senior React Developer',
    company_name: 'Acme Technologies',
    location: 'Austin, TX',
    job_type: 'Contract',
    description: 'Plain text description with React in it.',
    url: 'https://jobs.lever.co/acme/abc',
    salary_min: 65,
    salary_max: 85,
    salary_period: 'hour',
    salary_currency: 'usd',
    posted_at: '2026-09-09T09:55:00Z',
};

const flatAdapted = jobspipeToPosting(flat, { now: CLOCK });
check('a bare job with flat names still adapts', flatAdapted !== null, true);
check('  company', flatAdapted.posting.company, 'Acme Technologies');
check('  title', flatAdapted.posting.title, 'Senior React Developer');
check('  location as one string', flatAdapted.posting.locationText, 'Austin, TX');
check('  work type from job_type', flatAdapted.posting.workType, 'CONTRACT');
check('  pay unit from salary_period', flatAdapted.posting.payUnit, 'HOURLY');
check('  currency upper-cased', flatAdapted.posting.payCurrency, 'USD');
check('  portal from a Lever link', flatAdapted.portalType, 'LEVER');

check('company as a plain string', jobspipeToPosting({
    ...flat, company: 'Globex', company_name: undefined,
}).posting.company, 'Globex');

section('envelopes');

check('{ job }', unwrap(delivery).id, 'jp_9f21c');
check('{ data }', unwrap({ data: { title: 'x' } }).title, 'x');
check('bare job', unwrap({ title: 'x' }).title, 'x');
check('an array is not a job', unwrap([1, 2]), null);

check('{ jobs: [...] } is a batch', unwrapBatch({ jobs: [1, 2, 3] }).length, 3);
check('a bare array is a batch', unwrapBatch([1, 2]).length, 2);
check('a single delivery is not a batch', unwrapBatch(delivery), null);

/* ── remote ───────────────────────────────────────────────────────────── */

section('remote');

const remoteFlag = structuredClone(delivery);
remoteFlag.job.location = { remote: true };
const remoteAdapted = jobspipeToPosting(remoteFlag, { now: CLOCK });
check('an explicit flag with no place named', remoteAdapted.posting.isRemote, true);
// Not null: the fingerprint hashes location, and an empty one would collide
// with every other remote job at the same company with the same title.
check('  location becomes "Anywhere"', remoteAdapted.posting.locationText, 'Anywhere');

check('the word in a location string',
    jobspipeToPosting({ ...flat, location: 'Remote - US' }).posting.isRemote, true);
check('a normal place is not remote',
    jobspipeToPosting({ ...flat, location: 'Dallas, TX' }).posting.isRemote, false);

/* ── pay, under the strict rule ───────────────────────────────────────── */

section('pay — a unit we cannot read means no pay, never a guessed one');

check('hourly', parsePay({ salary: { min: 60, max: 80, interval: 'hourly' } })?.unit, 'HOURLY');
check('annual', parsePay({ salary: { min: 120000, interval: 'year' } })?.unit, 'ANNUAL');
// The column stores HOURLY or ANNUAL. Multiplying a monthly figure by twelve
// would invent a salary the employer never advertised.
check('monthly is refused', parsePay({ salary: { min: 9000, interval: 'monthly' } }), null);
check('weekly is refused', parsePay({ salary: { min: 3000, interval: 'weekly' } }), null);
// The minimum-pay filter compares bare numbers, so an hourly rate that loses
// its unit is measured against an annual floor and silently drops good roles.
check('no interval at all is refused', parsePay({ salary: { min: 60, max: 80 } }), null);
check('a unit with no amount is refused', parsePay({ salary: { interval: 'hourly' } }), null);
check('a negative amount is refused',
    parsePay({ salary: { min: -5, interval: 'hourly' } })?.min ?? null, null);
check('an unreadable currency is left null',
    parsePay({ salary: { min: 60, interval: 'hourly', currency: 'dollars' } }).currency, null);
check('only a max — "up to" — keeps min null',
    parsePay({ salary: { max: 90, interval: 'hourly' } }).min, null);

/* ── dates ────────────────────────────────────────────────────────────── */

section('published_at');

check('ISO', parsePublishedAt('2026-09-09T09:55:00Z', CLOCK), '2026-09-09T09:55:00.000Z');
check('epoch seconds', parsePublishedAt(1788947700, CLOCK), '2026-09-09T09:55:00.000Z');
check('epoch milliseconds', parsePublishedAt(1788947700000, CLOCK), '2026-09-09T09:55:00.000Z');
check('nonsense → null', parsePublishedAt('last tuesday', CLOCK), null);
check('absent → null', parsePublishedAt(null, CLOCK), null);
// A push feed delivers within minutes of publication, so these are parsing
// accidents rather than facts about the job.
check('far future → null', parsePublishedAt('2030-01-01T00:00:00Z', CLOCK), null);
check('the epoch → null', parsePublishedAt(0, CLOCK), null);

/* ── work type ────────────────────────────────────────────────────────── */

section('work type — only names that exist in lkp_work_types');

check('Contract', readWorkType('Contract'), 'CONTRACT');
check('contract-to-hire', readWorkType('contract-to-hire'), 'CONTRACT');
check('Full-Time', readWorkType('Full-Time'), 'FULL_TIME');
check('full_time', readWorkType('full_time'), 'FULL_TIME');
check('C2C', readWorkType('C2C'), 'C2C');
check('W2', readWorkType('w2'), 'W2');
// scoreMatch subtracts 10 for a work-type mismatch, so a guess actively pushes
// a job away from the consultants it suits. Null merely scores nothing.
check('internship has no row, so null not a guess', readWorkType('internship'), null);
check('gibberish → null', readWorkType('permanent-ish'), null);
check('absent → null', readWorkType(undefined), null);

/* ── R-15: the whole point of reusing the fingerprint ─────────────────── */

section('de-duplication — the same job from both doors is ONE job');

// The same opening: pushed by JobsPipe, and found by the scheduled cycle
// through Google Jobs. Different envelopes, different field names, different
// decoration on the title.
const viaJobsPipe = jobspipeToPosting({
    job: {
        title: 'Senior React Developer (Remote) - Urgent Hiring',
        company: { name: 'Acme Technologies, Inc.' },
        location: { remote: true },
        apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
    },
}, { now: CLOCK });

const viaCycle = jobResultToPosting({
    title: 'Senior React Developer',
    company_name: 'Acme Technologies',
    location: 'Anywhere',
    via: 'via LinkedIn',
    detected_extensions: { work_from_home: true },
    apply_options: [{ title: 'Greenhouse', link: 'https://boards.greenhouse.io/acme/jobs/1' }],
}, { now: CLOCK });

check('both adapted', [viaJobsPipe !== null, viaCycle !== null], [true, true]);
// If this ever fails, the same job reaches a consultant twice and they apply
// twice — visible to the employer. It is the single most important assertion
// in this file.
check('one fingerprint, so one row in the pool',
    fingerprintPosting(viaJobsPipe.posting) === fingerprintPosting(viaCycle.posting), true);

// The rule must not be so loose that it eats real jobs.
const different = jobspipeToPosting({
    job: {
        title: 'React Developer',        // not Senior — a different job
        company: { name: 'Acme Technologies' },
        location: { remote: true },
        apply_url: 'https://boards.greenhouse.io/acme/jobs/2',
    },
}, { now: CLOCK });
check('a different seniority stays a different job',
    fingerprintPosting(viaJobsPipe.posting) === fingerprintPosting(different.posting), false);

/* ── the pre-filter and the matcher ───────────────────────────────────── */

section('a pushed job reaches the matcher exactly as a pulled one does');

const criteria = {
    jobTitles: ['Senior React Developer', 'Frontend Engineer'],
    keywordsInclude: ['react', 'typescript'],
    keywordsExclude: ['clearance'],
    excludedCompanies: ['Initech'],
    locations: [{ city: 'Austin', state: 'TX', workMode: 'ONSITE' }],
    workTypeNames: ['CONTRACT'],
    minPay: { amount: 60, unit: 'HOURLY' },
};

const verdict = evaluate(adapted.posting, criteria, {
    workTypeName: adapted.posting.workType,
});
check('matched', verdict.matched, true);
check('  reached the scoring stage', verdict.stage, 'score');
check('  scored at or above the threshold', verdict.score >= MATCH_THRESHOLD, true);

// R-16: the cheap stage that drops most of the volume, before anything
// expensive runs. A webhook that skipped it would spend model money on jobs
// the cycle would have dropped for free.
section('the cheap pre-filter still does the dropping');

const wrongTitle = jobspipeToPosting({
    ...flat, job_title: 'Warehouse Associate', url: 'https://jobs.lever.co/acme/x',
});
const wrongTitleVerdict = evaluate(wrongTitle.posting, criteria, {});
check('a job for nobody stops at the pre-filter', wrongTitleVerdict.stage, 'prefilter');
check('  and never scores', wrongTitleVerdict.score, 0);
check('  preFilter says so directly', preFilter(wrongTitle.posting, criteria).pass, false);

const wrongPlace = jobspipeToPosting({ ...flat, location: 'Bangor, ME' });
check('a job in the wrong place stops at the pre-filter',
    evaluate(wrongPlace.posting, criteria, {}).stage, 'prefilter');

// Hard filters outrank everything, including a perfect title.
const excluded = jobspipeToPosting({ ...flat, company_name: 'Initech Solutions' });
check('an excluded company is refused before the pre-filter',
    evaluate(excluded.posting, criteria, {}).stage, 'hard');

const cleared = jobspipeToPosting({
    ...flat, description: 'React work requiring an active TS/SCI clearance.',
});
check('an excluded keyword is refused before the pre-filter',
    evaluate(cleared.posting, criteria, {}).stage, 'hard');

// Fail closed, at the last gate before a job reaches a person.
check('criteria describing nothing match nothing',
    evaluate(adapted.posting, { keywordsExclude: ['php'] }, {}).matched, false);

/* ── batch handling ───────────────────────────────────────────────────── */

section('a batch delivery');

const batch = unwrapBatch({ jobs: [delivery.job, flat, { title: 'no company' }] });
const batchAdapted = batch.map((j) => jobspipeToPosting(j, { now: CLOCK }));
check('three in', batch.length, 3);
check('  two usable', batchAdapted.filter(Boolean).length, 2);
// The unusable one is rejected individually; it does not discard the delivery.
check('  the third is rejected on its own', batchAdapted[2], null);

/* ── the path table ───────────────────────────────────────────────────── */

section('field mapping is data, so a rename is a one-line fix');

check('every field we read has at least one accepted path',
    Object.values(__test.ACCEPTED_PATHS).every((paths) => paths.length > 0), true);
check('dig walks a nested path', __test.dig(delivery, 'job.company.name'), 'Acme Technologies, Inc.');
check('dig on a missing branch does not throw', __test.dig(delivery, 'job.nope.deeper'), undefined);
check('firstOf takes the first non-empty', __test.firstOf({ a: '', b: 'x' }, ['a', 'b']), 'x');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
