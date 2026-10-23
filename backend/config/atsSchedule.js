/**
 * ── HOW OFTEN TO LOOK AT EACH BOARD ───────────────────────────────────
 *
 * Pure policy, no I/O — the same shape as `jobMatcher.js` and `queueStates.js`,
 * so the rules are declared once and tested without a database.
 *
 * ── THE IDEA ──────────────────────────────────────────────────────────
 *
 * A fixed interval is wrong in both directions. Poll everything every minute
 * and you hammer 20,000 employers who publish a job a month; poll everything
 * hourly and you are an hour late on the ones that publish every ten minutes.
 *
 * So each board's interval ADAPTS to what it just did:
 *
 *   it changed         → snap to the fastest the policy allows. A board that
 *                        just posted is the likeliest to post again (companies
 *                        publish in batches).
 *   it did not change  → slow by half again, towards the ceiling. Most polls
 *                        are 304s and cost almost nothing, but "almost" times
 *                        20,000 is not nothing.
 *   it failed          → double, capped. Back off from a host having a bad
 *                        minute rather than hammering it.
 *
 * Bounded below by the larger of the agency's minimum and the FAMILY's minimum
 * (Ashby is CDN-cached for 60s; Workday has no ETag and is held to 5 minutes),
 * and above by the agency's maximum. A PRIORITY board ignores the quiet-board
 * slowdown and is held at its floor.
 *
 * A little random jitter on every next-poll time stops boards that were all
 * added in one batch from polling in lockstep forever.
 */

export const DEFAULTS = {
    minIntervalS: 120,
    maxIntervalS: 21_600,         // 6 h
    errorCeilingS: 21_600,        // never back off past 6 h on errors
    slowdownFactor: 1.5,
    errorFactor: 2,
    jitter: 0.1,                  // ±10 %
    /** After this many consecutive NOT_FOUND polls the board is parked. */
    parkAfterNotFound: 5,
};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** The lowest interval this board may ever have. */
export const floorFor = ({ minIntervalS, familyMinS, isPriority }) => {
    const family = familyMinS ?? 60;
    // A priority board is the one place the agency's own minimum is overridden
    // — to the FAMILY's floor, never below it.
    return isPriority ? family : Math.max(minIntervalS ?? DEFAULTS.minIntervalS, family);
};

/**
 * What to wait before the next poll of this board.
 *
 * @param {object} p
 * @param {number}  p.intervalS     the interval just used
 * @param {'changed'|'unchanged'|'error'|'not_found'} p.result
 * @param {boolean} [p.isPriority]
 * @param {number}  [p.minIntervalS]  agency minimum
 * @param {number}  [p.maxIntervalS]  agency maximum
 * @param {number}  [p.familyMinS]    the family's floor (lkp_ats_families)
 * @param {number}  [p.retryAfterS]   a Retry-After the host sent
 * @returns {number} seconds, an integer, jitter NOT applied
 */
export const nextIntervalS = ({
    intervalS, result, isPriority = false,
    minIntervalS = DEFAULTS.minIntervalS,
    maxIntervalS = DEFAULTS.maxIntervalS,
    familyMinS = 60,
    retryAfterS = null,
}) => {
    const floor = floorFor({ minIntervalS, familyMinS, isPriority });
    const ceiling = Math.max(maxIntervalS, floor);
    const current = Math.max(intervalS ?? floor, floor);

    let next;
    switch (result) {
        case 'changed':
            next = floor;
            break;
        case 'unchanged':
            next = isPriority ? floor : current * DEFAULTS.slowdownFactor;
            break;
        case 'error':
            next = Math.max(current * DEFAULTS.errorFactor, retryAfterS ?? 0);
            return Math.round(clamp(next, floor, Math.max(DEFAULTS.errorCeilingS, retryAfterS ?? 0)));
        case 'not_found':
            // A missing board does not become present in a minute.
            next = Math.max(current * 4, 3600);
            return Math.round(clamp(next, floor, DEFAULTS.errorCeilingS));
        default:
            next = current;
    }
    return Math.round(clamp(next, floor, ceiling));
};

/** Spread a number of seconds by ±jitter. `rand` is injectable for tests. */
export const withJitter = (seconds, rand = Math.random, jitter = DEFAULTS.jitter) => {
    const factor = 1 + (rand() * 2 - 1) * jitter;
    return Math.max(1, Math.round(seconds * factor));
};

/** True once enough consecutive NOT_FOUNDs say the board is gone. */
export const shouldPark = (consecutiveNotFound) => consecutiveNotFound >= DEFAULTS.parkAfterNotFound;

/**
 * Plain-English cadence for the screen: 90 → "every 2 min", 21600 → "every 6 h".
 * Lives here, not in the UI, so the wording cannot drift from the numbers.
 */
export const describeInterval = (seconds) => {
    const s = Math.round(Number(seconds) || 0);
    if (s < 90) return `every ${s}s`;
    if (s < 5400) return `every ${Math.round(s / 60)} min`;
    if (s < 172_800) return `every ${Math.round(s / 3600)} h`;
    return `every ${Math.round(s / 86_400)} d`;
};

/**
 * Which band a board sits in, for the badge on the registry. Derived from the
 * interval it has settled at, not stored — so it can never disagree with the
 * schedule actually being run.
 */
export const tierOf = (intervalS, floorS) => {
    if (intervalS <= floorS * 1.25) return 'HOT';
    if (intervalS <= 900) return 'WARM';
    if (intervalS <= 7200) return 'COOL';
    return 'COLD';
};
