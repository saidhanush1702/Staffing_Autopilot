/**
 * ── JOBSPIPE → OUR POSTING SHAPE ──────────────────────────────────────
 *
 * JobsPipe pushes a job to us the moment it is published, instead of us paying
 * a search provider to go looking. This module is the adapter, and it is the
 * only file in the webhook path that knows anything about JobsPipe's JSON.
 *
 * ── WHY THIS MIRRORS googleJobs.js RATHER THAN INVENTING A SHAPE ──────
 *
 * It returns exactly what `jobResultToPosting` returns — the same keys, the
 * same null conventions, the same "return null rather than guess" rule. That
 * is deliberate: `upsertPosting`, `fingerprintPosting` and `evaluate` are then
 * reused untouched, so a posting that arrived by webhook and the same posting
 * found by the scheduled cycle collapse onto ONE fingerprint and one row.
 *
 * If this adapter emitted its own shape, the two paths would de-duplicate
 * separately and the same job would reach a consultant twice — which is the
 * one failure R-15 exists to prevent, arriving through a side door.
 *
 * ── WHAT THIS IS AND IS NOT STRICT ABOUT ──────────────────────────────
 *
 * Strict on the three fields that ARE the fingerprint (company, title,
 * location) and on the apply URL, because `source_url` is NOT NULL and a
 * posting nobody can open is not a lead. A payload missing any of those is
 * rejected outright and quarantined by the caller, never half-stored.
 *
 * Liberal about WHERE those fields live. Push feeds change field names between
 * plan tiers and API versions far more often than they change meaning, and a
 * trial that dies on `company` becoming `company.name` teaches nothing about
 * the feed. So each field is read from a list of accepted paths.
 *
 * ── THE SCHEMA THIS WAS WRITTEN AGAINST ───────────────────────────────
 *
 * The canonical envelope, which `ACCEPTED_PATHS` below is keyed to:
 *
 *   {
 *     "event": "job.created",
 *     "delivery_id": "dlv_01H...",
 *     "job": {
 *       "id": "jp_9f21c",
 *       "title": "Senior React Developer",
 *       "company": { "name": "Acme Technologies, Inc." },
 *       "location": { "city": "Austin", "region": "TX", "remote": false },
 *       "employment_type": "contract",
 *       "description_html": "<p>…</p>",
 *       "apply_url": "https://boards.greenhouse.io/acme/jobs/1",
 *       "salary": { "min": 60, "max": 80, "currency": "USD", "interval": "hourly" },
 *       "published_at": "2026-09-09T09:55:00Z",
 *       "source": "linkedin"
 *     }
 *   }
 *
 * A bare job object with no `job` wrapper is accepted too, because half the
 * push feeds in this category send one and half send the other.
 *
 * !! VERIFY THIS AGAINST JOBSPIPE'S OWN DOCUMENTATION BEFORE TRUSTING THE
 * !! TRIAL NUMBERS. It was written from the shape this pipeline needs, not
 * !! from a captured live delivery. Every mapping lives in ACCEPTED_PATHS
 * !! below, so correcting one is a one-line change and a test, not a rewrite.
 */
import { plain, tidy } from './text.js';
import { detectPortalType } from './googleJobs.js';

/** The source row every webhook posting is attributed to. See migration 043. */
export const SOURCE_NAME = 'JOBSPIPE';

/* ── reading a field out of a shape that keeps moving ─────────────────── */

/** `dig(obj, 'company.name')` — undefined rather than a throw on any miss. */
const dig = (obj, path) => path.split('.').reduce(
    (acc, key) => (acc == null ? undefined : acc[key]),
    obj,
);

