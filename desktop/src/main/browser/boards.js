/**
 * ── THE BOARD REGISTRY ────────────────────────────────────────────────
 *
 * One entry per board the app knows how to sign into. Deliberately DATA, not
 * code paths: adding TheLadders later is a row here plus a recipe file, never a
 * change to the engine.
 *
 * Each board answers three questions:
 *
 *   where does a human go to sign in?
 *   how do we tell, from a loaded page, that we are signed in?
 *   what does this board's bot-check look like?
 *
 * ── THE SELECTORS ARE PLACEHOLDERS AND SAY SO ─────────────────────────
 *
 * These are written from publicly known page structure and have NOT been
 * verified against a live signed-in session — that needs real accounts and real
 * markup. The engine around them is built and tested against a synthetic page,
 * so when the real selectors arrive they are the only thing that changes.
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
        // Signed-in pages carry an account menu; the login form carries a
        // password field. Two signals, because either alone gives false
        // positives on interstitials.
        signedIn: { present: ['[data-test="AccountMenu"]'], absent: ['input[type="password"]'] },
        botCheck: ['#challenge-running'],
        verified: false,
    },
    BUILTIN: {
        name: 'BUILTIN',
        label: 'Built In',
        loginUrl: 'https://builtin.com/user/login',
        signedIn: { present: ['a[href*="/user/logout"]'], absent: ['input[name="pass"]'] },
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
        signedIn: { present: ['#global-nav'], absent: ['input#password'] },
        // R-22: any of these stops LinkedIn for the rest of the day.
        botCheck: ['#captcha-internal'],
        verified: false,
        // R-22's "lowest volume". The engine caps LinkedIn separately from, and
        // inside, the consultant's overall daily cap.
        maxPerCycle: 2,
    },
};

/** Which board a portal name belongs to, or null when we do not handle it. */
const boardForPortal = (portal) => BOARDS[portal] ?? null;

module.exports = { BOARDS, boardForPortal };
