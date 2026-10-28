/**
 * ── CAN THIS PERSON LEGALLY AND CONTRACTUALLY TAKE THIS JOB? ──────────
 *
 * The matcher asked whether a job SUITED a consultant. It never asked whether
 * they were ALLOWED to take it, which on a US staffing bench rules out more jobs
 * than geography does: "US citizens only", "no sponsorship", "W2 only, no C2C".
 * A recruiter finds out after the application has gone, from an employer.
 *
 * ── TWO KINDS OF "NO" ─────────────────────────────────────────────────
 *
 *   DROP   the posting says something explicit that this consultant cannot
 *          satisfy: citizens only and they are not one, W2 only and they accept
 *          only C2C, pay stated below their floor. Not worth anyone's time.
 *
 *   CAP    something worth a person's eye but not a certainty: "no sponsorship"
 *          against an H-1B consultant (a transfer is sometimes fine), a
 *          clearance requirement for a citizen (is theirs active?), "no third
 *          parties". Kept out of the automatic queue and offered to a recruiter
 *          as a suggestion, with the reason.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────
 *
 * It does not guess a consultant's status. A consultant with none recorded is
 * never blocked on authorization; the reason says it could not be checked.
 * Wording it does not recognise blocks nothing: unfamiliar phrasing lowers
 * nothing, because a rule that fires on a misreading costs a consultant a job.
 */

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ');

/** A statement that the employer is open to everyone. Overrides every restriction. */
const OPEN_TO_ALL = /\b(all visa types|any (valid )?(work )?(authorization|visa)|h-?1b\s*(ok|accepted|welcome|transfer|friendly)|(opt|cpt|ead|gc[- ]ead|tn)\s*(ok|accepted|welcome|friendly)|visa sponsorship (is )?(available|provided|offered)|will sponsor|we sponsor|open to (all|any) (work )?(authorization|visa))\b/;

const CITIZEN_ONLY = /\b((u\.?s\.?|american)\s+citizens?\s+(only|required)|must be (a )?(u\.?s\.?\s+)?citizens?|citizenship (is )?required|only (u\.?s\.?\s+)?citizens?|usc\s+only|u\.?s\.?\s+citizens? (are )?(eligible|only))\b/;
const CITIZEN_OR_GC = /\b((u\.?s\.?\s+)?citizens?\s+(or|and|\/)\s+(green card|gc|permanent resident|lawful permanent)|(green card|gc|permanent resident)s?\s+(or|and|\/)\s+(u\.?s\.?\s+)?citizens?|gc\s*\/\s*usc|usc\s*\/\s*gc|gc or usc|usc or gc|citizens? and permanent residents?)\b/;
const NO_SPONSORSHIP = /\b(no (visa )?sponsorship|unable to (provide )?(visa )?sponsor(ship)?|will not (provide |offer )?(visa )?sponsor(ship)?|(does not|do not|cannot|can't|won't|will not) (offer |provide |support )?(visa )?sponsor(ship)?|without (visa )?sponsorship|sponsorship (is )?not (available|offered|provided)|not (able )?to sponsor)\b/;
const CLEARANCE = /\b(ts\/sci|top secret|secret clearance|security clearance|active (secret|clearance|ts)|dod clearance|public trust|polygraph)\b/;

