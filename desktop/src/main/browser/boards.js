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
        // ── MEASURED AGAINST A LIVE EASY APPLY, NOT GUESSED ──────────
        //
        // The first version of this was written from public knowledge and was
        // wrong in every particular. What is here now was read off a real
        // application flow:
        //
        //   · Easy Apply does NOT open a dialog. It replaces the page with a
        //     five-step flow ("1/5 pages", starting at Contact info). Every
        //     modal selector — [role="dialog"], .artdeco-modal,
        //     .jobs-easy-apply-modal — matched nothing.
        //   · LinkedIn's class names are build-hashed and change between page
        //     loads: the same button was `.jobs-apply-button` on one load and
        //     `.b0d4b002._98bfa880…` on the next. NOTHING here may key off a
        //     class. aria-label, visible text and data- attributes only.
        //   · `data-sdui-screen` is the container, and it holds exactly the
        //     application's own fields — the page's search box and language
        //     picker stay outside it. That is what makes scoping possible at
        //     all, since the flow has no <form> element.
        //   · The Next button carries no aria-label. Its text is all there is.
        //
        // `submit` is still unproven: reaching page 5 to see it means walking a
        // real application to its end. It is written to be RECOGNISED so the
        // flow stops there, and `isSubmit` in applyFlow.js catches it by text
        // regardless of whether this selector is right.
        apply: {
            open: 'button[aria-label*="Easy Apply" i]',
            dialog: '[data-sdui-screen*="jobs.easy"]',
            next: 'button:has-text("Next"), button:has-text("Review"), '
                + 'button:has-text("Continue")',
            submit: 'button:has-text("Submit application"), '
                + 'button[aria-label*="Submit application" i]',
            // No `resumeUpload` selector on purpose. One flow's step said
            // "Upload resume" and had no file input at all — only a button
            // opening the OS chooser — but the wording differs per employer,
            // so applyFlow finds the control by what it SAYS. Set this only if
            // some board turns out to need naming explicitly.
            alreadyApplied: 'button:has-text("Continue applying")',
            maxSteps: 8,
        },
        // ── NO PER-BOARD VOLUME LIMIT ────────────────────────────────
        //
        // LinkedIn used to carry a ceiling of five applications a day, from
        // R-22's "lowest volume". The owner removed it: every job that reaches
        // the queue is applied to, on every board.
        //
        // What remains is the half that reacts rather than rations — a bot
        // check below stops this board for the rest of the day. That is not a
        // quota, it is the board saying it has noticed, and ignoring that is
        // how a temporary challenge becomes a blocked account.
        botCheck: ['#captcha-internal'],
        // ── SWITCHED ON BY THE OWNER, ON PARTIAL EVIDENCE ────────────
        //
        // The session selectors here were measured against a live account. The
        // apply flow was measured against ONE job, and reached page 1 of 5
        // before a required screening question stopped it. Nothing has yet
        // watched this fill a LinkedIn application to the end.
        //
        // So this is on because the owner asked for it, not because the recipe
        // has been proven. What that costs if a selector is wrong is bounded:
        // the filler types only into fields it can name, leaves anything
        // pre-filled alone, and refuses to press submit — a bad guess produces
        // a parked or handed-over item, not a wrong application.
        //
        // Set back to false to stop it typing on LinkedIn entirely.
        verified: true,
    },
};

/** Which board a portal name belongs to, or null when we do not handle it. */
const boardForPortal = (portal) => BOARDS[portal] ?? null;

module.exports = { BOARDS, boardForPortal };
