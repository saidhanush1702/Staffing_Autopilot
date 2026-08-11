/**
 * ── GOOGLE JOBS → THE COMMON POSTING SHAPE ────────────────────────────
 *
 * Pure. No I/O, no database, no configuration. One `jobs_results` entry in, one
 * posting out, or null when the entry cannot be trusted.
 *
 * The shape produced here is byte-for-byte the shape the v1 scraping
 * connectors produced, which is why nothing downstream — fingerprinting,
 * matching, caps, the queue — changed when the acquisition method did.
 *
 * ── WHY THIS IS SEPARATE FROM serpapi.js ──────────────────────────────
 *
 * serpapi.js is shaped like a vendor: keys, credits, pagination tokens.
 * This file is shaped like Google Jobs, which is what several vendors resell.
 * Swapping vendor touches the other file; this one only changes if Google
 * changes what a job result looks like.
 */
import { plain, tidy } from './text.js';

/* ── attribution ──────────────────────────────────────────────────────── */
//
// Two different questions get answered here, and conflating them was the
// mistake worth avoiding:
//
//   SOURCE      which board listed this job     ← Google's `via` line
//   PORTAL TYPE which system you apply through  ← the apply link's host
//
// They are frequently different. A job can be listed on LinkedIn (source) but
// apply through Greenhouse (portal type). The first answers "where did this
// come from"; the second is what a later phase needs in order to fill the form.
//
// NOTHING IS DISCARDED ON EITHER AXIS. The five named boards are the priority
// set, not an allowlist — everything Google returns is a real job and is kept.
// Unrecognised attribution resolves to OTHER / COMPANY_SITE and flows on.

/**
 * The five named boards, first and in priority order, then the aggregators
 * Google Jobs surfaces most often.
 *
 * `via` is a display string and Google is inconsistent with it — the same board
 * appears as "via LinkedIn", "via Linkedin Jobs", "via Built In", "via BuiltIn
 * Chicago". So `via` is the first signal and the apply-link host is the
 * corroborating one: a link pointing at linkedin.com is LinkedIn whatever the
 * label says.
 */
const SOURCES = [
    { name: 'LINKEDIN', priority: true, via: ['linkedin'], hosts: ['linkedin.com'] },
    {
        name: 'WELLFOUND',
        priority: true,
        via: ['wellfound', 'angellist', 'angel.co'],
        hosts: ['wellfound.com', 'angel.co', 'angellist.com'],
    },
    // Built In runs a site per market — builtinchicago.org, builtinnyc.com,
    // builtinaustin.com and a dozen more. They are one board.
    {
        name: 'BUILTIN',
        priority: true,
        via: ['built in', 'builtin'],
        hosts: ['builtin.com', 'builtinchicago.org', 'builtinnyc.com', 'builtinaustin.com',
            'builtinla.com', 'builtinboston.com', 'builtincolorado.com', 'builtinseattle.com',
            'builtinsf.com'],
    },
    { name: 'THELADDERS', priority: true, via: ['ladders'], hosts: ['theladders.com'] },
    { name: 'CRUNCHBOARD', priority: true, via: ['crunchboard'], hosts: ['crunchboard.com'] },

    // Everything below is bonus coverage the crawler era could never reach.
    { name: 'INDEED', via: ['indeed'], hosts: ['indeed.com'] },
    { name: 'GLASSDOOR', via: ['glassdoor'], hosts: ['glassdoor.com'] },
    { name: 'ZIPRECRUITER', via: ['ziprecruiter'], hosts: ['ziprecruiter.com'] },
    { name: 'DICE', via: ['dice'], hosts: ['dice.com'] },
    { name: 'MONSTER', via: ['monster'], hosts: ['monster.com'] },
    { name: 'SIMPLYHIRED', via: ['simplyhired'], hosts: ['simplyhired.com'] },
    { name: 'TALENT_COM', via: ['talent.com'], hosts: ['talent.com'] },
    { name: 'JOOBLE', via: ['jooble'], hosts: ['jooble.org'] },
    { name: 'CAREERBUILDER', via: ['careerbuilder'], hosts: ['careerbuilder.com'] },
    { name: 'SNAGAJOB', via: ['snagajob'], hosts: ['snagajob.com'] },
    { name: 'GREENHOUSE_BOARD', via: ['greenhouse'], hosts: [] },
    { name: 'LEVER_BOARD', via: ['lever'], hosts: [] },
];