/** First path that yields something non-empty. Order is preference order. */
const firstOf = (obj, paths) => {
    for (const path of paths) {
        const value = dig(obj, path);
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
};

/**
 * Every accepted spelling of every field we need, in preference order.
 *
 * Kept as data rather than spread through the parser so that "what does
 * JobsPipe call the apply link this week" is answerable by reading one table.
 */
const ACCEPTED_PATHS = {
    providerJobId: ['id', 'job_id', 'uuid', 'reference'],
    title:         ['title', 'job_title', 'name', 'position'],
    company:       ['company.name', 'company', 'company_name', 'employer.name', 'employer', 'organization'],
    applyUrl:      ['apply_url', 'application_url', 'apply_link', 'url', 'job_url', 'link'],
    description:   ['description_html', 'description', 'content', 'body', 'summary'],
    employmentType:['employment_type', 'job_type', 'type', 'schedule_type', 'contract_type'],
    publishedAt:   ['published_at', 'posted_at', 'created_at', 'date_posted', 'listed_at'],
    sourceBoard:   ['source', 'source_name', 'board', 'origin'],

    // Location arrives as a string as often as an object, so the pieces and
    // the whole are both listed and whichever turns up first wins.
    locationText:  ['location.text', 'location.name', 'location_text', 'location', 'city_state', 'place'],
    locationCity:  ['location.city', 'city'],
    locationRegion:['location.region', 'location.state', 'region', 'state'],
    remoteFlag:    ['location.remote', 'remote', 'is_remote', 'remote_ok', 'work_from_home'],

    salaryMin:     ['salary.min', 'salary.minimum', 'compensation.min', 'salary_min', 'pay.min'],
    salaryMax:     ['salary.max', 'salary.maximum', 'compensation.max', 'salary_max', 'pay.max'],
    salaryUnit:    ['salary.interval', 'salary.period', 'salary.unit', 'compensation.interval', 'pay.unit', 'salary_period'],
    salaryCurrency:['salary.currency', 'compensation.currency', 'pay.currency', 'salary_currency'],
};

const read = (job, key) => firstOf(job, ACCEPTED_PATHS[key]);

/* ── the individual conversions ───────────────────────────────────────── */

/**
 * JobsPipe's employment vocabulary → our lkp_work_types names.
 *
 * Unknown values return null rather than a guess. A wrong work type does not
 * merely lose a scoring signal — `scoreMatch` subtracts 10 for a mismatch, so
 * mislabelling a contract role as full-time actively pushes it away from the
 * contractors it suits.
 *
 * The right-hand side is the WHOLE of `lkp_work_types` (seed 001): CONTRACT,
 * FULL_TIME, PART_TIME, C2C, W2. There is no INTERNSHIP row, so an internship
 * maps to null and scores neutrally rather than to a name that resolves to no
 * id — which would look like a mapping and behave like an absence.
 */
const WORK_TYPE = {
    'full-time': 'FULL_TIME',
    full_time: 'FULL_TIME',
    fulltime: 'FULL_TIME',
    'full time': 'FULL_TIME',
    permanent: 'FULL_TIME',
    'part-time': 'PART_TIME',
    part_time: 'PART_TIME',
    parttime: 'PART_TIME',
    'part time': 'PART_TIME',
    contract: 'CONTRACT',
    contractor: 'CONTRACT',
    'contract-to-hire': 'CONTRACT',
    'contract to hire': 'CONTRACT',
    c2h: 'CONTRACT',
    temporary: 'CONTRACT',
    temp: 'CONTRACT',
    freelance: 'CONTRACT',
    // Engagement structures, which JobsPipe reports in the same field as the
    // schedule. They are separate rows here because a consultant's criteria
    // distinguish them.
    c2c: 'C2C',
    'corp-to-corp': 'C2C',
    'corp to corp': 'C2C',
    w2: 'W2',
    'w-2': 'W2',
};

export const readWorkType = (raw) => {
    const key = tidy(raw)?.toLowerCase();
    return (key && WORK_TYPE[key]) ?? null;
};

/**
 * Pay, under the same strict rule googleJobs.js applies.
 *
 * Returns null unless a usable amount AND a unit in our vocabulary are both
 * present. The minimum-pay filter compares bare numbers, so an hourly rate
 * that loses its unit is measured against an annual floor and silently
 * discards every good contract role.
 *
 * MONTHLY, WEEKLY and DAILY intervals return null rather than being converted.
 * The column accepts HOURLY or ANNUAL only, and multiplying a monthly figure
 * by twelve invents a salary the employer never advertised.
 */
const PAY_UNITS = {
    hour: 'HOURLY', hourly: 'HOURLY', hr: 'HOURLY', per_hour: 'HOURLY', 'per hour': 'HOURLY',
    year: 'ANNUAL', yearly: 'ANNUAL', annual: 'ANNUAL', annually: 'ANNUAL', yr: 'ANNUAL',
    per_year: 'ANNUAL', 'per year': 'ANNUAL',
};

const finite = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

export const parsePay = (job) => {
    const unit = PAY_UNITS[tidy(read(job, 'salaryUnit'))?.toLowerCase()] ?? null;
    if (!unit) return null;

    const min = finite(read(job, 'salaryMin'));
    const max = finite(read(job, 'salaryMax'));
    if (min === null && max === null) return null;

    // JobsPipe sends an ISO 4217 code, so an absent or unrecognisable one means
    // absent — the column stays null rather than claiming dollars.
    //
    // Validated BEFORE any truncation, deliberately. Taking the first three
    // characters first turns "dollars" into "DOL", which then passes a
    // three-letter check and is stored as a currency code that does not exist.
    // Rejecting the whole value is the only way a bad code stays visibly bad.
    const rawCurrency = tidy(read(job, 'salaryCurrency'))?.toUpperCase() ?? null;
    const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;

    return { min, max, unit, currency };
};

/**
 * The published timestamp, as an ISO string.
 *
 * An unparseable or absurd date returns null. `posted_at` feeds nothing that
 * gates a match, so a wrong date is quiet damage that only shows up months
 * later in reporting — null is honest and costs nothing.
 */
export const parsePublishedAt = (raw, now = new Date()) => {
    if (!raw) return null;

    // Epoch seconds and milliseconds both appear in feeds of this kind.
    let date;
    if (typeof raw === 'number' || /^\d{10}$|^\d{13}$/.test(String(raw))) {
        const n = Number(raw);
        date = new Date(String(raw).length === 10 ? n * 1000 : n);
    } else {
        date = new Date(String(raw));
    }

    if (Number.isNaN(date.getTime())) return null;

    // A push feed delivers within minutes of publication. A date years out in
    // either direction is a parsing accident, not a job posted in 1970.
    const skewMs = 366 * 24 * 3_600_000;
    if (date.getTime() > now.getTime() + 24 * 3_600_000) return null;
    if (date.getTime() < now.getTime() - skewMs) return null;

    return date.toISOString();
};

const REMOTE_RE = /\bremote\b|\bwork from home\b|\banywhere\b|\btelecommute\b|\bdistributed\b/i;

/** True only on an explicit flag or the word appearing where a place should be. */
const readRemote = (job, locationText, title) => {
    const flag = read(job, 'remoteFlag');
    if (flag === true || flag === 'true' || flag === 1) return true;
    return REMOTE_RE.test(`${locationText ?? ''} ${title ?? ''}`);
};

/**
 * Location as one string, because that is what the fingerprint hashes.
 *
 * Assembled from city and region when the payload sends them apart, in that
 * order — `normaliseLocation` keeps the first four words and drops the rest,
 * so putting the country first would push the city out of the fingerprint and
 * merge every job in the United States into one.
 */
const readLocation = (job) => {
    const whole = read(job, 'locationText');
    if (typeof whole === 'string') return tidy(whole);

    const city = tidy(read(job, 'locationCity'));
    const region = tidy(read(job, 'locationRegion'));
    const joined = [city, region].filter(Boolean).join(', ');
    return joined || null;
};

/**
 * URLs we will store, and only those.
 *
 * http(s) only: `javascript:` and `data:` links end up rendered as an anchor on
 * the queue screen, and a posting is untrusted input from outside.
 */
const sanitiseUrl = (raw) => {
    const value = tidy(raw);
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.toString().slice(0, 1000);
    } catch {
        return null;
    }
};

