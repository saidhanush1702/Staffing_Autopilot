/**
 * ── JOBSPIPE SEARCH RESULT → OUR POSTING SHAPE ────────────────────────
 *
 * The adapter for the PULL path. Returns exactly what `jobResultToPosting`
 * and `jobspipeToPosting` return — same keys, same null conventions, same
 * "return null rather than guess" rule — so `upsertPosting`,
 * `fingerprintPosting` and `evaluate` are reused untouched and a job found by
 * any of the three doors collapses onto ONE fingerprint (R-15).
 *
 * ── WHY THIS IS A SEPARATE FILE FROM connectors/jobspipe.js ───────────
 *
 * Because they consume genuinely different shapes, and pretending otherwise
 * would hide a real problem.
 *
 *   connectors/jobspipe.js   the WEBHOOK envelope. Written from the shape this
 *                            pipeline needs, never confirmed against a live
 *                            delivery — its own header says so.
 *   this file                the SEARCH API response, copied field by field
 *                            from JobsPipe's published SDK type definitions
 *                            (`jobspipe` 0.1.0, `types.py::Job`).
 *
 * ── WHAT THE REAL SCHEMA REVEALED ─────────────────────────────────────
 *
 * The search schema is FLAT, and three of the webhook adapter's guesses do not
 * survive contact with it. Recorded here because the same feed backs both
 * doors, so these are almost certainly wrong in the webhook path too:
 *
 *   webhook guessed          the API actually sends
 *   ─────────────────────    ──────────────────────────────────────────
 *   salary.min / salary_min  min_annual_salary / max_annual_salary
 *   salary.interval          NOTHING — the amounts are annual by name
 *   employment_type          employment_statuses, and it is an ARRAY
 *
 * The salary pair is the damaging one. `parsePay` in the webhook adapter
 * returns null unless it finds BOTH an amount and a unit, so against real
 * JobsPipe data every pushed job would arrive with no pay at all — and a
 * consultant with a minimum-rate criterion would never see it applied.
 *
 * ── THE HOURLY PROBLEM, AND WHY salary_string IS PARSED ───────────────
 *
 * This bench is contractors. Their criteria carry HOURLY floors, and
 * `scoreMatch` deliberately refuses to compare an annual figure against an
 * hourly floor (a rule with its own test: "annual pay is NOT compared against
 * an hourly floor"). JobsPipe only exposes *_annual_salary.
 *
 * So an hourly contract rate would either be lost or silently measured on the
 * wrong scale. `salary_string` is the raw advertised text and usually still
 * says "/hr" — parsing it is what keeps an hourly rate hourly. When the text
 * does not say, the annual fields are used AS annual, which is honest: a wrong
 * unit is far worse than an absent one, because it survives into scoring.
 */
import { plain, tidy } from './text.js';
import { detectPortalType } from './googleJobs.js';

/** Attributed to the same source row as the webhook path. Migration 043. */
export const SOURCE_NAME = 'JOBSPIPE';

/* ── work type ────────────────────────────────────────────────────────── */

/**
 * `employment_statuses` → our `lkp_work_types` names.
 *
 * An ARRAY in this schema, not a string. The first recognised entry wins, and
 * an unrecognised one returns null rather than a guess: `scoreMatch` subtracts
 * 10 for a mismatch, so mislabelling a contract role as full-time actively
 * pushes it away from the contractors it suits.
 *
 * The right-hand side is the whole of `lkp_work_types` (seed 001): CONTRACT,
 * FULL_TIME, PART_TIME, C2C, W2. There is no INTERNSHIP row, so an internship
 * maps to null and scores neutrally rather than to a name that resolves to no
 * id — which would look like a mapping and behave like an absence.
 */
const WORK_TYPE = {
    full_time: 'FULL_TIME',
    'full-time': 'FULL_TIME',
    fulltime: 'FULL_TIME',
    'full time': 'FULL_TIME',
    permanent: 'FULL_TIME',
    part_time: 'PART_TIME',
    'part-time': 'PART_TIME',
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
    // Engagement structures, reported in the same field as the schedule. They
    // are separate rows here because a consultant's criteria distinguish them.
    c2c: 'C2C',
    'corp-to-corp': 'C2C',
    'corp to corp': 'C2C',
    w2: 'W2',
    'w-2': 'W2',
};

