import { Sparkles, MinusCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { badge, TONE } from '../../design/tokens.js';

/**
 * ── DID THIS APPLICATION GO OUT WITH A TAILORED RESUME? ───────────────
 *
 * One badge, four states, rendered identically in the management queue, the
 * queue drawer and the consultant's own portal.
 *
 * ── WHY THE "NO" STATE IS SHOWN AT ALL ────────────────────────────────
 *
 * Because the pipeline is allowed to skip. There is no daily cap and no
 * blocking failure path: a missing base resume, an exhausted budget, a legacy
 * `.doc` nobody can parse, or a provider having a bad afternoon each end with
 * the application going out anyway, carrying the consultant's base resume.
 *
 * That is the right behaviour — an untailored application beats no application
 * — but it is only the right behaviour if it is VISIBLE. Silently sending the
 * base resume while the product promises tailoring is how a client discovers
 * the ceiling by noticing results got worse. So the grey badge is not an error
 * message; it is the feature working, in the open, with its reason attached.
 *
 * ── WHY THE REASON IS IN THE BADGE AND NOT A TOOLTIP ONLY ─────────────
 *
 * "Not tailored" prompts the question "why not", and the four answers lead to
 * four different actions — top up the budget, chase a re-upload, wait, or look
 * at the logs. A tooltip hides that behind a hover nobody performs on a phone.
 */

const STATES = {
    TAILORED: {
        tone: 'success',
        icon: Sparkles,
        label: 'Tailored',
        title: 'This application went out with a resume rewritten for this job.',
    },
    PENDING: {
        tone: 'neutral',
        icon: Loader2,
        label: 'Preparing',
        title: 'The tailored resume is still being prepared.',
    },
    FLAGGED: {
        tone: 'warning',
        icon: AlertTriangle,
        label: 'Needs review',
        title: 'The checker found claims it could not trace back to the base resume.',
    },
    NOT_TAILORED: {
        tone: 'neutral',
        icon: MinusCircle,
        label: 'Not tailored',
        title: 'This application went out with the base resume.',
    },
};

/**
 * Skip reasons, in the words of the person who has to do something about it.
 *
 * The database stores a constant; a recruiter needs a sentence. Kept here
 * rather than in each screen so the four answers cannot drift apart.
 */
export const SKIP_REASONS = {
    BUDGET_EXHAUSTED: "this month's AI budget is used up",
    NO_BASE_RESUME: 'no base resume on file',
    UNPARSEABLE_RESUME: 'the base resume could not be read',
    AI_FAILED: 'the AI stage did not complete',
};

const TailoringBadge = ({ state, reason, className = '' }) => {
    const spec = STATES[state];
    // An item from before this feature existed has no state at all. Showing
    // nothing is honest; showing "Not tailored" would claim a decision that was
    // never made.
    if (!spec) return null;

    const { tone, icon: Icon, label, title } = spec;
    const explained = state === 'NOT_TAILORED' && SKIP_REASONS[reason];

    return (
        <span
            className={`${badge} ${TONE[tone]} ${className}`}
            title={explained ? `${title} Reason: ${SKIP_REASONS[reason]}.` : title}
        >
            <Icon className={`h-3 w-3 shrink-0 ${state === 'PENDING' ? 'animate-spin' : ''}`} />
            {explained ? `Not tailored — ${SKIP_REASONS[reason]}` : label}
        </span>
    );
};

export default TailoringBadge;
