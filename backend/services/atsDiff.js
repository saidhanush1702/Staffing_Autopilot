/**
 * ── WHAT CHANGED ON A BOARD ───────────────────────────────────────────
 *
 * The heart of the mirror and, deliberately, free of I/O: given what a board
 * lists NOW and what we remembered LAST time, decide which jobs are new, which
 * are gone, and which are merely the same.
 *
 * Everything that makes this subtle is a way to be wrong in a way that costs
 * something real:
 *
 *   FIRST CONTACT IS NOT NEWS. The first read of Stripe's board returns 725
 *   jobs that have been open for months. Treating them as new would flood every
 *   consultant's queue with stale roles on day one. So the first poll is the
 *   BASELINE: everything is recorded, and only jobs provably published inside
 *   the agency's bootstrap window are candidates.
 *
 *   "NEW" IS DECIDED BY ID, NEVER BY A TIMESTAMP. Greenhouse's `updated_at`
 *   moves whenever an employer edits a job; a recruiter fixing a typo in a
 *   year-old posting must not make it a fresh one. Same lesson as the SerpApi
 *   plan's "late is not old": the question is "have WE seen this", not "when
 *   does the vendor say it happened".
 *
 *   A MISSING JOB IS NOT A CLOSED JOB. One truncated response, one flaky CDN
 *   node, and half a board vanishes for a minute. So a job closes only after
 *   TWO consecutive complete reads without it, a read that is only the top of a
 *   newest-first list (Workday, SmartRecruiters) never closes anything, and a
 *   read in which most of the board disappears at once is treated as a bad
 *   read, not a mass layoff.
 *
 *   A RE-LISTED JOB IS NOT NEW. Rows are never deleted: a closed job that
 *   reappears is REOPENED, not re-ingested, so a board that flaps does not
 *   re-queue the same role every time.
 */

/** A job published longer ago than this is not news, however new it is to us. */
export const MAX_NEW_AGE_DAYS = Number(process.env.ATS_MAX_NEW_AGE_DAYS ?? 14);

/** Consecutive complete reads without a job before it counts as closed. */
export const CLOSE_AFTER_MISSES = 2;

/** Above this share of the open board vanishing at once, distrust the read. */
export const MASS_DISAPPEARANCE_SHARE = 0.5;
/** …but only on boards big enough for a share to mean something. */
export const MASS_DISAPPEARANCE_MIN_OPEN = 6;

const HOUR = 3_600_000;

/**
 * Is this item PROVABLY published within `windowHours`?
 *
 * Strict by design: "unknown" is not "fresh". This gates what a first contact
 * is allowed to ingest, and ingesting a stale job costs more than skipping a
 * fresh one the next poll will see anyway.
 *
 * Uses, in order of how much it proves:
 *   publishedAt     an exact instant                         → exact comparison
 *   publishedDay    a calendar day (Workday "Posted Today")  → counts if that
 *                   day ENDED inside the window
 *
 * Greenhouse's `updated_at` is deliberately NOT consulted: it moves whenever an
 * employer edits a job, so it can only bound a job's age from above and never
 * prove it fresh. (Its list carries `first_published`, which does.)
 */
export const isFresh = (item, windowHours, now = new Date()) => {
    const limit = now.getTime() - windowHours * HOUR;

    if (item.publishedAt) return new Date(item.publishedAt).getTime() >= limit;

    if (item.publishedDay) {
        const endOfDay = new Date(`${item.publishedDay}T23:59:59.999Z`).getTime();
        return endOfDay >= limit;
    }

    return false;
};

/** Known to be older than the "still news" age. Unknown age → not old. */
export const isStale = (item, now = new Date(), maxDays = MAX_NEW_AGE_DAYS) => {
    const limit = now.getTime() - maxDays * 24 * HOUR;
    if (item.publishedAt) return new Date(item.publishedAt).getTime() < limit;
    if (item.publishedDay) {
        return new Date(`${item.publishedDay}T23:59:59.999Z`).getTime() < limit;
    }
    return false;
};