/**
 * Applicant tracking systems, recognised by the host you apply on.
 *
 * This is the field a later phase reads to decide HOW to fill a form —
 * a Workday form and a Greenhouse form share nothing. Recording it now, while
 * the data is in front of us, costs one lookup; recovering it later would mean
 * re-fetching every posting.
 */
const PORTAL_TYPES = [
    { name: 'GREENHOUSE', hosts: ['greenhouse.io'] },
    { name: 'LEVER', hosts: ['lever.co'] },
    { name: 'WORKDAY', hosts: ['myworkdayjobs.com', 'workday.com', 'myworkdaysite.com'] },
    { name: 'ASHBY', hosts: ['ashbyhq.com'] },
    { name: 'SMARTRECRUITERS', hosts: ['smartrecruiters.com'] },
    { name: 'ICIMS', hosts: ['icims.com'] },
    { name: 'TALEO', hosts: ['taleo.net'] },
    { name: 'JOBVITE', hosts: ['jobvite.com'] },
    { name: 'WORKABLE', hosts: ['workable.com'] },
    { name: 'BAMBOOHR', hosts: ['bamboohr.com'] },
    { name: 'RECRUITEE', hosts: ['recruitee.com'] },
    { name: 'BREEZY', hosts: ['breezy.hr'] },
    // Boards you can apply on without leaving them.
    { name: 'LINKEDIN', hosts: ['linkedin.com'] },
    { name: 'WELLFOUND', hosts: ['wellfound.com', 'angel.co'] },
    { name: 'BUILTIN', hosts: ['builtin.com'] },
    { name: 'THELADDERS', hosts: ['theladders.com'] },
    { name: 'CRUNCHBOARD', hosts: ['crunchboard.com'] },
    { name: 'INDEED', hosts: ['indeed.com'] },
    { name: 'GLASSDOOR', hosts: ['glassdoor.com'] },
    { name: 'ZIPRECRUITER', hosts: ['ziprecruiter.com'] },
    { name: 'DICE', hosts: ['dice.com'] },
    { name: 'MONSTER', hosts: ['monster.com'] },
];

