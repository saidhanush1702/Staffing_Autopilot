import {
    CheckCircle2, Clock, TriangleAlert, XCircle, Eye, CircleSlash, Inbox, Sparkles, RefreshCw,
} from 'lucide-react';

/**
 * How each state the live mirror reports should read at a glance.
 *
 * These are the mirror's own vocabularies — board status, job state, poll
 * outcome — which have no `lkp_` table, so they live here, once, rather than
 * being re-spelled in every table that shows one. (Career-system NAMES are
 * different: those come from the `atsFamilies` lookup, never from this file.)
 *
 * The recurring decision is which states are NEUTRAL. "No change" and "Already
 * had it" are the mirror working as intended — most polls change nothing, and
 * most jobs it sees another source already found. Painting them as warnings
 * would make a healthy system look sick and invite someone to "fix" it.
 */

export const BOARD_STATUS = {
    PENDING: { tone: 'info', label: 'Waiting for first read', icon: Clock },
    ACTIVE: { tone: 'success', label: 'Watching', icon: CheckCircle2 },
    FAILING: { tone: 'warning', label: 'Having trouble', icon: TriangleAlert },
    NOT_FOUND: { tone: 'danger', label: 'Board is gone', icon: CircleSlash },
};

export const JOB_STATE = {
    OBSERVED: { tone: 'info', label: 'Noticed', icon: Eye },
    INGESTED: { tone: 'success', label: 'Added to pool', icon: Sparkles },
    DUPLICATE: { tone: 'neutral', label: 'Already had it', icon: Inbox },
    DETECTED: { tone: 'warning', label: 'Waiting to be added', icon: Clock },
    FAILED: { tone: 'danger', label: 'Failed', icon: XCircle },
    BASELINE: { tone: 'neutral', label: 'Already open', icon: Inbox },
};

export const RUN_OUTCOME = {
    OK: { tone: 'success', label: 'Read', icon: CheckCircle2 },
    BASELINED: { tone: 'brand', label: 'First read', icon: Sparkles },
    NOT_MODIFIED: { tone: 'neutral', label: 'No change', icon: RefreshCw },
    NOT_FOUND: { tone: 'danger', label: 'Not found', icon: CircleSlash },
    ERROR: { tone: 'danger', label: 'Error', icon: XCircle },
};

/** The polling band a board has settled into. Only the tone is a choice. */
export const TIER_TONE = { HOT: 'brand', WARM: 'info', COOL: 'neutral', COLD: 'neutral' };

export const MODES = {
    OBSERVE: {
        label: 'Observe',
        blurb: 'Boards are read and new jobs are noticed and timed, but nothing is added to the pool, '
            + 'no consultant is queued and no AI preparation is bought.',
    },
    LIVE: {
        label: 'Live',
        blurb: 'New jobs go through the full pipeline: de-duplication, matching, the consultants\' queues '
            + 'and AI resume preparation.',
    },
};
