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
 *   QUEUED ──► PREPARING ──► READY ──► FILLING ──► AWAITING_REVIEW ──► SUBMITTED
 *      │           │           ▲          │               │
 *      │           └───────────┘          └──► PARKED_UNKNOWN
 *      │        (retry / release)                    │
 *      │                                            ─┘  (answer approved)
 *      └──► SKIPPED ──► QUEUED        CANCELLED reachable from anywhere live
 */

export const QUEUE_STATES = {
    QUEUED: 'QUEUED',
    PREPARING: 'PREPARING',
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
const CANCELLABLE = ['QUEUED', 'PREPARING', 'READY', 'FILLING',
    'PARKED_UNKNOWN', 'AWAITING_REVIEW', 'SKIPPED'];

const TRANSITIONS = {
    QUEUED: ['PREPARING', 'SKIPPED'],

    // Back to QUEUED is the retry path: preparation failed, try again next
    // sweep. Straight to READY is the fallback after too many failures — the
    // base resume is attached and the job goes on rather than being lost to an
    // AI outage.
    PREPARING: ['READY', 'QUEUED', 'SKIPPED'],

    // FILLING is the desktop app taking it. SUBMITTED direct from READY is the
    // HUMAN lane: nothing filled the form, the consultant applied themselves
    // and reported it.
    READY: ['FILLING', 'SUBMITTED', 'SKIPPED'],

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

/** Only these hold a daily cap slot. See `countsAgainstCap`. */
const HOLDS_A_SLOT = new Set([
    'READY', 'FILLING', 'PARKED_UNKNOWN', 'AWAITING_REVIEW', 'SUBMITTED',
]);

/**
 * Whether an item in this state is using one of the consultant's daily slots.
 *
 * A slot is taken on reaching READY, not on being queued. The difference
 * matters: the discovery cycle creates items before the preparation stage has
 * run, so counting at creation would let a failed tailoring burn a
 * consultant's whole day without a single application going out.
 *
 * SKIPPED and CANCELLED release the slot; SUBMITTED keeps it, because it was
 * genuinely spent.
 */
export const countsAgainstCap = (state) => HOLDS_A_SLOT.has(state);

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

export const __test = { TRANSITIONS, HOLDS_A_SLOT };