const NO_C2C = /\b(no (c2c|corp[- ]to[- ]corp)|(c2c|corp[- ]to[- ]corp) (is )?not (accepted|allowed|available|considered)|w-?2 (only|required)|must (work|be) (on )?(our )?w-?2|w-?2 employees? only)\b/;
const C2C_ONLY = /\b((c2c|corp[- ]to[- ]corp) only|only (c2c|corp[- ]to[- ]corp))\b/;
const NO_THIRD_PARTY = /\b(no (third[- ]party|3rd[- ]party|agencies|agency|recruiters|vendors)|(third[- ]party|3rd[- ]party|agencies|vendors) (are )?not (accepted|allowed|considered)|direct (client|hire|employees?) only|(do not|don't) (accept|work with) (third[- ]party|agencies|vendors))\b/;

/** What the posting asks of the applicant, as far as its own words say. */
export const requirementsOf = (posting) => {
    const text = norm(`${posting.title ?? ''} ${posting.description ?? ''}`);
    const open = OPEN_TO_ALL.test(text);

    let citizenship = null;
    if (!open) {
        // The wider "citizen or green card" is tested first: "GC/USC only" would
        // otherwise be read as "USC only" and drop every green card holder.
        if (CITIZEN_OR_GC.test(text)) citizenship = 'CITIZEN_OR_GC';
        else if (CITIZEN_ONLY.test(text)) citizenship = 'CITIZEN_ONLY';
        else if (NO_SPONSORSHIP.test(text)) citizenship = 'NO_SPONSORSHIP';
    }
    return {
        citizenship,
        clearance: !open && CLEARANCE.test(text),
        noC2C: NO_C2C.test(text),
        c2cOnly: C2C_ONLY.test(text),
        noThirdParty: NO_THIRD_PARTY.test(text),
        openToAll: open,
    };
};

/** A consultant's recorded status as a class, or null when none is recorded. */
export const statusClass = (workAuth) => {
    const s = norm(workAuth);
    if (!s) return null;
    if (/citizen/.test(s)) return 'CITIZEN';
    if (/green card|permanent resident|\bgc\b/.test(s)) return 'GC';
    return 'VISA'; // H-1B, OPT, CPT, TN, Other: all need an employer behind them
};

/**
 * @param posting  { title, description, payMin, payMax, payUnit }
 * @param criteria { workAuth, workTypeNames, minPay }
 * @returns {{ verdict: 'OK'|'DROP'|'CAP', reasons: string[] }}
 */
export const eligibility = (posting, criteria) => {
    const need = requirementsOf(posting);
    const mine = statusClass(criteria.workAuth);
    const drops = [];
    const caps = [];

    /* ── work authorization ─────────────────────────────────────── */
    if (mine === null) {
        if (need.citizenship) caps.push(`job says ${label(need.citizenship)}; consultant's status is not recorded`);
    } else if (need.citizenship === 'CITIZEN_ONLY' && mine !== 'CITIZEN') {
        drops.push(`job requires a US citizen; consultant is ${criteria.workAuth}`);
    } else if (need.citizenship === 'CITIZEN_OR_GC' && mine === 'VISA') {
        drops.push(`job requires a citizen or green card holder; consultant is ${criteria.workAuth}`);
    } else if (need.citizenship === 'NO_SPONSORSHIP' && mine === 'VISA') {
        // A transfer is sometimes accepted; that is a person's call.
        caps.push(`job offers no sponsorship; consultant is ${criteria.workAuth}`);
    }

    if (need.clearance) {
        if (mine !== null && mine !== 'CITIZEN') drops.push('job requires a security clearance; consultant is not a US citizen');
        else caps.push('job requires a security clearance — confirm theirs is active');
    }

    /* ── how they are engaged ───────────────────────────────────── */
    const accepts = new Set(criteria.workTypeNames ?? []);
    if (accepts.size > 0) {
        if (need.noC2C && [...accepts].every((t) => t === 'C2C')) {
            drops.push('job is W2 only; consultant accepts C2C only');
        }
        if (need.c2cOnly && !accepts.has('C2C')) {
            drops.push('job is C2C only; consultant does not accept C2C');
        }
    }
    if (need.noThirdParty) caps.push('job says no third parties or agencies');

    /* ── pay ────────────────────────────────────────────────────── */
    const floor = criteria.minPay;
    if (floor?.amount != null && posting.payUnit && posting.payUnit === floor.unit) {
        const offered = posting.payMax ?? posting.payMin;
        if (offered != null && Number(offered) < Number(floor.amount)) {
            drops.push(`pay ${offered} is below their minimum of ${floor.amount} ${floor.unit.toLowerCase()}`);
        }
    }

    if (drops.length) return { verdict: 'DROP', reasons: drops };
    if (caps.length) return { verdict: 'CAP', reasons: caps };
    return { verdict: 'OK', reasons: [] };
};

const label = (c) => ({
    CITIZEN_ONLY: 'US citizens only',
    CITIZEN_OR_GC: 'citizens or green card holders',
    NO_SPONSORSHIP: 'no sponsorship',
}[c] ?? c);