/* ── the adapter ──────────────────────────────────────────────────────── */

/**
 * Unwrap the envelope. `{ job: {...} }`, `{ data: {...} }` or a bare job.
 *
 * Exported because the webhook logs which shape arrived, and the trial wants to
 * know whether the sender is consistent about it.
 */
export const unwrap = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const inner = payload.job ?? payload.data ?? payload.posting ?? payload;
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? inner : null;
};

/**
 * A batch delivery, if this is one. `{ jobs: [...] }` or a bare array.
 *
 * The Free Tier documents single-job deliveries, but a sender that starts
 * batching under load must not be answered with "invalid payload" — that
 * failure would look identical to a broken parser in the trial numbers.
 */
export const unwrapBatch = (payload) => {
    if (Array.isArray(payload)) return payload;
    const list = payload?.jobs ?? payload?.items ?? payload?.results;
    return Array.isArray(list) ? list : null;
};

/**
 * One JobsPipe job → the posting shape the existing pipeline consumes.
 *
 * @returns {{ posting, source, portalType }|null}
 *   null when company, title or a usable apply URL is missing — the caller
 *   quarantines what this rejects, so nothing is dropped in silence.
 */
export const jobspipeToPosting = (raw, { now = new Date() } = {}) => {
    const job = unwrap(raw);
    if (!job) return null;

    const company = tidy(read(job, 'company'));
    const title = tidy(read(job, 'title'));
    // Two-thirds of the R-15 fingerprint. Without them the posting cannot be
    // de-duplicated, and an undedupable posting corrupts the pool.
    if (!company || !title) return null;

    const sourceUrl = sanitiseUrl(read(job, 'applyUrl'));
    if (!sourceUrl) return null;

    const locationText = readLocation(job);
    const isRemote = readRemote(job, locationText, title);
    const pay = parsePay(job);

    return {
        source: SOURCE_NAME,
        // Reused from googleJobs.js rather than reimplemented: which system an
        // application is filled on is a property of the apply link's host, and
        // it decides the BOT/HUMAN lane. Two copies of that rule would put the
        // same employer in different lanes depending on which door it came in.
        portalType: detectPortalType(sourceUrl),
        posting: {
            company,
            title,
            // "Anywhere" rather than null on a remote job with no place named:
            // the fingerprint includes location, and an empty one would collide
            // with every other remote job at the same company with the same
            // title — which, for once, is the correct merge.
            locationText: locationText ?? (isRemote ? 'Anywhere' : null),
            isRemote,
            description: plain(read(job, 'description')),
            sourceUrl,
            workType: readWorkType(read(job, 'employmentType')),
            payMin: pay?.min ?? null,
            payMax: pay?.max ?? null,
            payUnit: pay?.unit ?? null,
            payCurrency: pay?.currency ?? null,
            postedAt: parsePublishedAt(read(job, 'publishedAt'), now),
            providerJobId: tidy(read(job, 'providerJobId')),
        },
        // Attribution only. JobsPipe aggregates boards, and knowing a role came
        // via LinkedIn is useful context on the queue screen even though the
        // posting's source row is JOBSPIPE either way.
        originBoard: tidy(read(job, 'sourceBoard')),
    };
};

export const __test = { dig, firstOf, sanitiseUrl, readLocation, readRemote, ACCEPTED_PATHS };