/**
 * Seconds from publication to our first sight of the job — the number this
 * whole feature exists to shrink.
 *
 * NULL when it would not be a measurement:
 *   · publication time unknown, or only a DAY (a midnight guess would inflate
 *     every figure by up to 24 h)
 *   · the baseline poll, because we were not watching, so "how long until we
 *     noticed" has no meaning for jobs that were already open.
 * Negative values (employer clock skew) are clamped to zero.
 */
export const latencySeconds = (item, detectedAt, { isBootstrap = false } = {}) => {
    if (isBootstrap || !item.publishedAt) return null;
    const diff = (new Date(detectedAt).getTime() - new Date(item.publishedAt).getTime()) / 1000;
    return Number.isFinite(diff) ? Math.max(0, Math.round(diff)) : null;
};

/**
 * @param {object}   p
 * @param {object[]} p.items       normalised list items from the adapter
 * @param {Map<string,{state,closed_at,missed_polls}>} p.known   rows we hold, by ext_id
 * @param {boolean}  p.complete    did the read cover the whole board?
 * @param {boolean}  p.isBootstrap first successful read of this board
 * @param {number}   p.bootstrapAgeHours
 * @param {Date}     [p.now]
 *
 * @returns {{
 *   candidates: object[],   new items worth ingesting (newest first)
 *   baseline:   object[],   new items recorded silently
 *   seen:       string[],   ids already held and present now
 *   reopened:   string[],   closed ids that are back
 *   missed:     string[],   open ids absent from a COMPLETE read
 *   toClose:    string[],   ids that have now missed enough reads to close
 *   suspicious: boolean,    most of the board vanished — distrust this read
 * }}
 */
export const diffBoard = ({
    items, known, complete, isBootstrap, bootstrapAgeHours = 48, now = new Date(),
}) => {
    const seen = [];
    const reopened = [];
    const baseline = [];
    const candidates = [];
    const present = new Set();

    for (const item of items) {
        if (!item?.extId) continue;
        // A board listing the same id twice (Workable does it per location) is
        // one job.
        if (present.has(item.extId)) continue;
        present.add(item.extId);

        const row = known.get(item.extId);
        if (row) {
            seen.push(item.extId);
            if (row.closed_at) reopened.push(item.extId);
            continue;
        }

        if (isBootstrap) {
            const eligible = isFresh(item, bootstrapAgeHours, now);
            (eligible ? candidates : baseline).push(item);
        } else {
            (isStale(item, now) ? baseline : candidates).push(item);
        }
    }

    // Newest first, so a cap on ingestion keeps the freshest jobs. Unknown
    // dates sort last — and among themselves keep the board's own order.
    candidates.sort((a, b) => {
        const ta = a.publishedAt ? Date.parse(a.publishedAt) : (a.publishedDay ? Date.parse(a.publishedDay) : 0);
        const tb = b.publishedAt ? Date.parse(b.publishedAt) : (b.publishedDay ? Date.parse(b.publishedDay) : 0);
        return tb - ta;
    });

    /* ── removals: only from a COMPLETE read ───────────────────────── */
    let missed = [];
    let toClose = [];
    let suspicious = false;

    if (complete && !isBootstrap) {
        const open = [...known.entries()].filter(([, r]) => !r.closed_at && r.state !== undefined);
        missed = open.filter(([id]) => !present.has(id)).map(([id]) => id);

        const share = open.length === 0 ? 0 : missed.length / open.length;
        if (open.length >= MASS_DISAPPEARANCE_MIN_OPEN && share > MASS_DISAPPEARANCE_SHARE) {
            // Looks like a truncated or wrong response. Count nothing against
            // any job; the next read will say.
            suspicious = true;
            missed = [];
        } else {
            toClose = missed.filter((id) => (known.get(id).missed_polls ?? 0) + 1 >= CLOSE_AFTER_MISSES);
        }
    }

    return { candidates, baseline, seen, reopened, missed, toClose, suspicious };
};