const hostOf = (url) => {
    try {
        return new URL(url).host.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
};

const matchesHost = (host, candidates) =>
    Boolean(host) && candidates.some((h) => host === h || host.endsWith(`.${h}`));

/** The named boards, in the priority order the specification gives them. */
export const PRIORITY_SOURCES = SOURCES.filter((s) => s.priority).map((s) => s.name);

/**
 * Which board surfaced this posting, and the best link to apply on.
 *
 * @returns {{ source: string, applyUrl: string|null }}
 */
export const detectSource = (result) => {
    const via = String(result?.via ?? '').toLowerCase().replace(/^via\s+/, '');
    const options = (Array.isArray(result?.apply_options) ? result.apply_options : [])
        .filter((o) => o && typeof o.link === 'string');

    let source = SOURCES.find((c) => c.via.some((token) => via.includes(token))) ?? null;

    // `via` said nothing we recognise — ask the apply links instead.
    if (!source) {
        for (const option of options) {
            const found = SOURCES.find((c) => matchesHost(hostOf(option.link), c.hosts));
            if (found) { source = found; break; }
        }
    }

    // Prefer the apply link belonging to the detected board, so the stored URL
    // is the one a person would actually open. Google's own share_link is a
    // search-results page — a last resort, not a destination.
    const onSource = source
        ? options.find((o) => matchesHost(hostOf(o.link), source.hosts))?.link
        : null;

    return {
        source: source?.name ?? 'OTHER',
        applyUrl: onSource ?? options[0]?.link ?? result?.share_link ?? null,
    };
};

/**
 * Which system the application is actually filled on.
 *
 * Falls back to COMPANY_SITE rather than OTHER: an apply link on a host that is
 * neither a known board nor a known ATS is, overwhelmingly, the employer's own
 * careers page. That is a more useful default than a shrug, and it is right far
 * more often than it is wrong.
 */
export const detectPortalType = (applyUrl) => {
    const host = hostOf(applyUrl);
    if (!host) return 'OTHER';
    return PORTAL_TYPES.find((p) => matchesHost(host, p.hosts))?.name ?? 'COMPANY_SITE';
};

/* ── pay ──────────────────────────────────────────────────────────────── */

// A bare `hr` is deliberately not a unit marker: "HR" is Human Resources far
// more often than it is "hour", and mislabelling an annual salary as hourly is
// the exact failure the strict rule below exists to prevent.
const UNITS = [
    [/\b(?:an?\s+hour|per\s+hour|hourly|\/\s*hr\b)/i, 'HOURLY'],
    [/\b(?:a\s+year|per\s+year|annually|yearly|\/\s*yr\b)/i, 'ANNUAL'],
];

// Longest symbol first — otherwise "C$120K" matches plain "$" and is recorded
// as US dollars.
const CURRENCY = [['C$', 'CAD'], ['A$', 'AUD'], ['$', 'USD'], ['£', 'GBP'], ['€', 'EUR'], ['₹', 'INR']];

/**
 * "$120K–$150K a year" → { min: 120000, max: 150000, unit: 'ANNUAL' }
 *
 * ── THE STRICT RULE ───────────────────────────────────────────────────
 *
 * Returns null unless BOTH an amount and a unit are recovered. This is the same
 * rule v1 applied to JSON-LD salaries and it is not caution for its own sake:
 * the minimum-pay filter compares raw numbers, so an hourly rate that loses its
 * unit gets measured against an annual floor and silently discards every good
 * contract role. A null costs one scoring signal. A wrong unit costs the
 * consultant jobs, invisibly.
 *
 * Monthly and weekly pay also return null — the schema stores HOURLY or ANNUAL,
 * and converting a monthly figure would be inventing an annual salary that the
 * employer never advertised.
 */
export const parsePay = (input) => {
    const text = tidy(input);
    if (!text) return null;

    const unit = UNITS.find(([re]) => re.test(text))?.[1] ?? null;
    if (!unit) return null;

    // Numbers only where they read as money: a bare figure with an optional K/M
    // suffix. Anchoring on the digits rather than the currency symbol keeps
    // "35–40 an hour" parseable, which Google does emit.
    //
    // Only the FIRST TWO are taken. Google states the range first and anything
    // after it is prose — and prose about compensation reliably contains
    // "401k", which would otherwise parse as $401,000 and become the maximum.
    const amounts = [];
    const re = /(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?/g;
    let m = re.exec(text);
    while (m !== null && amounts.length < 2) {
        let value = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(value)) {
            const suffix = (m[2] ?? '').toUpperCase();
            if (suffix === 'K') value *= 1_000;
            if (suffix === 'M') value *= 1_000_000;
            amounts.push(value);
        }
        m = re.exec(text);
    }
    if (amounts.length === 0) return null;

    const currency = CURRENCY.find(([symbol]) => text.includes(symbol))?.[1] ?? 'USD';

    // "Up to $180K" advertises a ceiling with no floor; "From $100K" the
    // reverse. Recording either as both ends would fabricate a range.
    if (/\bup\s+to\b/i.test(text)) {
        return { min: null, max: Math.max(...amounts), unit, currency };
    }
    if (/\b(?:from|starting\s+at|at\s+least)\b/i.test(text)) {
        return { min: Math.min(...amounts), max: null, unit, currency };
    }

    return {
        min: Math.min(...amounts),
        max: Math.max(...amounts),
        unit,
        currency,
    };
};

/** The salary string, wherever this result happens to carry it. */
const findSalaryText = (result) => {
    const detected = result?.detected_extensions?.salary;
    if (detected) return detected;

    // Older results and some verticals put it loose in `extensions` instead.
    const extensions = Array.isArray(result?.extensions) ? result.extensions : [];
    return extensions.find((e) => UNITS.some(([re]) => re.test(String(e)))
        && /\d/.test(String(e))) ?? null;
};

/* ── posted date ──────────────────────────────────────────────────────── */

const RELATIVE_MS = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,      // 30 days — Google's own granularity here
    year: 31_536_000_000,
};

/**
 * "3 days ago" → a timestamp, measured from `now`.
 *
 * Google never gives an absolute date here, so this is an approximation by
 * construction. It is used for display and recency ordering, never for
 * de-duplication, so being a few hours out is harmless. `now` is injectable
 * so the tests are not clock-dependent.
 */
export const parsePostedAt = (input, now = new Date()) => {
    const text = tidy(input)?.toLowerCase();
    if (!text) return null;

    if (/just\s+posted|today|^new$/.test(text)) return new Date(now);

    // "30+ days ago" — the plus is a floor, so treat it as exactly 30.
    const m = text.match(/(\d+)\s*\+?\s*(minute|hour|day|week|month|year)s?\s+ago/);
    if (m) {
        const ms = RELATIVE_MS[m[2]];
        return ms ? new Date(now.getTime() - Number(m[1]) * ms) : null;
    }

    // "an hour ago", "a day ago"
    const single = text.match(/\ban?\s+(minute|hour|day|week|month|year)\s+ago/);
    if (single) {
        const ms = RELATIVE_MS[single[1]];
        return ms ? new Date(now.getTime() - ms) : null;
    }

    return null;
};

