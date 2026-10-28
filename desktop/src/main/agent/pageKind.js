/**
 * ── WHAT KIND OF PAGE IS THIS? ────────────────────────────────────────
 *
 * A cheap, deterministic answer to the question the model would otherwise be
 * asked on every turn — and, for a few kinds, an answer the model must not be
 * trusted with at all.
 *
 *   CHALLENGE     a CAPTCHA or bot check. A person's, never the model's.
 *   EMAIL_VERIFY  "enter the code we emailed you". Only the person can read
 *                 their inbox.
 *   CLOSED        the posting is shut. No model call is worth making.
 *   LOGIN         a password is being asked for.
 *   CONFIRMATION  the application has been received.
 *   ERROR         an error page with nothing to fill.
 *   JOB_PAGE      a posting with an apply control and no form yet.
 *   REVIEW        a form whose submit control is showing.
 *   FORM_STEP     fields to fill, with more to come.
 *   UNKNOWN       none of the above; the model reads it.
 *
 * ── WORDS, NOT SELECTORS ──────────────────────────────────────────────
 *
 * The input is the observation the agent already builds — the page's own
 * headings, errors, fields and controls, in its own words — so this works on a
 * site nothing is coded for. Ordered from the kinds that must win (a challenge
 * outranks everything) to the ones that are a fallback.
 *
 * Wrong in the safe direction by construction: every kind that makes the app
 * STOP is conservative, and UNKNOWN simply hands the page to the model as
 * before.
 */

const CLOSED = /no longer (accepting|available)|not (currently )?accepting applications|applications? (are |is )?closed|position (has been |is )?filled|job (was |has been )?removed|this job is (closed|expired)|posting (has )?expired/i;

const EMAIL_VERIFY = /(verification|security|confirmation|one[- ]time|login|sign[- ]in) (code|passcode|pin)|verify your (email|e-mail|account|identity)|enter the (\d+[- ]digit )?code|code (we|was|has been) (sent|emailed)|check your (email|inbox)|we(?:'|’)ve sent (you )?(an? )?(email|code)/i;

const CONFIRMED = /thank you for (applying|your application|submitting)|application (has been |was )?(submitted|received|sent)|we(?:'|’)ve received your application|your application (is|was) (complete|received|sent)/i;

const ERROR_PAGE = /\b(404|page not found|access denied|forbidden|something went wrong|service unavailable|bad gateway|temporarily unavailable)\b/i;

/** A control that sends the application. */
const SUBMITTISH = /^\s*(submit( application)?|send( my)? application|apply now|finish|complete application)\s*$/i;

/** A control that moves a form forward. */
const NEXTISH = /^\s*(next|continue|save (and|&) continue|save and next|proceed|review)\b/i;

/** A control that opens an application. */
const APPLYISH = /\b(apply|start (your )?application|easy apply|apply (now|manually|on))\b/i;

const wordsOf = (o) => [
    o.title, ...(o.headings ?? []), ...(o.errors ?? []), o.text,
].filter(Boolean).join(' \n ');

/**
 * @param observation  as built by observe.js
 * @returns one of the kinds above
 */
const classifyPage = (observation = {}) => {
    const words = wordsOf(observation);
    const fields = observation.fields ?? [];
    const controls = observation.controls ?? [];
    const names = controls.map((c) => String(c.text ?? ''));

    // A posting's body can say anything ("we are not accepting applications from
    // agencies"), so "closed" is believed only from the page's own headline,
    // headings and error banners, never from its running text.
    const banner = [observation.title, ...(observation.headings ?? []), ...(observation.errors ?? [])]
        .filter(Boolean).join(' | ');

    if (observation.challenge) return 'CHALLENGE';
    // A verification page is nearly empty: a code box and a button. A long form
    // that merely mentions a code is not one.
    if (fields.length <= 3 && EMAIL_VERIFY.test(words)) return 'EMAIL_VERIFY';
    if (CLOSED.test(banner) && !names.some((n) => SUBMITTISH.test(n))) return 'CLOSED';
    if (observation.passwordField) return 'LOGIN';
    if (CONFIRMED.test(words) && fields.length === 0) return 'CONFIRMATION';
    if (fields.length === 0 && ERROR_PAGE.test(`${observation.title ?? ''} ${(observation.headings ?? []).join(' ')}`)) {
        return 'ERROR';
    }

    const hasSubmit = names.some((n) => SUBMITTISH.test(n));
    const hasNext = names.some((n) => NEXTISH.test(n));
    if (fields.length > 0) return hasSubmit && !hasNext ? 'REVIEW' : 'FORM_STEP';
    if (names.some((n) => APPLYISH.test(n))) return 'JOB_PAGE';
    return 'UNKNOWN';
};

module.exports = {
    classifyPage, CLOSED, EMAIL_VERIFY, CONFIRMED, ERROR_PAGE,
};