export const readWorkType = (statuses) => {
    const list = Array.isArray(statuses) ? statuses : [statuses];
    for (const raw of list) {
        const key = tidy(raw)?.toLowerCase();
        if (key && WORK_TYPE[key]) return WORK_TYPE[key];
    }
    return null;
};

/* ── pay ──────────────────────────────────────────────────────────────── */

const finite = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Does the advertised text say this is an hourly rate? */
const HOURLY_RE = /\b(?:per\s*hour|an\s*hour|\/\s*h(?:r|our)?|hourly|p\/h)\b/i;
/** ...or explicitly annual? */
const ANNUAL_RE = /\b(?:per\s*(?:year|annum)|a\s*year|\/\s*(?:yr|year)|annual(?:ly)?|p\/a)\b/i;

/**
 * Pull the numbers out of an advertised salary string.
 *
 * Handles "$70 - $90", "70-90 USD", "$140,000", "$65/hr" and the common
 * "$120k - $150k" shorthand, which is expanded rather than read as 120.
 */
export const parseSalaryString = (raw) => {
    const text = tidy(raw);
    if (!text) return null;

    const numbers = [];
    const re = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
    let m = re.exec(text);
    while (m !== null) {
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n)) numbers.push(m[2] ? n * 1000 : n);
        m = re.exec(text);
    }
    if (numbers.length === 0) return null;

    return {
        min: numbers[0],
        max: numbers.length > 1 ? numbers[1] : null,
        hourly: HOURLY_RE.test(text),
        annual: ANNUAL_RE.test(text),
    };
};

/**
 * Pay, under the same strict rule the other two adapters apply: a usable
 * amount AND a unit our column accepts, or null.
 *
 * Order matters. `salary_string` is consulted FIRST and only for its unit,
 * because it is the only place an hourly rate survives — every numeric field
 * in this schema is named `*_annual_salary`. If the text says hourly, the
 * text's own numbers are used, since the annual fields will have been
 * annualised from them and dividing back out invents precision.
 */
export const parsePay = (job) => {
    // ── OBSERVED ONLY ─────────────────────────────────────────────────
    //
    // `salary_type` is not a unit — it says where the number came from.
    // "observed" means the employer advertised it; the other values are
    // JobsPipe's own MODEL OUTPUT (the `estimated_*_annual_salary_usd` family).
    //
    // An estimate must never reach payMin/payMax, because those are compared
    // against a consultant's minimum-rate criterion. Filtering a real job out
    // — or letting a bad one through — on the strength of a guessed salary is
    // a decision made on invented data, and nothing downstream would know.
    if (job?.salary_type && job.salary_type !== 'observed') return null;

    const fromText = parseSalaryString(job?.salary_string);

    // ── ISO 4217 or nothing ──────────────────────────────────────────
    // Validated BEFORE any truncation, deliberately: slicing first turns
    // "dollars" into "DOL", which then passes a three-letter check and is
    // stored as a currency that does not exist.
    const rawCurrency = tidy(job?.salary_currency)?.toUpperCase() ?? null;
    const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;

    if (fromText?.hourly && fromText.min !== null) {
        return {
            min: fromText.min,
            max: fromText.max,
            unit: 'HOURLY',
            currency,
        };
    }

    const min = finite(job?.min_annual_salary);
    const max = finite(job?.max_annual_salary);
    if (min === null && max === null) {
        // No structured figure. The text alone is only trusted when it said
        // outright that it was annual — an unlabelled number could be either,
        // and a guessed unit survives into scoring.
        if (fromText?.annual && fromText.min !== null) {
            return { min: fromText.min, max: fromText.max, unit: 'ANNUAL', currency };
        }
        return null;
    }

    return { min, max, unit: 'ANNUAL', currency };
};

