/**
 * ── HELPERS EVERY ATS ADAPTER SHARES ──────────────────────────────────
 *
 * The five families disagree about almost everything — field names, date
 * formats, whether the description is in the list — but they all have to hand
 * the existing pipeline the SAME posting shape, and they all have to obey the
 * same rule the JobsPipe adapter states in its header: return null rather than
 * guess. A wrong pay unit survives into scoring; a wrong date corrupts the one
 * figure this feature is judged on. An absent value does neither.
 */
import { createHash } from 'node:crypto';
import { plain, tidy } from '../text.js';
import { sanitiseUrl } from '../jobspipeSearch.js';

export { plain, tidy, sanitiseUrl };

export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

/* ── text ─────────────────────────────────────────────────────────────── */

const ENTITIES = [
    [/&lt;/g, '<'], [/&gt;/g, '>'], [/&quot;/g, '"'], [/&#39;|&apos;/g, "'"],
    [/&nbsp;/g, ' '], [/&amp;/g, '&'],
];

/** Decode the entities of a string that is HTML which was escaped as text. */
export const decodeEntities = (s) => ENTITIES.reduce((acc, [re, to]) => acc.replace(re, to), String(s ?? ''));

/**
 * HTML → readable text.
 *
 * `escaped` is for Greenhouse, whose `content` is HTML that has been
 * entity-ESCAPED ("&lt;p&gt;…"). The shared `plain()` strips tags and only then
 * decodes entities, so handed that string it finds no tags to strip and returns
 * the markup as text — measured on a real Airbnb posting. Decoding first makes
 * the tags real, and `plain()` then removes them.
 */
export const htmlToText = (html, { escaped = false } = {}) => {
    if (!html) return null;
    return plain(escaped ? decodeEntities(html) : html);
};

/* ── dates ────────────────────────────────────────────────────────────── */

const EARLIEST = Date.UTC(2000, 0, 1);
const DAY_MS = 86_400_000;

/**
 * An ISO timestamp, or null.
 *
 * Rejects only IMPOSSIBLE dates: in the future (beyond a day's clock skew) or
 * before 2000. It does NOT reject old ones, unlike the JobsPipe helper's
 * one-year floor — that guard exists for an aggregator's unreliable dates, but
 * an ATS date is the employer's own. Measured: 171 of Palantir's 299 jobs and
 * 57 of OpenAI's 804 are over a year old with real dates, and discarding them
 * would make a re-listed old requisition look undated, which the diff treats as
 * new.
 */
export const isoOrNull = (raw, now = new Date()) => {
    if (raw === null || raw === undefined || raw === '') return null;
    // Lever sends epoch milliseconds as a number.
    const t = typeof raw === 'number' ? raw : Date.parse(String(raw));
    if (!Number.isFinite(t)) return null;
    if (t < EARLIEST || t > now.getTime() + DAY_MS) return null;
    return new Date(t).toISOString();
};

/** 'YYYY-MM-DD' (a day, no time) or null. */
export const dayOrNull = (raw) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? ''));
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/* ── what kind of job ─────────────────────────────────────────────────── */

const REMOTE_RE = /\bremote\b|\bwork from home\b|\banywhere\b|\btelecommute\b/i;
export const looksRemote = (...texts) => REMOTE_RE.test(texts.filter(Boolean).join(' '));

/**
 * Work type from a TITLE, for the families that publish no employment type
 * (Greenhouse). Deliberately narrow: only words that name an engagement
 * outright. `scoreMatch` subtracts 10 for a mismatch, so guessing "FULL_TIME"
 * for a contract role would push it away from exactly the contractors it
 * suits — absent is better than wrong.
 */
export const workTypeFromTitle = (title) => {
    const t = String(title ?? '').toLowerCase();
    if (/\b(c2c|corp[- ]to[- ]corp)\b/.test(t)) return 'C2C';
    if (/\bw-?2\b/.test(t)) return 'W2';
    if (/\b(contract(or)?|contract[- ]to[- ]hire|c2h|freelance|temporary)\b/.test(t)) return 'CONTRACT';
    if (/\bpart[- ]time\b/.test(t)) return 'PART_TIME';
    return null;
};

/* ── pay ──────────────────────────────────────────────────────────────── */

const isMoney = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Pay, or null.
 *
 * The plausibility bounds are the guard against a unit that is wrong rather
 * than absent: a figure called ANNUAL that is under 5,000, or called HOURLY
 * and over 1,000, is almost certainly the other unit. It is dropped, not
 * "corrected" — the same refusal parsePay makes in the JobsPipe adapter.
 */
export const normalisePay = ({ min, max, unit, currency }) => {
    const lo = isMoney(min) ? min : null;
    const hi = isMoney(max) ? max : null;
    if (lo === null && hi === null) return null;
    if (unit !== 'HOURLY' && unit !== 'ANNUAL') return null;

    const top = Math.max(lo ?? 0, hi ?? 0);
    if (unit === 'ANNUAL' && top < 5_000) return null;
    if (unit === 'HOURLY' && top > 1_000) return null;
    if (lo !== null && hi !== null && lo > hi) return null;

    const ccy = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)
        ? currency.toUpperCase() : null;

    return { min: lo, max: hi, unit, currency: ccy };
};

/* ── names ────────────────────────────────────────────────────────────── */

/**
 * 'accenture-federal-services' → 'Accenture Federal Services'.
 *
 * A LAST RESORT for the company name. The fingerprint hashes the normalised
 * company, so "accenturefederalservices" and "Accenture Federal Services" are
 * two different companies to R-15 and the same job would reach a consultant
 * through two doors. The registry therefore asks for a real name and flags a
 * board that has only this.
 */
export const humaniseKey = (key) => String(key ?? '')
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');

/** A title with the leading/trailing space some boards pad it with removed. */
export const cleanTitle = (t) => tidy(t);