/* ── work type ────────────────────────────────────────────────────────── */

/** Google's `schedule_type` vocabulary → our lkp_work_types names. */
const WORK_TYPE = {
    'full-time': 'FULL_TIME',
    fulltime: 'FULL_TIME',
    'full time': 'FULL_TIME',
    'part-time': 'PART_TIME',
    parttime: 'PART_TIME',
    'part time': 'PART_TIME',
    contractor: 'CONTRACT',
    contract: 'CONTRACT',
    'contract to hire': 'CONTRACT',
    temporary: 'CONTRACT',
    'temp work': 'CONTRACT',
};

const readWorkType = (result) => {
    const raw = result?.detected_extensions?.schedule_type;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const entry of list) {
        const key = tidy(entry)?.toLowerCase();
        if (key && WORK_TYPE[key]) return WORK_TYPE[key];
    }
    return null;
};

/* ── description ──────────────────────────────────────────────────────── */

/**
 * The description, with `job_highlights` appended.
 *
 * Highlights carry the qualifications and responsibilities as bullet lists, and
 * on results where Google truncates the main description they are often the
 * only place a required skill is named. Since include/exclude keywords are
 * matched against this text, leaving them out would quietly weaken every
 * consultant's criteria.
 */
const buildDescription = (result) => {
    const parts = [];
    const body = plain(result?.description);
    if (body) parts.push(body);

    const highlights = Array.isArray(result?.job_highlights) ? result.job_highlights : [];
    for (const group of highlights) {
        const items = Array.isArray(group?.items) ? group.items.filter(Boolean) : [];
        if (items.length === 0) continue;
        const heading = tidy(group?.title);
        parts.push(`${heading ? `${heading}:\n` : ''}${items.map((i) => `• ${plain(i) ?? i}`).join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
};

/* ── the adapter ──────────────────────────────────────────────────────── */

const REMOTE_RE = /\bremote\b|\bwork from home\b|\banywhere\b|\btelecommute\b/i;

/**
 * One Google Jobs result → a posting, the board that surfaced it, and the
 * system it is applied through.
 *
 * Returns null when `company_name` or `title` is missing. Those two are
 * two-thirds of the R-15 fingerprint, so a result without them cannot be
 * de-duplicated and would corrupt the pool rather than enrich it. The caller
 * quarantines what this rejects — nothing is dropped in silence.
 *
 * @returns {{ posting, source, portalType }|null}
 */
export const jobResultToPosting = (result, { now = new Date() } = {}) => {
    if (!result || typeof result !== 'object') return null;

    const company = tidy(result.company_name);
    const title = tidy(result.title);
    if (!company || !title) return null;

    // `source_url` is NOT NULL, and a posting nobody can open is not a lead.
    const { source, applyUrl } = detectSource(result);
    if (!applyUrl) return null;

    const locationText = tidy(result.location);
    const workFromHome = result.detected_extensions?.work_from_home === true;
    const pay = parsePay(findSalaryText(result));

    return {
        source,
        portalType: detectPortalType(applyUrl),
        posting: {
            company,
            title,
            // "Anywhere" rather than null: the fingerprint includes location,
            // and a remote job with an empty location would collide with every
            // other remote job at the same company with the same title —
            // which, for once, is the correct merge.
            locationText: locationText ?? (workFromHome ? 'Anywhere' : null),
            isRemote: workFromHome
                || REMOTE_RE.test(`${locationText ?? ''} ${title}`),
            description: buildDescription(result),
            sourceUrl: applyUrl,
            workType: readWorkType(result),
            payMin: pay?.min ?? null,
            payMax: pay?.max ?? null,
            payUnit: pay?.unit ?? null,
            payCurrency: pay?.currency ?? null,
            postedAt: parsePostedAt(result.detected_extensions?.posted_at, now)?.toISOString() ?? null,
            providerJobId: tidy(result.job_id),
        },
    };
};

/** Everything parseable in one response. The orchestrator's happy path. */
export const resultsToPostings = (results, options) =>
    (Array.isArray(results) ? results : [])
        .map((r) => jobResultToPosting(r, options))
        .filter(Boolean);

export const __test = {
    findSalaryText, readWorkType, buildDescription, hostOf, SOURCES, PORTAL_TYPES,
};