/* ── the rest ─────────────────────────────────────────────────────────── */

/**
 * Location as one string, because that is what the fingerprint hashes.
 *
 * `location` first: it is the resolved, canonical form. The assembled fallback
 * puts city before state because `normaliseLocation` keeps the first four
 * words and drops the rest — country first would push the city out of the
 * fingerprint and merge every job in the United States into one.
 */
export const readLocation = (job) => {
    const direct = tidy(job?.location) ?? tidy(job?.short_location) ?? tidy(job?.long_location);
    if (direct) return direct;

    // A CITY is required for the assembled fallback. A bare "TX" or "US" is
    // not a location — it is a region standing where a place should be, and it
    // does real damage twice over: it goes into the fingerprint, splitting one
    // job from its properly-located duplicate, and it reads as a real place to
    // the location filter. Returning null lets the caller fall back to
    // "Anywhere" on a remote role, which is both honest and correct.
    const city = Array.isArray(job?.cities) ? tidy(job.cities[0]) : null;
    if (!city) return null;

    const region = tidy(job?.state_code) ?? tidy(job?.country_code);
    return [city, region].filter(Boolean).join(', ');
};

const REMOTE_RE = /\bremote\b|\bwork from home\b|\banywhere\b|\btelecommute\b|\bdistributed\b/i;

/** Explicit flag first; the word where a place should be, second. */
export const readRemote = (job, locationText) => {
    if (job?.remote === true) return true;
    if (job?.remote === false) return false;
    return REMOTE_RE.test(`${locationText ?? ''} ${job?.job_title ?? ''}`);
};

/**
 * URLs we will store, and only those.
 *
 * http(s) only: a `javascript:` or `data:` link ends up rendered as an anchor
 * on the queue screen, and a posting is untrusted input from outside.
 */
