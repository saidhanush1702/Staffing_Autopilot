/**
 * ── THE QUEUE STATE MACHINE ───────────────────────────────────────────
 *
 * Every legal move a queue item can make, declared once, as data.
 *
 * Migration 022 named this file in its own comment and it was never written,
 * so until now "the state machine" existed only as a table of status names with
 * nothing enforcing the order between them. A status column with no transition
 * rules is how `SUBMITTED` ends up preceding `FILLING` in a history nobody can
 * explain — and this history is the evidence trail behind a real application
 * sent to a real employer in someone's name.
 *
 * ── WHY ONE TABLE AND NOT CHECKS PER ENDPOINT ─────────────────────────
 *
 * Every route that moves an item calls the same guard. The alternative — each
 * endpoint knowing which states it may act on — is how `requeue` and
 * `transition` end up disagreeing about whether a submitted item can be
 * reopened. When the desktop app arrives it calls these same endpoints and
 * obeys the same table, without a second copy of the rules living on the
 * consultant's machine.
 *
 * ── THE PIPELINE ──────────────────────────────────────────────────────
 *
 *   QUEUED ──► READY ──► FILLING ──► AWAITING_REVIEW ──► SUBMITTED
 *      │          │ ▲          │               │
 *      │          │ │          └──► PARKED_UNKNOWN
 *      │          ▼ │                          │
 *      │      PREPARING ──► RESUME_REVIEW      ─┘  (answer approved)
 *      │      (tailoring, on request)
 *      └──► SKIPPED ──► QUEUED        CANCELLED reachable from anywhere live
 *
 * TAILORING IS ASKED FOR, NOT AUTOMATIC. A found job goes QUEUED ──► READY
 * carrying the base resume, and the desktop app may apply to it at once. If a
 * person selects the job for tailoring while it is still READY, it steps back
 * READY ──► PREPARING (invisible to the desktop app while it works), then
 * returns to READY with the tailored resume — or to RESUME_REVIEW.
 *
 * RESUME_REVIEW is the AI stage's human gate. The fabrication check found a
 * claim it could not trace back to the base resume, so the item waits on a
 * person instead of going out. It is NOT a failure state — a failure attaches
 * the base resume and continues to READY. This is specifically "a human should
 * look at this before it is sent in someone's name".
 */

export const QUEUE_STATES = {
    QUEUED: 'QUEUED',
    PREPARING: 'PREPARING',
    RESUME_REVIEW: 'RESUME_REVIEW',
    READY: 'READY',
    FILLING: 'FILLING',
    PARKED_UNKNOWN: 'PARKED_UNKNOWN',
    AWAITING_REVIEW: 'AWAITING_REVIEW',
    SUBMITTED: 'SUBMITTED',
    SKIPPED: 'SKIPPED',
    CANCELLED: 'CANCELLED',
};

/** States from which nothing further happens. */
export const TERMINAL = new Set(['SUBMITTED', 'CANCELLED']);

/**
 * Cancellation is reachable from every live state, because it answers a
 * question none of the others do: the consultant left, or an admin pulled the
 * queue. It is deliberately NOT reachable from SUBMITTED — an application that
 * reached an employer cannot be un-sent, and pretending otherwise would put a
 * lie in the permanent record.
 */
const CANCELLABLE = ['QUEUED', 'PREPARING', 'RESUME_REVIEW', 'READY', 'FILLING',
    'PARKED_UNKNOWN', 'AWAITING_REVIEW', 'SKIPPED'];

const TRANSITIONS = {
    // Straight to READY is the normal path now: nothing is tailored unless a
    // person asks. PREPARING from here remains legal for the retry sweeps.
    QUEUED: ['READY', 'PREPARING', 'SKIPPED'],

    // Back to QUEUED is the retry path: preparation failed, try again next
    // sweep. Straight to READY is the fallback after too many failures — the
    // base resume is attached and the job goes on rather than being lost to an
    // AI outage.
    PREPARING: ['READY', 'RESUME_REVIEW', 'QUEUED', 'SKIPPED'],

    // The fabrication gate. Every way out of it is a decision somebody made:
    //   READY      a reviewer accepted the tailored resume
    //   PREPARING  a reviewer asked for another attempt
    //   QUEUED     the review expired and it goes round again
    //   SKIPPED    the job was declined while it sat here
    // There is deliberately no path to FILLING: nothing may be applied to
    // straight out of review without passing through READY, which is the state
    // the desktop app and the cap both key on.
    RESUME_REVIEW: ['READY', 'PREPARING', 'QUEUED', 'SKIPPED'],

    // FILLING is the desktop app taking it. SUBMITTED direct from READY is the
    // HUMAN lane: nothing filled the form, the consultant applied themselves
    // and reported it.
    //
    // PREPARING is a person asking for this job's resume to be tailored. It is
    // only reachable while the item is READY — once the desktop app has taken
    // it (FILLING) the application is already in progress with whichever
    // resume it was given.
    READY: ['FILLING', 'SUBMITTED', 'SKIPPED', 'PREPARING'],

    // Back to READY covers two real cases: an expired lease from a crashed app,
    // and a LinkedIn job that turned out not to be Easy Apply and was
    // reclassified to the HUMAN lane.
    FILLING: ['AWAITING_REVIEW', 'PARKED_UNKNOWN', 'READY', 'SKIPPED'],

    // The loop back to the answer bank. Approving the missing answer releases
    // every item waiting on that question.
    PARKED_UNKNOWN: ['READY', 'SKIPPED'],

    // Back to READY is the review expiry: a filled application nobody looked at
    // releases its cap slot rather than holding one forever.
    AWAITING_REVIEW: ['SUBMITTED', 'READY', 'SKIPPED'],

    SUBMITTED: [],
    SKIPPED: ['QUEUED'],
    CANCELLED: [],
};

for (const from of CANCELLABLE) TRANSITIONS[from].push('CANCELLED');

/** States that require a reason on arrival — refused without one. */
export const REASON_REQUIRED = new Set(['SKIPPED', 'CANCELLED', 'PARKED_UNKNOWN']);


export const isTerminal = (state) => TERMINAL.has(state);

export const allowedFrom = (state) => TRANSITIONS[state] ?? [];

export const canTransition = (from, to) => allowedFrom(from).includes(to);

/**
 * Check one move.
 *
 * Returns a shape rather than throwing, so a caller can decide between a 409
 * and a 422 without catching and re-inspecting an error. `ok: true` means the
 * write may proceed.
 */
export const checkTransition = (from, to, { reason } = {}) => {
    if (!Object.hasOwn(TRANSITIONS, to)) {
        return { ok: false, status: 400, error: `Unknown queue state "${to}".` };
    }
    if (from === to) {
        return { ok: false, status: 409, error: `The item is already ${to}.` };
    }
    if (isTerminal(from)) {
        return {
            ok: false,
            status: 409,
            error: `${from} is final — the item cannot move to ${to}.`,
        };
    }
    if (!canTransition(from, to)) {
        return {
            ok: false,
            status: 409,
            error: `Cannot move a queue item from ${from} to ${to}. `
                + `Allowed from ${from}: ${allowedFrom(from).join(', ') || 'nothing'}.`,
        };
    }
    if (REASON_REQUIRED.has(to) && !String(reason ?? '').trim()) {
        return { ok: false, status: 422, error: `A reason is required to mark an item ${to}.` };
    }
    return { ok: true };
};

export const __test = { TRANSITIONS };
