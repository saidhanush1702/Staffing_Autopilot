/**
 * ── THE BOARD REGISTRY ────────────────────────────────────────────────
 *
 * One entry per board the app knows how to sign into. Deliberately DATA, not
 * code paths: adding TheLadders later is a row here plus a recipe file, never a
 * change to the engine.
 *
 * Each board answers four questions:
 *
 *   where does a human go to sign in?
 *   which page proves whether a session is live?
 *   how do we tell, from that page, that we are signed in?
 *   what does this board's bot-check look like?
 *
 * ── THE SESSION CHECKS ARE MEASURED; THE FORMS ARE NOT ────────────────
 *
 * `sessionProbeUrl` and `signedIn` below were checked against real signed-in
 * sessions with `npm run probe:selectors`, and the values here are what was
 * actually observed. The first set of guesses was wrong on all three boards,
 * which is why nothing in this file is trusted until it has been seen working.
 *
 * The APPLICATION FORMS have had no such check. Nobody has watched this app
 * fill a real employer's form on any of these boards, so every recipe stays
 * `verified: false` and the engine will not type into them.
 *
 * `verified: false` is load-bearing: the cycle engine refuses to FILL on a board
 * whose recipe is unverified, and only ever opens and classifies. A wrong guess
 * therefore cannot type into a real employer's form.
 */

const BOARDS = {
    WELLFOUND: {
        name: 'WELLFOUND',
        label: 'Wellfound',
        loginUrl: 'https://wellfound.com/login',
        // Observed: a live session asking for /login lands on /jobs instead, so
        // the redirect carries the answer. `[data-test="AccountMenu"]` was the
        // original guess and matches nothing.
        sessionProbeUrl: 'https://wellfound.com/jobs',
        signedIn: { present: [], absent: ['input[type="password"]'] },
        botCheck: ['#challenge-running'],
        verified: false,
    },
    BUILTIN: {
        name: 'BUILTIN',
        label: 'Built In',
        loginUrl: 'https://builtin.com/user/login',
        // Built In does NOT redirect a signed-in visitor away from its login
        // page, so the bounce test alone cannot answer for it — hence a
        // selector, and hence one that was actually observed matching. The
        // original guess had `/user/` in the path; the real link does not.
        sessionProbeUrl: 'https://builtin.com/',
        signedIn: { present: ['a[href*="logout"]'], absent: [] },
        botCheck: [],
        verified: false,
    },
    CRUNCHBOARD: {
        name: 'CRUNCHBOARD',
        label: 'CrunchBoard',
        loginUrl: 'https://www.crunchboard.com/',
        // CrunchBoard mostly redirects to the employer, so there is often no
        // session to hold at all. Treated as always-signed-in so the engine
        // opens the job and classifies rather than blocking on a login it will
        // never need.
        signedIn: { present: [], absent: [] },
        botCheck: [],
        verified: false,
    },
    LINKEDIN: {
        name: 'LINKEDIN',
        label: 'LinkedIn',
        loginUrl: 'https://www.linkedin.com/login',
        // Observed: signed in, /feed/ loads; signed out, LinkedIn bounces to
        // /login or /authwall, both of which the bounce test recognises.
        // `#global-nav` was the original guess and matches nothing.
        sessionProbeUrl: 'https://www.linkedin.com/feed/',
        signedIn: { present: [], absent: ['input#password'] },
        // ── EASY APPLY ───────────────────────────────────────────────
        //
        // The application is not on the job page. It opens in a dialog and
        // pages through contact details, resume, screening questions and a
        // review before offering Submit.
        //
        // `submit` is listed so the flow can RECOGNISE it and stop there.
        // Nothing in the work loop clicks it — only the consultant, from the
        // app, after reading what was filled in.
        //
        // These selectors have NOT been checked against a live Easy Apply
        // dialog. That is exactly what `verified` guards, and why it is still
        // false: the last set of selectors written this way was wrong on all
        // three boards.
        apply: {
            open: 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]',
            dialog: '[role="dialog"]',
            next: 'button[aria-label="Continue to next step"], '
                + 'button[aria-label="Review your application"]',
            submit: 'button[aria-label="Submit application"]',
            alreadyApplied: '.jobs-s-apply--applied',
            maxSteps: 8,
        },
        // ── EASY APPLY ───────────────────────────────────────────────
        //
        // The application is not on the job page. It opens in a dialog and
        // pages through contact details, resume, screening questions and a
        // review before offering Submit.
        //
        // `submit` is here so the flow can RECOGNISE it and stop. Nothing in
        // the work loop clicks it — only the consultant, from the app.
        //
        // These selectors have NOT been checked against a live Easy Apply
        // dialog. That is what `verified` guards, and why it stays false.
        apply: {
            open: 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]',
            dialog: '[role="dialog"]',
            next: 'button[aria-label="Continue to next step"], '
                + 'button[aria-label="Review your application"]',
            submit: 'button[aria-label="Submit application"]',
            submitted: '[role="dialog"] :text("Your application was sent")',
            alreadyApplied: '.jobs-s-apply--applied, :text("Applied")',
            maxSteps: 8,
        },
        // R-22: any of these stops LinkedIn for the rest of the day.
        botCheck: ['#captcha-internal'],
        verified: false,
        // R-22's "lowest volume". Counted per DAY, not per pass: the app works
        // continuously whenever the queue has something in it, so a per-pass
        // ceiling would simply repeat every poll. The engine applies this
        // inside the consultant's overall daily cap, never alongside it.
        maxPerDay: 5,
    },
};

/** Which board a portal name belongs to, or null when we do not handle it. */
const boardForPortal = (portal) => BOARDS[portal] ?? null;

module.exports = { BOARDS, boardForPortal };