export const sanitiseUrl = (raw) => {
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

/**
 * The published timestamp as an ISO string, or null.
 *
 * A date years out in either direction is a parsing accident, not a job posted
 * in 1970. `posted_at` gates nothing, so null is honest and costs nothing —
 * whereas a wrong date is quiet damage that only shows up later in reporting,
 * which for this trial is the entire deliverable.
 */
export const parsePostedAt = (raw, now = new Date()) => {
    if (!raw) return null;
    const date = new Date(String(raw));
    if (Number.isNaN(date.getTime())) return null;

    const yearMs = 366 * 24 * 3_600_000;
    if (date.getTime() > now.getTime() + 24 * 3_600_000) return null;
    if (date.getTime() < now.getTime() - yearMs) return null;
    return date.toISOString();
};

/**
 * When this posting can honestly be said to have existed.
 *
 * ── A FIELD THAT DOES NOT MEAN WHAT IT SAYS ───────────────────────────
 *
 * Measured against a live page of this feed, `date_posted` was in the FUTURE
 * for 11 of 25 jobs — one said 2026-09-21 while `discovered_at` said
 * 2026-08-11, six weeks EARLIER. A posting cannot be discovered before it is
 * published, so on those rows `date_posted` is not a publication date at all;
 * it is a deadline, a refresh date, or a board's own nominal field.
 *
 * Left alone this does real damage in two places:
 *
 *   freshness  a future date reads as negative age, so the worst rows in the
 *              feed sort to the top as "the freshest" — which would have made
 *              this trial's central number a straight fabrication.
 *   ageing     `posting.posted_at` drives `is_active = false` after N days, so
 *              a future-dated posting never ages out and sits in the pool for
 *              ever.
 *
 * So when the two disagree in the impossible direction, `discovered_at` wins.
 * It is the moment JobsPipe first saw the posting, which is the earliest we
 * could have acted on it — the honest answer to the question being asked.
 *
 * @returns {{ postedAt, firstSeen, suspect }}
 *   `suspect` is true when date_posted had to be overruled, so the funnel can
 *   report how much of the feed carries a date worth trusting.
 */
export const resolvePostedAt = (job, now = new Date()) => {
    // The RAW values, deliberately. parsePostedAt applies sanity guards and
    // returns null on a date nine days out — which is the right thing for the
    // column, but it destroys the evidence needed to tell "this feed sent a
    // nonsense date" apart from "this feed sent no date". Only the raw pair
    // shows the impossible ordering, so the detection has to happen first.
    const toMs = (raw) => {
        if (!raw) return null;
        const t = new Date(String(raw)).getTime();
        return Number.isNaN(t) ? null : t;
    };

    const postedMs = toMs(job?.date_posted);
    const seenMs = toMs(job?.discovered_at);
    const seen = parsePostedAt(job?.discovered_at, now);

    // Published AFTER it was discovered, or published in the future. Both are
    // impossible, and both appeared on a live page of this feed.
    const impossible = postedMs !== null
        && ((seenMs !== null && postedMs > seenMs) || postedMs > now.getTime());

    if (impossible) {
        return { postedAt: seen, firstSeen: seen, suspect: true };
    }

    const posted = parsePostedAt(job?.date_posted, now);
    return { postedAt: posted, firstSeen: seen ?? posted, suspect: false };
};

/**
 * One search-result job → the posting shape the existing pipeline consumes.
 *
 * @returns {{ posting, source, portalType, originBoard, freshness }|null}
 *   null when company, title or a usable URL is missing — the three fields a
 *   posting cannot be de-duplicated or opened without. The caller counts what
 *   this rejects, so nothing is dropped in silence.
 */
export const searchJobToPosting = (job, { now = new Date() } = {}) => {
    if (!job || typeof job !== 'object') return null;

    const company = tidy(job.company) ?? tidy(job.company_object?.name);
    const title = tidy(job.job_title) ?? tidy(job.normalized_title);
    if (!company || !title) return null;

    // `url` is the posting's own page and the one a consultant should land on.
    // `final_url` is where it redirects to, `source_url` the board it came
    // from — both acceptable, neither preferred.
    const sourceUrl = sanitiseUrl(job.url)
        ?? sanitiseUrl(job.final_url)
        ?? sanitiseUrl(job.source_url);
    if (!sourceUrl) return null;

    const locationText = readLocation(job);
    const isRemote = readRemote(job, locationText);
    const pay = parsePay(job);
    const { postedAt, firstSeen, suspect } = resolvePostedAt(job, now);

    return {
        source: SOURCE_NAME,
        // Reused from googleJobs.js rather than reimplemented: which system an
        // application is filled on is a property of the apply link's host, and
        // it decides the BOT/HUMAN lane. Two copies of that rule would put the
        // same employer in different lanes depending which door it came in.
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
            description: plain(job.description),
            sourceUrl,
            workType: readWorkType(job.employment_statuses),
            payMin: pay?.min ?? null,
            payMax: pay?.max ?? null,
            payUnit: pay?.unit ?? null,
            payCurrency: pay?.currency ?? null,
            postedAt,
            providerJobId: tidy(job.id) ?? (job.id != null ? String(job.id) : null),
        },
        // Attribution only. JobsPipe aggregates boards, and knowing a role came
        // via Indeed is useful context on the queue screen even though the
        // posting's source row is JOBSPIPE either way.
        //
        // `sources` — PLURAL, and an array of { provider, url, seen_at }. There
        // is no `source` field on a real response, so reading one (as the
        // webhook adapter's ACCEPTED_PATHS does) silently yields null on every
        // job and the attribution is quietly lost rather than visibly broken.
        originBoard: tidy(job.sources?.[0]?.provider) ?? null,
        // What the trial is actually measuring — see resolvePostedAt for why
        // `datePosted` is not simply `job.date_posted`.
        freshness: {
            datePosted: postedAt,
            rawDatePosted: job.date_posted ?? null,
            discoveredAt: job.discovered_at ?? null,
            firstSeen,
            // True when date_posted claimed to be LATER than discovered_at and
            // had to be overruled. The share of a page that is suspect is
            // itself a finding about the feed.
            suspectDate: suspect,
            reposted: job.reposted ?? null,
        },
    };
};
